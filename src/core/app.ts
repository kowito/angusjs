/**
 * Apps.
 *
 * A project is a list of apps, each owning its models and its URLs — the unit
 * that makes a large codebase navigable and a feature removable in one line of
 * settings.
 */

import type { AnyModel } from '../db/model.ts'
import type { Router } from '../routing/router.ts'

export interface AppConfig {
  /** Unique within the project. Used in the routes table and error messages. */
  name: string
  /** URL prefix this app is mounted under. Defaults to `/<name>`. */
  prefix?: string
  /**
   * Mounts at `prefix` directly, ignoring the project-wide `prefix` in
   * settings. Used by the admin, which is a UI rather than part of the API.
   */
  absolutePrefix?: boolean
  /** The app's models. Listing them here is what makes migrations see them. */
  models?: Record<string, AnyModel>
  /** The app's routes. */
  urls?: Router
  /** Human-readable label for the routes table. */
  verboseName?: string
  /**
   * Structured facts about the app, for tooling that inspects a project
   * without running it — `angus check --deploy` reads `admin.guarded` here,
   * because a route's permission list cannot distinguish a configured check
   * from a built-in fail-closed default.
   */
  meta?: Record<string, unknown>
  /**
   * Runs once at startup, after the database is connected and before the
   * server binds — Django's `AppConfig.ready()`. Register signals, warm caches,
   * seed reference data.
   */
  ready?: () => void | Promise<void>
}

export interface AngusApp extends AppConfig {
  readonly prefix: string
  readonly models: Record<string, AnyModel>
  readonly verboseName: string
}

export function defineApp(config: AppConfig): AngusApp {
  if (!config.name || !/^[a-z][a-z0-9_-]*$/i.test(config.name)) {
    throw new Error(
      `defineApp: "${config.name}" is not a valid app name. Use letters, digits, dashes and underscores.`,
    )
  }

  return {
    ...config,
    prefix: config.prefix ?? `/${config.name}`,
    models: config.models ?? {},
    verboseName: config.verboseName ?? config.name,
  }
}

/** Every model across a set of apps, deduplicated. */
export function appModels(apps: AngusApp[]): AnyModel[] {
  const seen = new Map<string, AnyModel>()
  for (const app of apps) {
    for (const model of Object.values(app.models)) {
      seen.set(model.name, model)
    }
  }
  return [...seen.values()]
}
