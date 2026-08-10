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
import { DoesNotExist, MultipleObjectsReturned } from '../db/errors.ts'
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

    // Elysia's own schema validation.
    if (code === 'VALIDATION') {
      set.status = 422
      const validation = error as unknown as { all?: { path?: string; message?: string }[]; message: string }
      const errors: Record<string, string[]> = {}
      for (const issue of validation.all ?? []) {
        const field = (issue.path ?? '').replace(/^\//, '') || 'detail'
        ;(errors[field] ??= []).push(issue.message ?? 'Invalid value.')
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
function normaliseCode(error: APIError, body: ErrorBody): string {
  return body.code && body.code !== error.name ? body.code : codeForStatus(error.status)
}
