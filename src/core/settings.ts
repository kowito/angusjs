/**
 * Project settings.
 *
 * One file describes the whole project: which apps are installed, where the
 * database lives, what wraps every request. The CLI reads the same file, which
 * is what lets `angus migrate` and `angus routes` work without booting a server.
 */

import type { Elysia } from 'elysia'
import type { DatabaseConfig } from '../db/connection.ts'
import type { Context, Permission } from '../routing/router.ts'
import type { AngusApp } from './app.ts'
import type { CorsOptions, CsrfOptions, SecurityHeaderOptions } from '../http/security.ts'
import type { ThrottleOptions } from '../http/throttle.ts'
import type { HealthOptions, ObservabilityOptions } from './observability.ts'

export interface ServerSettings {
  port?: number
  hostname?: string
  /**
   * How long to let in-flight requests finish on SIGTERM, in milliseconds.
   * Set it below your orchestrator's kill timeout, or the pod is killed
   * mid-request anyway. Defaults to 10s.
   */
  shutdownTimeoutMs?: number
}

export interface OpenApiSettings {
  enabled?: boolean
  title?: string
  version?: string
  description?: string
  /** Where the reference page is served. Defaults to `/docs`. */
  path?: string
  /** Where the JSON document is served. Defaults to `/openapi.json`. */
  specPath?: string
  /** Advertised base URLs, for clients generated from the spec. */
  servers?: { url: string; description?: string }[]
}

export interface McpSettings {
  enabled?: boolean
  /** Where the MCP endpoint is served. Defaults to `/mcp`. */
  path?: string
  /** Server name reported to clients. Defaults to the OpenAPI title. */
  name?: string
  version?: string
  /** Guidance handed to the model alongside the tool list. */
  instructions?: string
  /** Only expose these tools, by name (the route's `name`, or a derived one). */
  include?: readonly string[]
  exclude?: readonly string[]
  /** Expose only GET/HEAD routes — an agent that can read but not write. */
  readOnly?: boolean
  /** Origins allowed to call the endpoint, in addition to the server's own. */
  allowedOrigins?: readonly string[]
  /** Gate the endpoint itself, on top of each route's own permissions. */
  permissions?: Permission[]
}

export interface Settings {
  /** Installed apps, in mount order. */
  apps: AngusApp[]
  database?: DatabaseConfig
  server?: ServerSettings
  /** Prefix applied to every app — `/api` is a common choice. */
  prefix?: string
  /** Elysia plugins applied to the whole project: CORS, cookies, rate limits. */
  middleware?: Elysia<any, any>[]
  /**
   * Populates `context.user` for every request. Permissions read it, and
   * returning `null` simply leaves the request anonymous.
   */
  authenticate?: (context: Context) => unknown | Promise<unknown>
  openapi?: OpenApiSettings | false
  /**
   * Exposes the API to agents over the Model Context Protocol. Enabled by
   * default: the generated tools dispatch through the same routes, so they
   * carry exactly the authority the HTTP API already grants and no more. Set
   * `false` to remove the endpoint.
   */
  mcp?: McpSettings | false
  /** Includes stack traces in 500 responses. Defaults to `NODE_ENV !== 'production'`. */
  debug?: boolean
  /** Where migration SQL lives, relative to the project root. Defaults to `migrations`. */
  migrationsDir?: string

  /**
   * Security, observability and rate limiting. Every entry is opt-in with a
   * production-appropriate default, and `angus check --deploy` reports which
   * are missing before you find out the hard way.
   */
  security?: SecuritySettings
  observability?: ObservabilitySettings | false
  throttle?: ThrottleSettings | false
  health?: HealthSettings | false
}

export interface SecuritySettings {
  /** Response headers: HSTS, CSP, frame options. Defaults to on. */
  headers?: SecurityHeaderOptions | false
  /** CSRF for cookie-authenticated writes. Defaults to on. */
  csrf?: CsrfOptions | false
  /** Cross-origin access. Off unless configured — a same-origin API needs none. */
  cors?: CorsOptions
}

export interface ObservabilitySettings extends ObservabilityOptions {}
export interface ThrottleSettings extends ThrottleOptions {}
export interface HealthSettings extends HealthOptions {}

export interface ResolvedSettings extends Settings {
  server: Required<ServerSettings>
  prefix: string
  middleware: Elysia<any, any>[]
  debug: boolean
  migrationsDir: string
}

/** Identity function that exists for the types and the editor autocomplete. */
export function defineSettings(settings: Settings): Settings {
  return settings
}

export function resolveSettings(settings: Settings): ResolvedSettings {
  const names = new Set<string>()
  for (const app of settings.apps) {
    if (names.has(app.name)) {
      throw new Error(`Two installed apps are both named "${app.name}". App names must be unique.`)
    }
    names.add(app.name)
  }

  return {
    ...settings,
    server: {
      port: settings.server?.port ?? Number(Bun.env.PORT ?? 8000),
      hostname: settings.server?.hostname ?? Bun.env.HOST ?? '0.0.0.0',
      shutdownTimeoutMs: settings.server?.shutdownTimeoutMs ?? 10_000,
    },
    prefix: settings.prefix ?? '',
    middleware: settings.middleware ?? [],
    debug: settings.debug ?? Bun.env.NODE_ENV !== 'production',
    migrationsDir: settings.migrationsDir ?? 'migrations',
  }
}
