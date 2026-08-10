/**
 * Typed configuration.
 *
 * Environment variables are all strings and any of them can be missing. Reading
 * them ad hoc means a typo surfaces as `undefined` deep inside a request, hours
 * after deploy. `defineEnv` reads and validates the whole set once, at import
 * time, and refuses to start if anything is wrong — the cheapest possible place
 * to find out.
 *
 * It uses TypeBox, the same schema language as models and routes, so this is
 * not a new concept to learn.
 */

import { Value } from '@sinclair/typebox/value'
import { t, type Static, type TSchema } from 'elysia'

export class ConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'ConfigurationError'
  }
}

export interface DefineEnvOptions {
  /** Defaults to `Bun.env`. Injectable for tests. */
  source?: Record<string, string | undefined>
  /** Names to redact when the config is printed. Matched case-insensitively. */
  secrets?: readonly string[]
}

const SECRET_HINTS = ['secret', 'password', 'token', 'key', 'dsn', 'url', 'credential']

/**
 * Validates the environment against a schema and returns it typed.
 *
 * ```ts
 * export const env = defineEnv(t.Object({
 *   DATABASE_URL: t.String({ minLength: 1 }),
 *   PORT: t.Optional(t.Numeric({ default: 8000 })),
 *   SESSION_SECRET: t.String({ minLength: 32 }),
 *   NODE_ENV: t.Optional(t.Union([t.Literal('development'), t.Literal('production')])),
 * }))
 *
 * env.PORT  // number, guaranteed present
 * ```
 */
export function defineEnv<S extends TSchema>(schema: S, options: DefineEnvOptions = {}): Static<S> {
  const source = options.source ?? (Bun.env as Record<string, string | undefined>)

  // Only the keys the schema mentions, so unrelated variables can't trip
  // validation and secrets aren't pulled in by accident.
  const declared = Object.keys((schema as any).properties ?? {})
  const raw: Record<string, unknown> = {}
  for (const key of declared) {
    const value = source[key]
    if (value !== undefined && value !== '') raw[key] = value
  }

  const withDefaults = Value.Default(schema, raw)

  if (!Value.Check(schema, withDefaults)) {
    const problems = [...Value.Errors(schema, withDefaults)].map((issue) => {
      const name = issue.path.replace(/^\//, '') || '(root)'
      const present = source[name] !== undefined && source[name] !== ''
      return present ? `${name}: ${issue.message}` : `${name} is required but not set`
    })
    // Deduplicated: a union produces one error per branch, which is noise.
    throw new ConfigurationError([...new Set(problems)])
  }

  return Value.Decode(schema, withDefaults) as Static<S>
}

/** True when a name looks like it holds a secret. */
export function looksSecret(name: string, extra: readonly string[] = []): boolean {
  const lower = name.toLowerCase()
  return [...SECRET_HINTS, ...extra.map((entry) => entry.toLowerCase())].some((hint) => lower.includes(hint))
}

/**
 * A printable view of a config object with secret-looking values redacted.
 * For a startup banner, where showing a `DATABASE_URL` would leak a password.
 */
export function describeEnv(config: Record<string, unknown>, secrets: readonly string[] = []): Record<string, unknown> {
  const described: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(config)) {
    described[name] = looksSecret(name, secrets) && value ? '••••••••' : value
  }
  return described
}

/** Common shapes, so a project doesn't restate them. */
export const env = {
  string: (options?: Parameters<typeof t.String>[0]) => t.String({ minLength: 1, ...options }),
  number: (options?: Parameters<typeof t.Numeric>[0]) => t.Numeric(options),
  port: () => t.Numeric({ minimum: 1, maximum: 65_535 }),
  boolean: () => t.Union([t.Literal('true'), t.Literal('false')]),
  url: () => t.String({ format: 'uri' }),
  /** A secret with a minimum length, because a short one is worse than none. */
  secret: (minLength = 32) => t.String({ minLength }),
  oneOf: <const T extends readonly string[]>(...values: T) =>
    t.Union(values.map((value) => t.Literal(value)) as never),
}
