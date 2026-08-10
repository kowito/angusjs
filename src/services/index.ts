/**
 * Application services.
 *
 * `Model → Serializer → ViewSet` covers CRUD and stops. Real applications have
 * operations that aren't CRUD — `publishPost`, `refundInvoice`,
 * `transferOwnership` — and those need to be callable from HTTP, from an agent,
 * from the CLI, and eventually from a queue, with *one* implementation.
 *
 * A service is a declaration, in the same style as a model: input schema,
 * output schema, permissions, transaction boundary, handler. Every surface is
 * then a reader of that declaration rather than a re-implementation — the same
 * move the framework already makes one level down, which is why it adds a
 * primitive without adding a second way of doing things.
 *
 * Mounting a service as a route is all it takes to reach REST, OpenAPI and MCP,
 * because those three already read the route table.
 */

import { Value } from '@sinclair/typebox/value'
import type { Static, TSchema } from 'elysia'
import { atomic } from '../db/transaction.ts'
import { PermissionDenied, Unauthorized } from '../http/errors.ts'
import type { Context, Permission } from '../routing/router.ts'
import { ValidationError } from '../serializers/index.ts'

export interface ServiceContext<I> {
  /** The validated input. */
  input: I
  /** Whoever is performing the action — `context.user` over HTTP, or explicit. */
  actor: unknown
  /** Present when the call arrived over HTTP; absent from CLI and queue calls. */
  http?: Context
}

export interface ServiceConfig<Input extends TSchema, Output extends TSchema | undefined> {
  /** Stable identifier — becomes the route name, tool name and CLI command. */
  name: string
  /** One line, shown in OpenAPI, the MCP tool list and `angus run --list`. */
  summary?: string
  description?: string
  input: Input
  output?: Output
  permissions?: Permission[]
  /**
   * Wraps the handler in a transaction, so a partial failure leaves nothing
   * behind. Defaults to `true` — a domain action that writes twice should not
   * have to remember.
   */
  transactional?: boolean
  tags?: string[]
  handler: (context: ServiceContext<Static<Input>>) => Promise<OutputOf<Output>> | OutputOf<Output>
}

type OutputOf<O> = O extends TSchema ? Static<O> : unknown

export interface Service<Input extends TSchema = TSchema, Output extends TSchema | undefined = undefined> {
  readonly name: string
  readonly summary?: string
  readonly description?: string
  readonly input: Input
  readonly output?: Output
  readonly permissions: Permission[]
  readonly transactional: boolean
  readonly tags?: string[]
  readonly handler: ServiceConfig<Input, Output>['handler']
  /** Phantom types, for annotating callers. */
  readonly $input: Static<Input>
  readonly $output: OutputOf<Output>
}

/**
 * A service with its input type erased. Declared structurally rather than as
 * `Service<TSchema, ...>` because the handler parameter is contravariant — a
 * handler taking `{ invoiceId: number }` is not assignable to one taking
 * `unknown`, so the generic form would reject every real service.
 */
export interface AnyService {
  readonly name: string
  readonly summary?: string
  readonly description?: string
  readonly input: TSchema
  readonly output?: TSchema
  readonly permissions: Permission[]
  readonly transactional: boolean
  readonly tags?: string[]
  readonly handler: (context: ServiceContext<any>) => any
}

const registry = new Map<string, AnyService>()

/** Every service defined in this process. Used by the CLI. */
export function registeredServices(): AnyService[] {
  return [...registry.values()]
}

export function getService(name: string): AnyService | undefined {
  return registry.get(name)
}

/** Only for tests — a real process defines each service once at import time. */
export function _resetServiceRegistry(): void {
  registry.clear()
}

/**
 * Defines a service.
 *
 * ```ts
 * export const publishPost = service({
 *   name: 'publish-post',
 *   summary: 'Publish a draft post',
 *   input: t.Object({ postId: t.Numeric() }),
 *   output: PostSerializer.read,
 *   permissions: [isStaff],
 *   async handler({ input, actor }) {
 *     const [post] = await Post.objects.filter({ id: input.postId }).update({ status: 'published' })
 *     if (!post) throw new NotFound()
 *     return PostSerializer.toRepresentation(post)
 *   },
 * })
 * ```
 */
export function service<Input extends TSchema, Output extends TSchema | undefined = undefined>(
  config: ServiceConfig<Input, Output>,
): Service<Input, Output> {
  if (!/^[a-z][a-z0-9_-]*$/i.test(config.name)) {
    throw new Error(
      `service("${config.name}"): the name becomes a route name, an MCP tool name and a CLI command, ` +
        `so it must start with a letter and contain only letters, digits, dashes and underscores.`,
    )
  }
  if (registry.has(config.name)) {
    throw new Error(`Service "${config.name}" is already defined. Service names must be unique.`)
  }

  const definition = {
    ...config,
    permissions: config.permissions ?? [],
    transactional: config.transactional ?? true,
  } as unknown as Service<Input, Output>

  registry.set(config.name, definition as unknown as AnyService)
  return definition
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export interface CallOptions {
  /** Who is acting. Over HTTP this is `context.user`. */
  actor?: unknown
  /** The HTTP context, when the call arrived that way. */
  http?: Context
  /**
   * Skips the permission checks. For trusted callers only — the CLI, a queue
   * worker, a migration. Never set this from a request handler.
   */
  system?: boolean
}

/**
 * Validates the input, checks permissions, and runs the handler — in a
 * transaction unless the service opts out.
 *
 * This is the one path every surface goes through, which is what keeps them
 * from drifting apart.
 */
export async function callService<S extends AnyService>(
  definition: S,
  rawInput: unknown,
  options: CallOptions = {},
): Promise<unknown> {
  const input = decodeInput(definition, rawInput)

  if (!options.system && definition.permissions.length > 0) {
    const context = (options.http ?? { user: options.actor }) as Context
    for (const permission of definition.permissions) {
      if (!(await permission(context))) {
        throw context.user ? new PermissionDenied() : new Unauthorized()
      }
    }
  }

  const run = () =>
    definition.handler({
      input: input as never,
      actor: options.actor ?? (options.http as Context | undefined)?.user,
      http: options.http,
    })

  return definition.transactional ? atomic(run) : run()
}

/** Validates and coerces, reporting failures the way serializers do. */
function decodeInput(definition: AnyService, rawInput: unknown): unknown {
  const value = rawInput ?? {}

  if (Value.Check(definition.input, value)) {
    return Value.Decode(definition.input, value)
  }

  const errors: Record<string, string[]> = {}
  for (const issue of Value.Errors(definition.input, value)) {
    const field = issue.path.replace(/^\//, '').replace(/\//g, '.') || 'detail'
    ;(errors[field] ??= []).push(issue.message)
  }

  throw new ValidationError(errors)
}

export { fromService } from './route.ts'
export type { ServiceRouteOptions } from './route.ts'
