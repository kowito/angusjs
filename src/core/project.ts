/**
 * Project bootstrap.
 *
 * Turns settings into a running Elysia application: opens the database, mounts
 * every app's router under its prefix, installs the error translation layer,
 * and optionally serves OpenAPI docs.
 */

import { Elysia } from 'elysia'
import { connect, hasConnection } from '../db/connection.ts'
import { DoesNotExist, MultipleObjectsReturned } from '../db/errors.ts'
import { page } from '../html.ts'
import { APIError, NotFound, ServerError } from '../http/errors.ts'
import { mcpHttpRoutes, type ServerIdentity } from '../mcp/index.ts'
import { buildTools, type Tool } from '../mcp/tools.ts'
import { generateOpenApi, renderDocs, type OpenApiDocument } from '../openapi/index.ts'
import { joinPath, Router } from '../routing/router.ts'
import { ValidationError } from '../serializers/index.ts'
import { appModels, type AngusApp } from './app.ts'
import { resolveSettings, type ResolvedSettings, type Settings } from './settings.ts'

export interface BuildOptions {
  /** Skip opening the database — useful when a test already connected one. */
  connectDatabase?: boolean
}

/** Combines every app's router into the project's root router. */
export function projectRouter(apps: AngusApp[], prefix = ''): Router {
  const root = new Router()
  for (const app of apps) {
    if (!app.urls) continue
    root.include(app.absolutePrefix ? app.prefix : joinPath(prefix, app.prefix), app.urls)
  }
  return root
}

/**
 * Translates thrown errors into JSON responses.
 *
 * The framework's whole error story lives here: a view can `throw new
 * NotFound()`, let `DoesNotExist` bubble up from `.get()`, or let a serializer
 * reject a payload, and all three come out as the right status code.
 */
function errorHandling(settings: ResolvedSettings) {
  return new Elysia({ name: 'angus:errors' }).onError({ as: 'global' }, ({ code, error, set }) => {
    if (error instanceof APIError) {
      set.status = error.status
      return error.toBody()
    }

    // A `get()` that found nothing is a 404 at the HTTP boundary.
    if (error instanceof DoesNotExist) {
      set.status = 404
      return new NotFound(error.message).toBody()
    }

    if (error instanceof MultipleObjectsReturned) {
      set.status = 500
      return new ServerError(error.message).toBody()
    }

    if (error instanceof ValidationError) {
      set.status = 400
      return { error: 'ValidationError', detail: 'Validation failed.', errors: error.errors }
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
        errors: Object.keys(errors).length > 0 ? errors : { detail: [validation.message] },
      }
    }

    if (code === 'NOT_FOUND') {
      set.status = 404
      return new NotFound().toBody()
    }

    set.status = 500
    const message = error instanceof Error ? error.message : String(error)
    if (settings.debug) {
      console.error(error)
      return {
        error: 'ServerError',
        detail: message,
        stack: error instanceof Error ? error.stack?.split('\n') : undefined,
      }
    }
    console.error(error)
    return new ServerError().toBody()
  })
}

/** Builds the OpenAPI document for a project without starting it. */
export function projectSpec(rawSettings: Settings): OpenApiDocument {
  const settings = resolveSettings(rawSettings)
  const routes = projectRouter(settings.apps, settings.prefix).flatten()
  const openapi = settings.openapi === false ? {} : (settings.openapi ?? {})

  return generateOpenApi(routes, {
    title: openapi.title,
    version: openapi.version,
    description: openapi.description,
    servers: openapi.servers,
  })
}

/**
 * Serves the generated spec and a reference page. Both are derived from the
 * router at request time, so they can never drift from the routes themselves.
 */
function openApiRoutes(settings: ResolvedSettings, rawSettings: Settings): Elysia<any, any> | null {
  if (settings.openapi === false || settings.openapi?.enabled === false) return null

  const docsPath = settings.openapi?.path ?? '/docs'
  const specPath = settings.openapi?.specPath ?? '/openapi.json'

  // Built once — routes are fixed after startup.
  let cached: OpenApiDocument | undefined
  const spec = () => (cached ??= projectSpec(rawSettings))

  return new Elysia({ name: 'angus:openapi' })
    .get(specPath, () => spec())
    .get(docsPath, () => page(renderDocs(spec(), specPath)))
}

