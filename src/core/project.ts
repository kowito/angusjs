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
import { APIError, NotFound, ServerError } from '../http/errors.ts'
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

async function openApiPlugin(settings: ResolvedSettings): Promise<Elysia<any, any> | null> {
  if (settings.openapi === false || settings.openapi?.enabled === false) return null

  try {
    // Optional peer: projects that don't want docs needn't install it. The
    // specifier is indirected so this stays a runtime concern, not a build one.
    const specifier = '@elysiajs/openapi'
    const { openapi } = (await import(specifier)) as { openapi: (config: unknown) => Elysia<any, any> }
    return openapi({
      path: settings.openapi?.path ?? '/docs',
      documentation: {
        info: {
          title: settings.openapi?.title ?? 'angusjs API',
          version: settings.openapi?.version ?? '0.1.0',
          description: settings.openapi?.description,
        },
      },
    })
  } catch {
    if (settings.openapi?.enabled) {
      console.warn(
        'angus: OpenAPI docs were requested but @elysiajs/openapi is not installed.\n' +
          '       Run `bun add @elysiajs/openapi`, or set `openapi: false` in your settings.',
      )
    }
    return null
  }
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

  const docs = await openApiPlugin(settings)
  if (docs) elysia.use(docs)

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
