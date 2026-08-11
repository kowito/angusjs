/**
 * Request IDs, structured logging, and health probes.
 *
 * The one non-obvious decision: liveness and readiness are different questions
 * and must not share an endpoint.
 *
 * - **Liveness** asks "is this process wedged?" It must not touch the database.
 *   If it did, a database blip would make every replica fail liveness, the
 *   orchestrator would restart them all, and a recoverable outage becomes a
 *   total one.
 * - **Readiness** asks "should traffic come here *now*?" It does check the
 *   database, so an instance that can't serve is removed from the pool and
 *   put back when it recovers — without being killed.
 */

import { currentTraceId } from '../tracing.ts'
import { Elysia } from 'elysia'
import { getConnection, hasConnection } from '../db/connection.ts'
import { sql } from 'drizzle-orm'

export const REQUEST_ID_HEADER = 'x-request-id'

export interface RequestLogFields {
  requestId: string
  /** The active OpenTelemetry trace, when one is recording. */
  traceId?: string
  method: string
  path: string
  status: number
  durationMs: number
  userId?: string
  ip?: string
}

export interface ObservabilityOptions {
  /** Emit one structured line per request. Defaults to on. */
  requests?: boolean
  /** `json` for log collectors, `pretty` for a terminal. Defaults by TTY. */
  format?: 'json' | 'pretty'
  /** Paths never logged — health probes would otherwise dominate the output. */
  quietPaths?: readonly (string | RegExp)[]
  /** Replace the sink, e.g. to ship somewhere other than stdout. */
  log?: (fields: RequestLogFields) => void
  /** Also emit a warning above this duration, in milliseconds. */
  slowRequestMs?: number
}

function matches(path: string, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.some((pattern) =>
    typeof pattern === 'string' ? path === pattern || path.startsWith(pattern) : pattern.test(path),
  )
}

const STATUS_COLOUR = (status: number) =>
  status >= 500 ? '[31m' : status >= 400 ? '[33m' : '[32m'

/**
 * Adds a request id to every request and logs the outcome.
 *
 * An inbound `x-request-id` is honoured so a trace survives across services,
 * and it is echoed on the response so a user reporting a failure can quote an
 * id that appears in the logs.
 */
export function observability(options: ObservabilityOptions = {}): Elysia<any, any> {
  const enabled = options.requests !== false
  const pretty = (options.format ?? (Bun.enableANSIColors ? 'pretty' : 'json')) === 'pretty'
  const quiet = options.quietPaths ?? ['/healthz', '/readyz']
  const slowMs = options.slowRequestMs ?? 1000

  const emit =
    options.log ??
    ((fields: RequestLogFields) => {
      if (pretty) {
        const colour = STATUS_COLOUR(fields.status)
        console.log(
          `${colour}${fields.status}[0m ${fields.method.padEnd(6)} ${fields.path} ` +
            `[2m${fields.durationMs.toFixed(1)}ms ${fields.requestId}[0m`,
        )
      } else {
        console.log(JSON.stringify({ level: fields.status >= 500 ? 'error' : 'info', ...fields }))
      }
    })

  return new Elysia({ name: 'angus:observability' })
    .resolve({ as: 'global' }, ({ request, set }) => {
      const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID()
      ;(set.headers as Record<string, string>)[REQUEST_ID_HEADER] = requestId
      return { requestId, startedAt: performance.now() }
    })
    .onAfterResponse({ as: 'global' }, (context: Record<string, any>) => {
      if (!enabled) return

      const request = context.request as Request
      const path = new URL(request.url).pathname
      if (matches(path, quiet)) return

      const durationMs = performance.now() - (context.startedAt ?? performance.now())
      const status = Number(context.set?.status ?? 200)

      const fields: RequestLogFields = {
        requestId: context.requestId ?? '-',
        method: request.method,
        path,
        status: Number.isFinite(status) ? status : 200,
        durationMs: Number(durationMs.toFixed(2)),
      }

      const user = context.user as { id?: unknown } | undefined
      if (user?.id !== undefined) fields.userId = String(user.id)

      // Given a slow request in the log, this is how you find the span tree
      // that explains it. Without it you search by timestamp and hope.
      const traceId = currentTraceId()
      if (traceId) fields.traceId = traceId

      emit(fields)

      if (durationMs > slowMs) {
        console.warn(
          JSON.stringify({ level: 'warn', message: 'slow request', ...fields, thresholdMs: slowMs }),
        )
      }
    }) as unknown as Elysia<any, any>
}

// ---------------------------------------------------------------------------
// Health probes
// ---------------------------------------------------------------------------

export interface HealthOptions {
  livenessPath?: string
  readinessPath?: string
  /** Extra readiness checks — a cache, a queue, an upstream. */
  checks?: Record<string, () => Promise<boolean> | boolean>
  /** Reported in the body, useful for confirming what is deployed. */
  version?: string
}

/**
 * Confirms the database answers a trivial query.
 *
 * Branches on dialect on purpose. The bun-sqlite Drizzle driver has no
 * `execute`, so the previous `db.execute?.(…)` was `undefined`, `await
 * undefined` never threw, and the probe reported healthy without ever touching
 * the database — a broken or locked SQLite file stayed in the load-balancer
 * pool. Each dialect now runs a query that actually throws when it cannot reach
 * the database.
 */
async function databaseReachable(): Promise<boolean> {
  if (!hasConnection()) return false
  const connection = getConnection()
  try {
    if (connection.dialect === 'sqlite') {
      // Synchronous, and throws on a locked or corrupt database.
      connection.client.query('select 1').get()
    } else {
      await connection.db.execute(sql`select 1`)
    }
    return true
  } catch {
    return false
  }
}

export function health(options: HealthOptions = {}): Elysia<any, any> {
  const started = Date.now()

  return new Elysia({ name: 'angus:health' })
    // Liveness deliberately checks nothing external: see the note at the top.
    .get(options.livenessPath ?? '/healthz', () => ({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - started) / 1000),
      ...(options.version ? { version: options.version } : {}),
    }))
    .get(options.readinessPath ?? '/readyz', async ({ set }) => {
      const results: Record<string, boolean> = { database: await databaseReachable() }

      for (const [name, check] of Object.entries(options.checks ?? {})) {
        try {
          results[name] = await check()
        } catch {
          results[name] = false
        }
      }

      const ready = Object.values(results).every(Boolean)
      if (!ready) set.status = 503

      return { status: ready ? 'ready' : 'not-ready', checks: results }
    }) as unknown as Elysia<any, any>
}
