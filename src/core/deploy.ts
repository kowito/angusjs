/**
 * Deployment checks — `angus check --deploy`.
 *
 * Every one of these is a mistake that is invisible in development and
 * expensive in production: debug output leaking stack traces, an admin with no
 * authentication, cookies without `Secure`, SQLite on a machine with a
 * disposable filesystem.
 *
 * They are reported as findings rather than thrown, so CI can gate on the
 * severity it cares about and a developer can see the whole list at once.
 */

import { appModels } from './app.ts'
import { resolveSettings, type Settings } from './settings.ts'
import { projectRouter } from './project.ts'

export type Severity = 'error' | 'warning' | 'info'

export interface Finding {
  severity: Severity
  /** Stable identifier, so a project can silence one deliberately. */
  id: string
  message: string
  /** What to do about it. */
  hint?: string
}

export interface DeployCheckOptions {
  /** Findings to ignore, by id. */
  silence?: readonly string[]
  /** Treat the target as production even if NODE_ENV says otherwise. */
  production?: boolean
}

/**
 * Inspects settings for production hazards.
 *
 * Runs entirely against the configuration: no server is started and no
 * database is touched, so it is safe in CI.
 */
export function deployChecks(rawSettings: Settings, options: DeployCheckOptions = {}): Finding[] {
  const settings = resolveSettings(rawSettings)
  const production = options.production ?? Bun.env.NODE_ENV === 'production'
  const findings: Finding[] = []

  const add = (severity: Severity, id: string, message: string, hint?: string) =>
    findings.push({ severity, id, message, hint })

  // --- disclosure ----------------------------------------------------------

  if (settings.debug) {
    add(
      'error',
      'debug-enabled',
      'Debug mode is on, so 500 responses include the exception message and stack.',
      'Set NODE_ENV=production, or `debug: false` in settings.',
    )
  }

  // --- database ------------------------------------------------------------

  if (!settings.database) {
    add('error', 'no-database', 'No database is configured.', 'Add `database` to your settings.')
  } else if (settings.database.dialect === 'sqlite') {
    add(
      'warning',
      'sqlite-in-production',
      'SQLite is configured. It is a single file on local disk.',
      'Fine for a single instance with a persistent volume; use Postgres if you run more than one replica or your filesystem is ephemeral.',
    )
  }

  if (settings.database?.logging) {
    add(
      'warning',
      'query-logging',
      'Query logging is on, which prints every statement — including parameter values.',
      'Turn it off in production, or route it through a redacting logger.',
    )
  }

  // --- identity ------------------------------------------------------------

  const hasAuthApp = settings.apps.some((app) => app.name === 'auth' || app.name === 'admin-auth')

  if (hasAuthApp && !settings.authenticate) {
    add(
      'error',
      'auth-app-without-hook',
      'The auth app is installed but `authenticate` is not set, so nothing ever populates `context.user`.',
      "Add `authenticate` from 'angusjs/auth' to your settings.",
    )
  }

  // --- admin ---------------------------------------------------------------

  const adminApp = settings.apps.find((app) => app.meta?.admin === true)
  if (adminApp) {
    if (adminApp.meta?.guarded !== true) {
      add(
        'error',
        'admin-unguarded',
        'The admin is installed with no permissions configured.',
        'Pass `adminSite({ permissions: [isStaff] })`. Without it the admin either refuses to serve, or — if `insecureAllowUnauthenticated` is set, as a fresh scaffold does — serves every model with no authentication at all.',
      )
    }
  }

  // --- transport -----------------------------------------------------------

  const security = settings.security ?? {}

  if (security.headers === false) {
    add('warning', 'no-security-headers', 'Security response headers are disabled.', 'Remove `security.headers: false`.')
  }

  if (security.csrf === false) {
    add(
      'error',
      'csrf-disabled',
      'CSRF protection is disabled while cookie sessions are in use.',
      'Remove `security.csrf: false`, or stop authenticating with cookies.',
    )
  }

  if (security.cors?.origin === '*') {
    add(
      'warning',
      'cors-wildcard',
      'CORS allows every origin.',
      'List the origins you trust. (Credentials are already refused with a wildcard.)',
    )
  }

  // --- abuse ---------------------------------------------------------------

  if (settings.throttle === false) {
    add(
      'error',
      'throttle-disabled',
      'Rate limiting is disabled, so the login endpoint has no brute-force protection.',
      'Remove `throttle: false`.',
    )
  } else if (settings.throttle === undefined && !production) {
    add(
      'info',
      'throttle-default',
      'Rate limiting is enabled automatically in production only.',
      'Set `throttle: {}` to enable it everywhere, or configure limits explicitly.',
    )
  }

  if (settings.throttle && !settings.throttle.store) {
    add(
      'warning',
      'throttle-memory-store',
      'Rate limiting uses the in-memory store, which counts per process.',
      'With N replicas the effective limit is N times what you configured. Supply a shared store if you run more than one.',
    )
  }

  // --- agents --------------------------------------------------------------

  if (settings.mcp !== false) {
    const mcp = settings.mcp ?? {}
    if (!mcp.permissions?.length && !mcp.readOnly) {
      add(
        'info',
        'mcp-open',
        'The MCP endpoint is exposed with no endpoint-level permissions.',
        'Tools carry the same authority as the HTTP routes they wrap, so this is only a problem if those routes are open. Use `mcp: { readOnly: true }` or `permissions` to narrow it.',
      )
    }
  }

  // --- email ---------------------------------------------------------------

  const backendName = settings.email?.backend?.name
  if (!settings.email?.backend) {
    add(
      hasAuthApp ? 'error' : 'warning',
      'email-not-configured',
      'No email backend is configured, so messages print to stderr instead of being sent.' +
        (hasAuthApp ? ' Password reset will not reach anyone.' : ''),
      "Set `email: { backend: httpBackend({ apiKey: ... }), from: '...' }`.",
    )
  } else if (backendName === 'console' || backendName === 'memory' || backendName === 'null') {
    add(
      'error',
      'email-backend-not-sending',
      `The "${backendName}" email backend does not send anything.`,
      'Use a real backend in production.',
    )
  }

  if (settings.email?.backend && !settings.email.from) {
    add('warning', 'email-no-sender', 'No default sender is configured.', 'Set `email.from`.')
  }

  if (settings.cache?.store && settings.cache.store.name === 'memory') {
    add(
      'info',
      'cache-memory-store',
      'The cache uses the in-memory store, which is per process.',
      'Correct but wasteful across replicas: each keeps its own copy and an invalidation only clears one.',
    )
  }

  // --- observability -------------------------------------------------------

  if (settings.health === false) {
    add(
      'warning',
      'no-health-checks',
      'Health probes are disabled, so an orchestrator cannot tell whether this instance is serving.',
      'Remove `health: false`.',
    )
  }

  if (settings.observability === false) {
    add('info', 'no-request-logs', 'Request logging is disabled.', 'Remove `observability: false` to log one line per request.')
  }

  // --- routing sanity ------------------------------------------------------

  const seen = new Set<string>()
  for (const route of projectRouter(settings.apps, settings.prefix).flatten()) {
    const key = `${route.method} ${route.path}`
    if (seen.has(key)) {
      add('error', 'duplicate-route', `Duplicate route: ${key}`, 'Two apps are mounting the same path.')
    }
    seen.add(key)
  }

  const models = appModels(settings.apps)
  const tables = new Map<string, string>()
  for (const model of models) {
    const clash = tables.get(model.meta.tableName)
    if (clash) {
      add(
        'error',
        'duplicate-table',
        `Models "${clash}" and "${model.name}" both map to table "${model.meta.tableName}".`,
        'Set `meta.tableName` on one of them.',
      )
    }
    tables.set(model.meta.tableName, model.name)
  }

  const silenced = new Set(options.silence ?? [])
  return findings.filter((finding) => !silenced.has(finding.id))
}

/** Exit code convention: non-zero when anything is an error. */
export function hasBlockingFindings(findings: Finding[]): boolean {
  return findings.some((finding) => finding.severity === 'error')
}
