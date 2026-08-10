/**
 * Views.
 *
 * `view()` bundles a handler with its schema, permissions, and documentation so
 * the whole endpoint travels as one value — the practical equivalent of
 * Django's class-based views, minus the inheritance.
 */

import type { Static, TSchema } from 'elysia'
import type { Handler, Permission, RouteOptions } from './router.ts'

export interface ViewConfig<Body extends TSchema, Query extends TSchema, Params extends TSchema, Response> {
  body?: Body
  query?: Query
  params?: Params
  headers?: TSchema
  response?: Response
  permissions?: Permission[]
  summary?: string
  description?: string
  tags?: string[]
  name?: string
  hidden?: boolean
  handler: (context: ViewContext<Body, Query, Params>) => unknown | Promise<unknown>
}

/** The parts of Elysia's context a view actually reaches for, typed. */
export interface ViewContext<Body extends TSchema, Query extends TSchema, Params extends TSchema>
  extends Record<string, any> {
  body: Body extends TSchema ? Static<Body> : unknown
  query: Query extends TSchema ? Static<Query> : Record<string, string | undefined>
  params: Params extends TSchema ? Static<Params> : Record<string, string>
  request: Request
  set: { status?: number | string; headers: Record<string, string> }
  /** Populated by whatever the project configured as its authenticator. */
  user?: unknown
}

export interface ViewDefinition extends RouteOptions {
  handler: Handler
  /** Marks the object so routers can tell a view from a bare function. */
  readonly __angusView: true
}

export function view<
  Body extends TSchema = TSchema,
  Query extends TSchema = TSchema,
  Params extends TSchema = TSchema,
  Response = TSchema,
>(config: ViewConfig<Body, Query, Params, Response>): ViewDefinition {
  const { handler, ...options } = config
  return {
    ...(options as RouteOptions),
    handler: handler as Handler,
    __angusView: true,
  }
}

export function isViewDefinition(value: unknown): value is ViewDefinition {
  return typeof value === 'object' && value !== null && '__angusView' in value
}
