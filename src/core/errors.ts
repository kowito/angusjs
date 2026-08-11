/**
 * The error contract.
 *
 * One taxonomy, translated once at the edge, consumed by every surface: REST
 * clients read `error`/`code`, the admin renders `errors` beside the offending
 * field, MCP turns the whole body into a tool error, and a generated client can
 * branch on `code` rather than matching on a message.
 *
 * A handler never builds an error body. It throws, and this decides the shape.
 */

import { Elysia } from 'elysia'
import { classifyIntegrityError, constraintField, DoesNotExist, MultipleObjectsReturned } from '../db/errors.ts'
import { APIError, NotFound, ServerError, type ErrorBody } from '../http/errors.ts'
import { ValidationError } from '../serializers/index.ts'

/**
 * Stable machine-readable codes. Clients branch on these; the human-readable
 * `detail` is free to change wording without breaking anyone.
 */
export const ERROR_CODES = {
  /** The request body or parameters didn't match the schema. */
  validation: 'validation_error',
  /** Malformed request that isn't a schema failure. */
  badRequest: 'bad_request',
  /** No credentials, or credentials that no longer resolve. */
  unauthenticated: 'unauthenticated',
  /** Authenticated, but not allowed to do this. */
  forbidden: 'forbidden',
  /** No such resource — or one outside the caller's queryset. */
  notFound: 'not_found',
  /** Conflicts with current state: a duplicate, a stale write. */
  conflict: 'conflict',
  /** Rate limited. */
  throttled: 'throttled',
  /** Anything unhandled. */
  server: 'server_error',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** The canonical code for a status, used when an error doesn't name its own. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ERROR_CODES.badRequest
    case 401:
      return ERROR_CODES.unauthenticated
    case 403:
      return ERROR_CODES.forbidden
    case 404:
      return ERROR_CODES.notFound
    case 409:
      return ERROR_CODES.conflict
    case 422:
      return ERROR_CODES.validation
    case 429:
      return ERROR_CODES.throttled
    default:
      return status >= 500 ? ERROR_CODES.server : ERROR_CODES.badRequest
  }
}

/** Wording aimed at whoever submitted the request, not at whoever wrote the schema. */
const INTEGRITY_MESSAGES: Record<string, string> = {
  unique: 'That value is already taken.',
  'foreign-key': 'That related record does not exist.',
  'not-null': 'A required value was missing.',
  check: 'That value is not allowed.',
}

export interface ErrorTranslationOptions {
  debug?: boolean
}

/**
 * Translates thrown values into JSON error responses.
 *
 * The whole error story of the framework is this function: a view can throw
 * `NotFound`, let `DoesNotExist` bubble up from `.get()`, or let a serializer
 * reject a payload, and all three arrive as the right status and shape.
 */