/** The MCP tools a project exposes, without starting it. */
export function projectTools(rawSettings: Settings): Tool[] {
  const settings = resolveSettings(rawSettings)
  const mcp = settings.mcp === false ? {} : (settings.mcp ?? {})
  const routes = projectRouter(settings.apps, settings.prefix).flatten()
  return buildTools(routes, { include: mcp.include, exclude: mcp.exclude, readOnly: mcp.readOnly })
}

/** Name and version reported to MCP clients. */
export function mcpIdentity(rawSettings: Settings): ServerIdentity {
  const settings = resolveSettings(rawSettings)
  const mcp = settings.mcp === false ? {} : (settings.mcp ?? {})
  const openapi = settings.openapi === false ? {} : (settings.openapi ?? {})

  return {
    name: mcp.name ?? openapi.title ?? 'angusjs',
    version: mcp.version ?? openapi.version ?? '0.1.0',
    instructions:
      mcp.instructions ??
      'Each tool calls one endpoint of this API. Tools carry the same permissions as the HTTP API.',
  }
}

/**
 * Mounts the MCP endpoint. Tool calls are dispatched back through the very app
 * being built, so `app` is read through a thunk — it does not exist yet at the
 * moment these routes are registered.
 */
function mcpRoutes(
  settings: ResolvedSettings,
  rawSettings: Settings,
  app: () => Elysia<any, any>,
): Elysia<any, any> | null {
  if (settings.mcp === false || settings.mcp?.enabled === false) return null

  const mcp = settings.mcp ?? {}
  let tools: Tool[] | undefined
  const identity = mcpIdentity(rawSettings)

  return mcpHttpRoutes({
    path: mcp.path ?? '/mcp',
    allowedOrigins: mcp.allowedOrigins,
    permissions: mcp.permissions,
    context: (request) => ({
      app: app(),
      // Built on first use: the route table is complete only after startup.
      tools: (tools ??= projectTools(rawSettings)),
      identity,
      origin: new URL(request.url).origin,
      headers: request.headers,
    }),
  })
}

/**
 * Builds the Elysia application. Does everything `runserver` does except bind
 * a port, which is exactly what tests want.
 */
export async function createApp(rawSettings: Settings, options: BuildOptions = {}): Promise<Elysia<any, any>> {
  const settings = resolveSettings(rawSettings)

  if (settings.database && options.connectDatabase !== false && !hasConnection()) {
    await connect(settings.database, appModels(settings.apps))
  }

  for (const app of settings.apps) await app.ready?.()

  const elysia = new Elysia({ name: 'angus' })

  elysia.use(errorHandling(settings))

  const docs = openApiRoutes(settings, rawSettings)
  if (docs) elysia.use(docs)

  const mcp = mcpRoutes(settings, rawSettings, () => elysia)
  if (mcp) elysia.use(mcp)

  for (const plugin of settings.middleware) elysia.use(plugin)

  if (rawSettings.authenticate) {
    const authenticate = rawSettings.authenticate
    // `resolve` runs after validation, so `user` is available to permissions
    // and handlers alike.
    elysia.resolve({ as: 'global' }, async (context) => ({
      user: await authenticate(context as never),
    }))
  }

  elysia.use(projectRouter(settings.apps, settings.prefix).toElysia({ name: 'angus:urls' }))

  return elysia
}

export interface RunningServer {
  app: Elysia<any, any>
  url: string
  stop(): Promise<void>
}

/** Builds the app and binds it to a port. */
export async function runServer(rawSettings: Settings): Promise<RunningServer> {
  const settings = resolveSettings(rawSettings)
  const app = await createApp(rawSettings)

  app.listen({ port: settings.server.port, hostname: settings.server.hostname })

  const url = `http://${settings.server.hostname === '0.0.0.0' ? 'localhost' : settings.server.hostname}:${settings.server.port}`

  return {
    app,
    url,
    async stop() {
      await app.stop()
    },
  }
}
