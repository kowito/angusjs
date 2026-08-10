/**
 * Mounting a service on a router.
 *
 * This is deliberately the *only* adapter: OpenAPI and MCP both read the route
 * table, so a mounted service reaches all three surfaces without a second
 * registration step and without a second place for them to disagree.
 */

import { t, type TSchema } from 'elysia'
import type { RouteOptions } from '../routing/router.ts'
import { view, type ViewDefinition } from '../routing/view.ts'
import { callService, type AnyService } from './index.ts'

export interface ServiceRouteOptions extends Omit<RouteOptions, 'body' | 'response'> {
  /**
   * Path parameters to fold into the service input, so
   * `POST /posts/:postId/publish` can feed a service that expects `postId`.
   */
  params?: TSchema
}

/**
 * Turns a service into a view. The service's input schema becomes the request
 * body, its output schema the response, and its permissions the route's — so
 * the HTTP surface can't grant more than the service does.
 *
 * ```ts
 * router().post('/posts/:postId/publish', fromService(publishPost, {
 *   params: t.Object({ postId: t.Numeric() }),
 * }))
 * ```
 */
/**
 * The body is the service input minus whatever the path already supplies —
 * otherwise `POST /invoices/1/approve` would be rejected for not repeating
 * `invoiceId` in its body.
 */
function bodySchema(definition: AnyService, params: TSchema | undefined): TSchema {
  const fromPath = new Set(Object.keys((params as any)?.properties ?? {}))
  const properties = (definition.input as any).properties as Record<string, TSchema> | undefined

  if (!properties || fromPath.size === 0) return definition.input

  const remaining: Record<string, TSchema> = {}
  for (const [key, schema] of Object.entries(properties)) {
    if (!fromPath.has(key)) remaining[key] = schema
  }

  // Rebuilt through `t.Object` rather than by editing the JSON, so TypeBox's
  // own markers (optionality in particular) survive.
  return t.Object(remaining, { title: (definition.input as any).title })
}

export function fromService(definition: AnyService, options: ServiceRouteOptions = {}): ViewDefinition {
  return view({
    // Path parameters and body are merged before validation, so a service
    // doesn't need to know which part of the request carried its input.
    params: options.params,
    body: bodySchema(definition, options.params),
    response: definition.output,
    permissions: [...definition.permissions, ...(options.permissions ?? [])],
    summary: options.summary ?? definition.summary ?? definition.name,
    description: options.description ?? definition.description,
    tags: options.tags ?? definition.tags,
    name: options.name ?? definition.name,
    hidden: options.hidden,
    async handler(context) {
      const body = (context.body ?? {}) as Record<string, unknown>
      const params = (context.params ?? {}) as Record<string, unknown>
      const input = { ...body, ...params }

      // Permissions were already enforced by the router, with the full HTTP
      // context. Re-running them here would double the work and could differ.
      return callService(definition, input, { http: context, system: true, actor: context.user })
    },
  })
}