export function errorTranslation(options: ErrorTranslationOptions = {}): Elysia<any, any> {
  const debug = options.debug ?? Bun.env.NODE_ENV !== 'production'

  const plugin = new Elysia({ name: 'angus:errors' }).onError({ as: 'global' }, ({ code, error, set }) => {
    // A permission or handler may short-circuit with a Response of its own.
    if (error instanceof Response) return error

    if (error instanceof APIError) {
      set.status = error.status
      const body = error.toBody()

      // A permission refusal knows which gate closed. The operator always wants
      // that in the logs; a developer wants it in the response; production must
      // not leak it, because the name of the gate is a hint to whoever is
      // probing it. So: logged always, in the body only under debug.
      const deniedBy = (error as { deniedBy?: string }).deniedBy
      if (deniedBy) {
        console.error(`[angus] ${error.name} on ${set.status}: denied by \`${deniedBy}\``)
        if (debug) return { ...body, code: normaliseCode(error, body), deniedBy }
      }

      return { ...body, code: normaliseCode(error, body) }
    }

    // A `get()` that found nothing is a 404 at the HTTP boundary.
    if (error instanceof DoesNotExist) {
      set.status = 404
      return { ...new NotFound(error.message).toBody(), code: ERROR_CODES.notFound }
    }

    // Several rows where the code expected one is a server-side bug.
    if (error instanceof MultipleObjectsReturned) {
      set.status = 500
      return { ...new ServerError(error.message).toBody(), code: ERROR_CODES.server }
    }

    if (error instanceof ValidationError) {
      set.status = 400
      return {
        error: 'ValidationError',
        detail: 'Validation failed.',
        code: ERROR_CODES.validation,
        errors: error.errors,
      }
    }

    // A constraint violation is caused by the submitted data, so it is the
    // caller's to fix. Reporting it as 500 misleads them and buries real 500s.
    const integrity = classifyIntegrityError(error)
    if (integrity) {
      const field = constraintField(error)
      const detail = INTEGRITY_MESSAGES[integrity]
      set.status = integrity === 'unique' ? 409 : 400

      return {
        error: integrity === 'unique' ? 'Conflict' : 'BadRequest',
        detail,
        code: integrity === 'unique' ? ERROR_CODES.conflict : ERROR_CODES.badRequest,
        ...(field ? { errors: { [field]: [detail] } } : {}),
      }
    }

    // Elysia's own schema validation.
    if (code === 'VALIDATION') {
      set.status = 422
      const validation = error as unknown as {
        all?: { path?: string; message?: string; schema?: SchemaLike }[]
        message: string
      }
      const errors: Record<string, string[]> = {}
      for (const issue of validation.all ?? []) {
        const field = (issue.path ?? '').replace(/^\//, '') || 'detail'
        // Prefer a sentence reconstructed from the schema's real constraint over
        // TypeBox's structural message, which names the shape, not the rule.
        ;(errors[field] ??= []).push(describeConstraint(issue.schema, issue.message ?? 'Invalid value.'))
      }
      return {
        error: 'ValidationError',
        detail: 'Request did not match the expected schema.',
        code: ERROR_CODES.validation,
        errors: Object.keys(errors).length > 0 ? errors : { detail: [validation.message] },
      }
    }

    if (code === 'NOT_FOUND') {
      set.status = 404
      return { ...new NotFound().toBody(), code: ERROR_CODES.notFound }
    }

    set.status = 500
    console.error(error)

    if (debug) {
      return {
        error: 'ServerError',
        detail: error instanceof Error ? error.message : String(error),
        code: ERROR_CODES.server,
        stack: error instanceof Error ? error.stack?.split('\n') : undefined,
      }
    }
    return { ...new ServerError().toBody(), code: ERROR_CODES.server }
  })

  return plugin as unknown as Elysia<any, any>
}

/** Keeps a custom `code` if one was set, otherwise derives it from the status. */
/** The constraint-bearing shape of a TypeBox schema, as far as this needs it. */
interface SchemaLike {
  type?: string
  format?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  multipleOf?: number
  pattern?: string
  enum?: unknown[]
  const?: unknown
  anyOf?: SchemaLike[]
}

/**
 * Turns a validation issue into a sentence a person can act on.
 *
 * TypeBox reports the failure structurally — "Expected union value", "Expected
 * string length greater or equal to 3" — which is accurate and nearly useless
 * to whoever sent the request. But the schema it hands over carries the actual
 * constraint, so the useful sentence can be reconstructed from that.
 *
 * The union case is the one that matters most: a numeric field coerces through
 * `anyOf: [string, number]` so a form's `"3"` is accepted, and a bound
 * violation on it reports only "Expected union value". The real `minimum` lives
 * on the union wrapper and on its number member, so it is recoverable.
 *
 * Returns null when nothing better than the original can be said.
 */
/** The literal values of an `anyOf` of consts, or null if it is not one. */
function collectConsts(members: SchemaLike[] | undefined): unknown[] | null {
  if (!members || members.length === 0) return null
  const values = members.map((member) => member.const)
  return values.every((value) => value !== undefined) ? values : null
}

export function describeConstraint(schema: SchemaLike | undefined, fallback: string): string {
  if (!schema) return fallback

  // Flatten a coercing union onto its wrapper, so `minimum` on either surfaces.
  const merged: SchemaLike = { ...schema }
  for (const member of schema.anyOf ?? []) {
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', 'format', 'pattern'] as const) {
      if (merged[key] === undefined && member[key] !== undefined) (merged as Record<string, unknown>)[key] = member[key]
    }
  }

  // A whole-number constraint reads as its own sentence — and it is checked
  // before the min/max bounds because "must be a whole number" is the more
  // fundamental thing to say about `2.5`.
  if (merged.multipleOf === 1) return 'must be a whole number'

  if (merged.format === 'email') return 'must be a valid email address'
  if (merged.format === 'uri') return 'must be a valid URL'
  if (merged.format === 'uuid') return 'must be a valid UUID'
  if (merged.format === 'date-time') return 'must be a valid date and time'
  if (merged.format === 'date') return 'must be a valid date'

  // Choices compile to a union of literals (`anyOf: [{const:'a'}, …]`) rather
  // than an `enum`, so gather the allowed values from either shape.
  const allowed = merged.enum ?? collectConsts(schema.anyOf)
  if (allowed && allowed.length > 0) return `must be one of: ${allowed.join(', ')}`

  if (merged.minimum !== undefined && merged.maximum !== undefined) {
    return `must be between ${merged.minimum} and ${merged.maximum}`
  }
  if (merged.minimum !== undefined) return `must be at least ${merged.minimum}`
  if (merged.maximum !== undefined) return `must be at most ${merged.maximum}`

  if (merged.minLength !== undefined && merged.maxLength !== undefined) {
    return `must be between ${merged.minLength} and ${merged.maxLength} characters`
  }
  if (merged.maxLength !== undefined) return `must be at most ${merged.maxLength} characters`
  if (merged.minLength !== undefined) return `must be at least ${merged.minLength} characters`

  if (merged.pattern !== undefined) return 'is not in the expected format'

  // A wrapper union with no legible constraint of its own — "Expected union
  // value" — is still noise. Say the field is required/invalid plainly.
  if (fallback === 'Expected union value') return 'is not a valid value'

  return fallback
}

function normaliseCode(error: APIError, body: ErrorBody): string {
  return body.code && body.code !== error.name ? body.code : codeForStatus(error.status)
}
