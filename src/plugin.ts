/**
 * The Elysia plugin surface.
 *
 * `createApp(settings)` builds a whole project. These build *parts*, so an
 * Elysia application that already exists can adopt one piece of Angus without
 * adopting the conventions around it. Incremental adoption is a first-class
 * path, not a fallback.
 *
 * ```ts
 * new Elysia()
 *   .use(angus({ database, authenticate }))
 *   .use(models(Post, Author))
 *   .use(mount('/posts', modelViewSet({ model: Post, serializer })))
 *   .listen(3000)
 * ```
 */

import { Elysia } from 'elysia'
import { adminSite, type AdminSite, type AdminSiteOptions } from './admin/index.ts'
import { connect, hasConnection, type DatabaseConfig } from './db/connection.ts'
import type { AnyModel } from './db/model.ts'
import { errorTranslation } from './core/errors.ts'
import { generateOpenApi, renderDocs, type OpenApiOptions } from './openapi/index.ts'
import { buildTools, mcpHttpRoutes, type ToolFilter } from './mcp/index.ts'
import { page } from './html.ts'
import type { Context, Permission } from './routing/router.ts'
import { Router } from './routing/router.ts'

export interface AngusPluginOptions {
  /** Opens a connection at startup. Omit if you connect yourself. */
  database?: DatabaseConfig
  /** Models to build tables for. Defaults to every registered model. */
  models?: AnyModel[]
  /** Populates `context.user` for every request. */
  authenticate?: (context: Context) => unknown | Promise<unknown>
  /** Installs the JSON error translation layer. Defaults to `true`. */
  errors?: boolean
  /** Includes stack traces in 500s. Defaults to `NODE_ENV !== 'production'`. */
  debug?: boolean
}

/**
 * The base plugin: error translation and, optionally, the database and the
 * identity hook. Everything else composes on top.
 */
export function angus(options: AngusPluginOptions = {}): Elysia<any, any> {
  const app = new Elysia({ name: 'angus' })

  if (options.errors !== false) {
    app.use(errorTranslation({ debug: options.debug ?? Bun.env.NODE_ENV !== 'production' }))
  }

  if (options.database) {
    // `onStart` would be too late for the first request, so the connection is
    // opened eagerly and awaited by Elysia through the returned promise.
    const opening = hasConnection() ? Promise.resolve() : connect(options.database, options.models).then(() => undefined)
    app.onStart(() => opening)
    void opening
  }

  if (options.authenticate) {
    const authenticate = options.authenticate
    app.resolve({ as: 'global' }, async (context) => ({ user: await authenticate(context as never) }))
  }

  return app
}

/**
 * Mounts a router — a view set, a service route, or anything else Angus builds
 * — into your application.
 */
export function mount(prefix: string, router: Router): Elysia<any, any> {
  return router.toElysia({ prefix })
}

/** Serves the OpenAPI document and reference page for a set of routers. */
export function openapi(
  routers: Router[],
  options: OpenApiOptions & { path?: string; specPath?: string; prefix?: string } = {},
): Elysia<any, any> {
  const docsPath = options.path ?? '/docs'
  const specPath = options.specPath ?? '/openapi.json'

  let cached: ReturnType<typeof generateOpenApi> | undefined
  const spec = () =>
    (cached ??= generateOpenApi(
      routers.flatMap((router) => router.flatten(options.prefix ?? '')),
      options,
    ))

  return new Elysia({ name: 'angus:openapi' })
    .get(specPath, () => spec())
    .get(docsPath, () => page(renderDocs(spec(), specPath)))
}

export interface McpPluginOptions extends ToolFilter {
  path?: string
  name?: string
  version?: string
  instructions?: string
  prefix?: string
  allowedOrigins?: readonly string[]
  permissions?: readonly Permission[]
}

/**
 * Exposes routers to agents over MCP. Tool calls are dispatched back through
 * `app`, so they carry exactly the authority the HTTP routes do.
 */
export function mcp(routers: Router[], app: () => Elysia<any, any>, options: McpPluginOptions = {}): Elysia<any, any> {
  let tools: ReturnType<typeof buildTools> | undefined

  return mcpHttpRoutes({
    path: options.path ?? '/mcp',
    allowedOrigins: options.allowedOrigins,
    permissions: options.permissions,
    context: (request) => ({
      app: app(),
      tools: (tools ??= buildTools(
        routers.flatMap((router) => router.flatten(options.prefix ?? '')),
        { include: options.include, exclude: options.exclude, readOnly: options.readOnly },
      )),
      identity: {
        name: options.name ?? 'angus',
        version: options.version ?? '0.1.0',
        instructions: options.instructions,
      },
      origin: new URL(request.url).origin,
      headers: request.headers,
    }),
  })
}

/** Mounts an admin site into an application you own. */
export function admin(site: AdminSite): Elysia<any, any>
export function admin(options?: AdminSiteOptions): Elysia<any, any>
export function admin(input?: AdminSite | AdminSiteOptions): Elysia<any, any> {
  const site = input && 'register' in input ? (input as AdminSite) : adminSite(input as AdminSiteOptions)
  return site.router().toElysia({ prefix: site.path })
}
