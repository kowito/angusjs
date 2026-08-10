/**
 * OpenTelemetry tracing.
 *
 * The question this answers is the one a slow request always raises: *where
 * did the time go?* The access log says a request took 900ms; it cannot say
 * that 850ms of it was one N+1 loop inside a service two calls down. Only a
 * trace spanning route → service → query can, and only if all three layers report
 * into the same span tree.
 *
 * This is a leaf module: it imports nothing else from Angus, which is what
 * lets `db` report spans without inverting the dependency direction the
 * architecture depends on.
 *
 * `@opentelemetry/api` is an optional peer dependency, loaded at startup and
 * only if present. That is deliberate: tracing is not something every
 * application wants, the API package pulls a real dependency tree behind it,
 * and the framework's claim to two runtime dependencies is worth keeping. With
 * the package absent every function here is a no-op that costs one branch.
 */

export interface TracingOptions {
  /** Service name reported on every span. Defaults to the OpenAPI title. */
  serviceName?: string
  /**
   * Record the SQL of each query as a span attribute.
   *
   * Off by default. Drizzle emits parameterised SQL, so the values are not in
   * the string — but table and column names still describe your schema to
   * whoever can read the traces, and that is a wider audience than the
   * database.
   */
  recordStatements?: boolean
  /** Turn tracing off without removing the configuration. Defaults to true. */
  enabled?: boolean
}

/**
 * Angus does not open a span for the HTTP request itself.
 *
 * Elysia's lifecycle hooks observe a request; they cannot wrap one, and a root
 * span has to wrap. The standard OpenTelemetry HTTP instrumentation already
 * does that job properly, and the spans here attach beneath whatever root is
 * active — which is the architecture's own rule applied to tracing: if the
 * platform solves it, integrate rather than rebuild.
 *
 * What Angus contributes is the middle and the bottom of the tree: the service
 * named in the application's vocabulary, and the queries it caused.
 */

/** The subset of the OTel API this uses, so the absence of it stays typed. */
interface Tracer {
  startActiveSpan<T>(name: string, options: unknown, fn: (span: Span) => T): T
}

interface Span {
  setAttribute(key: string, value: string | number | boolean): void
  setStatus(status: { code: number; message?: string }): void
  recordException(error: unknown): void
  end(): void
}

const STATUS_ERROR = 2

let tracer: Tracer | null = null
let options: TracingOptions = {}
let api: any = null

/**
 * Loads the OpenTelemetry API if the application has it installed.
 *
 * Returns whether tracing is active, so a caller can say so at startup rather
 * than leaving someone to wonder why their traces are empty — which is the
 * failure mode of every optional integration that fails quietly.
 */
export async function initTracing(config: TracingOptions = {}): Promise<boolean> {
  options = config

  if (config.enabled === false) {
    tracer = null
    return false
  }

  try {
    // The specifier is a variable so TypeScript does not try to resolve a
    // module that is legitimately absent. A static import would also make an
    // optional package mandatory at load time, whatever the settings say.
    const specifier = '@opentelemetry/api'
    api = (await import(/* @vite-ignore */ specifier)) as any
    tracer = api.trace.getTracer(config.serviceName ?? 'angus', undefined)
    return true
  } catch {
    // Not installed. The application asked for tracing and will not get it, so
    // this is worth a line rather than silence.
    if (config.enabled === true) {
      console.warn(
        '[angus] tracing is enabled but @opentelemetry/api is not installed. ' +
          'Run `bun add @opentelemetry/api` and configure an SDK, or set `tracing: false`.',
      )
    }
    api = null
    tracer = null
    return false
  }
}

/**
 * The active trace, for putting in a log line.
 *
 * This is what makes logs and traces usable together: given a slow request in
 * the log, the trace ID is how you find the span tree that explains it, and
 * without the correlation you are searching by timestamp and hoping.
 */
export function currentTraceId(): string | null {
  if (!api) return null

  const span = api.trace.getActiveSpan()
  const context = span?.spanContext?.()
  // An all-zero trace ID means no real trace is recording, which is worse than
  // no ID at all: it looks like a link and leads nowhere.
  return context?.traceId && !/^0+$/.test(context.traceId) ? context.traceId : null
}

export function tracingActive(): boolean {
  return tracer !== null
}

/** Mainly for tests, which need to put it back. */
export function _setTracer(next: Tracer | null): void {
  tracer = next
}

/**
 * Runs `fn` inside a span, or just runs it when tracing is off.
 *
 * The no-tracer path returns `fn()` directly rather than wrapping it, so an
 * application without OpenTelemetry pays one comparison and not a promise.
 */
export function trace<T>(name: string, attributes: Record<string, string | number | boolean>, fn: () => T): T {
  const active = tracer
  if (!active) return fn()

  return active.startActiveSpan(name, { attributes }, (span) => {
    let settled = false

    const fail = (error: unknown) => {
      span.recordException(error)
      span.setStatus({ code: STATUS_ERROR, message: error instanceof Error ? error.message : String(error) })
    }

    try {
      const result = fn()

      if (result instanceof Promise) {
        settled = true
        // Ending in `finally` rather than after `await` keeps the span open for
        // exactly as long as the work runs, including when it throws.
        return result.catch((error) => {
          fail(error)
          throw error
        }).finally(() => span.end()) as T
      }

      return result
    } catch (error) {
      fail(error)
      throw error
    } finally {
      if (!settled) span.end()
    }
  })
}

/**
 * Traces one database query.
 *
 * Named by operation and table rather than by SQL, because a trace UI groups
 * by span name — and every query having a distinct name makes the grouping
 * useless exactly when you need it.
 */
export function traceQuery<T>(operation: string, table: string, statement: string | undefined, fn: () => T): T {
  return trace(
    `db.${operation} ${table}`,
    {
      'db.system': 'sql',
      'db.operation': operation,
      'db.sql.table': table,
      ...(options.recordStatements && statement ? { 'db.statement': statement } : {}),
    },
    fn,
  )
}

/** Traces an application service, which is the layer between route and query. */
export function traceService<T>(name: string, fn: () => T): T {
  return trace(`service ${name}`, { 'angus.service': name }, fn)
}
