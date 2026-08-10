/**
 * Project bootstrap.
 *
 * Turns settings into a running Elysia application: opens the database, mounts
 * every app's router under its prefix, installs the error translation layer,
 * and optionally serves OpenAPI docs.
 */

import { Elysia } from 'elysia'
import { connect, hasConnection } from '../db/connection.ts'
import { page } from '../html.ts'
import { mcpHttpRoutes, type ServerIdentity } from '../mcp/index.ts'
import { buildTools, type Tool } from '../mcp/tools.ts'
import { generateOpenApi, renderDocs, type OpenApiDocument } from '../openapi/index.ts'
import { joinPath, Router } from '../routing/router.ts'
import { appModels, type AngusApp } from './app.ts'
import { errorTranslation } from './errors.ts'
import { health, observability } from './observability.ts'
import { cors, csrf, securityHeaders } from '../http/security.ts'
import { defaultThrottleRules, throttle } from '../http/throttle.ts'
import { disconnect } from '../db/connection.ts'
import { resolveSettings, type ResolvedSettings, type Settings, type ThrottleSettings } from './settings.ts'

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

  elysia.use(errorTranslation({ debug: settings.debug }))

  // Ordering is deliberate. Observability wraps everything so even rejected
  // requests are logged with an id. Security runs before routing so a
  // cross-site write never reaches a handler. Throttling runs after the
  // identity hook, which is why it lives further down.
  if (settings.observability !== false) elysia.use(observability(settings.observability ?? {}))
  if (settings.health !== false) elysia.use(health(settings.health ?? {}))

  const security = settings.security ?? {}
  if (security.headers !== false) elysia.use(securityHeaders(security.headers ?? {}))
  if (security.cors) elysia.use(cors(security.cors))
  if (security.csrf !== false) elysia.use(csrf(security.csrf ?? {}))

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

  // Rate limiting defaults to production only. The limits that make sense
  // against credential stuffing — five login attempts per five minutes — would
  // lock a developer out of their own app while they were building it, and a
  // laptop is not the target of a brute-force campaign. `angus check --deploy`
  // verifies it is actually on where it matters.
  const throttleEnabled =
    settings.throttle === false ? false : (settings.throttle ?? null) !== null || Bun.env.NODE_ENV === 'production'

  // After `authenticate`, so a limit can be keyed by user rather than by IP.
  if (throttleEnabled) {
    const configured = (settings.throttle === false ? {} : (settings.throttle ?? {})) as ThrottleSettings
    elysia.use(
      throttle({
        ...configured,
        rules: configured.rules ?? defaultThrottleRules(settings.prefix),
        exempt: configured.exempt ?? [
          settings.health === false ? '\0none' : (settings.health?.livenessPath ?? '/healthz'),
          settings.health === false ? '\0none' : (settings.health?.readinessPath ?? '/readyz'),
        ],
      }),
    )
  }

  elysia.use(projectRouter(settings.apps, settings.prefix).toElysia({ name: 'angus:urls' }))

  return elysia
}

export interface RunningServer {
  app: Elysia<any, any>
  url: string
  stop(): Promise<void>
}

/**
 * Builds the app and binds it to a port.
 *
 * `stop()` drains rather than cutting: it stops accepting connections, gives
 * in-flight requests until `shutdownTimeoutMs` to finish, then closes the
 * database. Without the drain, a rolling deploy returns 502s for every request
 * that happened to be in progress.
 */
export async function runServer(rawSettings: Settings): Promise<RunningServer> {
  const settings = resolveSettings(rawSettings)
  const app = await createApp(rawSettings)

  app.listen({ port: settings.server.port, hostname: settings.server.hostname })

  const url = `http://${settings.server.hostname === '0.0.0.0' ? 'localhost' : settings.server.hostname}:${settings.server.port}`

  let stopping: Promise<void> | undefined

  return {
    app,
    url,
    stop() {
      // Idempotent: SIGINT and SIGTERM can both arrive.
      return (stopping ??= (async () => {
        // `false` means "let in-flight requests finish".
        await app.stop(false)

        const deadline = Date.now() + settings.server.shutdownTimeoutMs
        while (Date.now() < deadline) {
          const pending = (app.server?.pendingRequests ?? 0) as number
          if (pending === 0) break
          await Bun.sleep(50)
        }

        const remaining = (app.server?.pendingRequests ?? 0) as number
        if (remaining > 0) {
          console.warn(`angus: ${remaining} request(s) still in flight after the shutdown timeout; closing anyway.`)
        }

        await disconnect()
      })())
    },
  }
}
