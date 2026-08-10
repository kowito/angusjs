/**
 * Project settings.
 *
 * One file describes the whole project: which apps are installed, where the
 * database lives, what wraps every request. The CLI reads the same file, which
 * is what lets `angus migrate` and `angus routes` work without booting a server.
 */

import type { Elysia } from 'elysia'
import type { DatabaseConfig } from '../db/connection.ts'
import type { Context } from '../routing/router.ts'
import type { AngusApp } from './app.ts'

export interface ServerSettings {
  port?: number
  hostname?: string
}

export interface OpenApiSettings {
  enabled?: boolean
  title?: string
  version?: string
  description?: string
  /** Where the docs are served. Defaults to `/docs`. */
  path?: string
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
  /** Includes stack traces in 500 responses. Defaults to `NODE_ENV !== 'production'`. */
  debug?: boolean
  /** Where migration SQL lives, relative to the project root. Defaults to `migrations`. */
  migrationsDir?: string
}

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
    },
    prefix: settings.prefix ?? '',
    middleware: settings.middleware ?? [],
    debug: settings.debug ?? Bun.env.NODE_ENV !== 'production',
    migrationsDir: settings.migrationsDir ?? 'migrations',
  }
}
