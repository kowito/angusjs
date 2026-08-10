/**
 * The production layer: CSRF, security headers, CORS, throttling, health
 * probes, request ids, typed configuration and the deployment audit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import { defineApp } from './core/app.ts'
import { deployChecks, hasBlockingFindings } from './core/deploy.ts'
import { ConfigurationError, defineEnv, describeEnv, env } from './core/env.ts'
import { createApp } from './core/project.ts'
import { REQUEST_ID_HEADER } from './core/observability.ts'
import { f } from './db/fields.ts'
import { defineModel } from './db/model.ts'
import { cors, csrf, securityHeaders } from './http/security.ts'
import { MemoryThrottleStore, throttle } from './http/throttle.ts'
import { router } from './routing/router.ts'
import { clientFor, testDatabase, type TestClient, type TestDatabase } from './testing/index.ts'

const Note = defineModel('prodNote', {
  fields: { body: f.char({ maxLength: 200 }) },
  meta: { tableName: 'prod_notes' },
})

const notes = defineApp({
  name: 'notes',
  prefix: '/',
  models: { Note },
  urls: router()
    .get('/notes', () => ({ ok: true }))
    .post('/notes', () => ({ created: true })),
})

const settings = { apps: [notes], prefix: '/api', openapi: false as const }

let db: TestDatabase
let client: TestClient

beforeAll(async () => {
  db = await testDatabase({ models: [Note] })
  client = clientFor(await createApp(settings, { connectDatabase: false }))
})

afterAll(async () => {
  await db.close()
})

describe('CSRF', () => {
  const app = new Elysia().use(csrf({ trustedOrigins: ['https://trusted.example'] })).post('/write', () => ({ ok: true }))

  const post = (headers: Record<string, string>) =>
    app.handle(new Request('http://test/write', { method: 'POST', headers }))

  test('a cookie-authenticated cross-origin write is rejected', async () => {
    const response = await post({ cookie: 'angus_session=abc', origin: 'https://evil.example' })
    expect(response.status).toBe(403)
  })

  test('the same write from the same origin is allowed', async () => {
    expect((await post({ cookie: 'angus_session=abc', origin: 'http://test' })).status).toBe(200)
  })

  test('a trusted origin is allowed', async () => {
    expect((await post({ cookie: 'angus_session=abc', origin: 'https://trusted.example' })).status).toBe(200)
  })

  test('a bearer token is exempt — it is not an ambient credential', async () => {
    // An attacker's page cannot make the browser attach an Authorization
    // header, so a bearer-authenticated request cannot be forged cross-site.
    const response = await post({ authorization: 'Bearer abc', origin: 'https://evil.example' })
    expect(response.status).toBe(200)
  })

  test('an unauthenticated write is not blocked', async () => {
    expect((await post({ origin: 'https://evil.example' })).status).toBe(200)
  })

  test('Sec-Fetch-Site is honoured when Origin is absent', async () => {
    expect((await post({ cookie: 'a=b', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post({ cookie: 'a=b', 'sec-fetch-site': 'same-origin' })).status).toBe(200)
  })

  test('a safe method is never blocked', async () => {
    const readOnly = new Elysia().use(csrf()).get('/read', () => ({ ok: true }))
    const response = await readOnly.handle(
      new Request('http://test/read', { headers: { cookie: 'a=b', origin: 'https://evil.example' } }),
    )
    expect(response.status).toBe(200)
  })
})

describe('security headers', () => {
  const app = new Elysia().use(securityHeaders()).get('/x', () => ({ ok: true }))

  test('sets the standard protective headers', async () => {
    const response = await app.handle(new Request('http://test/x'))
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  test('HSTS is omitted over plaintext', async () => {
    // Sending it over HTTP is meaningless, and in development it would pin
    // localhost to HTTPS in the browser for a year.
    const response = await app.handle(new Request('http://test/x'))
    expect(response.headers.get('strict-transport-security')).toBeNull()
  })

  test('HSTS is sent over HTTPS', async () => {
    const response = await app.handle(new Request('https://test/x'))
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000')
  })
})

describe('CORS', () => {
  test('refuses to combine a wildcard origin with credentials', () => {
    // The browser would reject it anyway, and it would let any site send a
    // session cookie — so this fails loudly at configuration time.
    expect(() => cors({ origin: '*', credentials: true })).toThrow(/cannot be combined/)
  })

  test('echoes an allowed origin and answers preflight', async () => {
    const app = new Elysia()
      .use(cors({ origin: ['https://app.example'], credentials: true }))
      .get('/x', () => ({ ok: true }))

    const allowed = await app.handle(new Request('http://test/x', { headers: { origin: 'https://app.example' } }))
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')

    const preflight = await app.handle(
      new Request('http://test/x', { method: 'OPTIONS', headers: { origin: 'https://app.example' } }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
  })

  test('an unlisted origin gets no CORS headers', async () => {
    const app = new Elysia().use(cors({ origin: ['https://app.example'] })).get('/x', () => ({ ok: true }))
    const response = await app.handle(new Request('http://test/x', { headers: { origin: 'https://other.example' } }))
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('throttling', () => {
  test('allows up to the limit then returns 429 with Retry-After', async () => {
    const app = new Elysia()
      .use(throttle({ limit: 3, windowSeconds: 60, store: new MemoryThrottleStore() }))
      .get('/x', () => ({ ok: true }))

    const statuses: number[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      statuses.push((await app.handle(new Request('http://test/x'))).status)
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
    expect(statuses.slice(3)).toEqual([429, 429])

    const limited = await app.handle(new Request('http://test/x'))
    expect(limited.headers.get('retry-after')).toBeString()
    expect(limited.headers.get('x-ratelimit-limit')).toBe('3')
  })

  test('reports remaining quota', async () => {
    const app = new Elysia()
      .use(throttle({ limit: 5, windowSeconds: 60, store: new MemoryThrottleStore() }))
      .get('/x', () => ({ ok: true }))

    const first = await app.handle(new Request('http://test/x'))
    expect(first.headers.get('x-ratelimit-remaining')).toBe('4')
  })

  test('a tighter rule overrides the default for its path', async () => {
    const app = new Elysia()
      .use(
        throttle({
          limit: 100,
          windowSeconds: 60,
          store: new MemoryThrottleStore(),
          rules: [{ path: '/login', limit: 1, windowSeconds: 60 }],
        }),
      )
      .get('/login', () => ({ ok: true }))
      .get('/other', () => ({ ok: true }))

    expect((await app.handle(new Request('http://test/login'))).status).toBe(200)
    expect((await app.handle(new Request('http://test/login'))).status).toBe(429)
    // The tighter rule is scoped to its own path.
    expect((await app.handle(new Request('http://test/other'))).status).toBe(200)
  })

  test('exempt paths are never limited', async () => {
    const app = new Elysia()
      .use(throttle({ limit: 1, windowSeconds: 60, store: new MemoryThrottleStore(), exempt: ['/healthz'] }))
      .get('/healthz', () => ({ ok: true }))

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await app.handle(new Request('http://test/healthz'))).status).toBe(200)
    }
  })

  test('the memory store expires its counters', () => {
    const store = new MemoryThrottleStore()
    expect(store.hit('k', 2, 1).allowed).toBe(true)
    expect(store.hit('k', 2, 1).allowed).toBe(true)
    expect(store.hit('k', 2, 1).allowed).toBe(false)

    store.reset('k')
    expect(store.hit('k', 2, 1).allowed).toBe(true)
  })

  test('rate limiting stays off in development so it cannot lock a developer out', async () => {
    // Five login attempts per five minutes is right against credential
    // stuffing and wrong while building the login form.
    for (let attempt = 0; attempt < 12; attempt++) {
      expect((await client.get('/api/notes')).status).toBe(200)
    }
  })
})

describe('health probes', () => {
  test('liveness answers without touching the database', async () => {
    const response = await client.get('/healthz')
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
    expect(response.body.uptimeSeconds).toBeNumber()
  })

  test('readiness reports the database check', async () => {
    const response = await client.get('/readyz')
    expect(response.status).toBe(200)
    expect(response.body.checks.database).toBe(true)
  })

  test('readiness returns 503 when a custom check fails', async () => {
    const app = await createApp(
      { ...settings, health: { checks: { queue: () => false } } },
      { connectDatabase: false },
    )
    const response = await clientFor(app).get('/readyz')
    expect(response.status).toBe(503)
    expect(response.body.status).toBe('not-ready')
    expect(response.body.checks.queue).toBe(false)
  })
})

describe('request ids', () => {
  test('every response carries one', async () => {
    const response = await client.get('/api/notes')
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeString()
  })

  test('an inbound id is preserved, so a trace survives across services', async () => {
    const response = await client.get('/api/notes', { headers: { [REQUEST_ID_HEADER]: 'trace-abc-123' } })
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('trace-abc-123')
  })
})

describe('typed configuration', () => {
  const schema = t.Object({
    DATABASE_URL: env.string(),
    PORT: t.Optional(env.port()),
    SESSION_SECRET: env.secret(16),
  })

  test('parses and coerces a valid environment', () => {
    const config = defineEnv(schema, {
      source: { DATABASE_URL: 'postgres://x', PORT: '8080', SESSION_SECRET: 'x'.repeat(16) },
    })
    expect(config.DATABASE_URL).toBe('postgres://x')
    expect(config.PORT).toBe(8080)
    expect(typeof config.PORT).toBe('number')
  })

  test('names every missing variable at once, not one per restart', () => {
    let error: ConfigurationError | undefined
    try {
      defineEnv(schema, { source: {} })
    } catch (caught) {
      error = caught as ConfigurationError
    }

    expect(error).toBeInstanceOf(ConfigurationError)
    expect(error!.problems.join('\n')).toContain('DATABASE_URL is required')
    expect(error!.problems.join('\n')).toContain('SESSION_SECRET is required')
  })

  test('rejects a value that is present but invalid', () => {
    expect(() =>
      defineEnv(schema, { source: { DATABASE_URL: 'x', SESSION_SECRET: 'too-short' } }),
    ).toThrow(/SESSION_SECRET/)
  })

  test('an empty string counts as unset', () => {
    expect(() => defineEnv(schema, { source: { DATABASE_URL: '', SESSION_SECRET: 'x'.repeat(16) } })).toThrow(
      /DATABASE_URL is required/,
    )
  })

  test('describeEnv redacts anything that looks like a secret', () => {
    const described = describeEnv({ DATABASE_URL: 'postgres://user:pw@h/db', PORT: 8080, APP_NAME: 'demo' })
    expect(described.DATABASE_URL).toBe('••••••••')
    expect(described.PORT).toBe(8080)
    expect(described.APP_NAME).toBe('demo')
  })
})

describe('deployment audit', () => {
  test('flags debug mode as an error', () => {
    const findings = deployChecks({ ...settings, debug: true })
    expect(findings.some((finding) => finding.id === 'debug-enabled' && finding.severity === 'error')).toBe(true)
    expect(hasBlockingFindings(findings)).toBe(true)
  })

  test('flags an admin with no permissions', async () => {
    const { adminSite } = await import('./admin/site.ts')
    const site = adminSite({ path: '/audit-admin' })
    site.register(Note)

    const findings = deployChecks({ ...settings, debug: false, apps: [notes, site.app('admin')] })
    expect(findings.some((finding) => finding.id === 'admin-unguarded')).toBe(true)
  })

  test('flags disabled CSRF and disabled throttling as errors', () => {
    const findings = deployChecks({
      ...settings,
      debug: false,
      security: { csrf: false },
      throttle: false,
    })
    const ids = findings.map((finding) => finding.id)
    expect(ids).toContain('csrf-disabled')
    expect(ids).toContain('throttle-disabled')
  })

  test('warns about SQLite and the in-memory throttle store', () => {
    const findings = deployChecks({
      ...settings,
      debug: false,
      database: { dialect: 'sqlite', url: 'db.sqlite' },
      throttle: {},
    })
    const ids = findings.map((finding) => finding.id)
    expect(ids).toContain('sqlite-in-production')
    // Per-process counters mean N replicas allow N times the limit.
    expect(ids).toContain('throttle-memory-store')
  })

  test('flags the auth app installed without an authenticate hook', async () => {
    const { authApp } = await import('./auth/app.ts')
    const findings = deployChecks({ ...settings, debug: false, apps: [notes, authApp()] })
    expect(findings.some((finding) => finding.id === 'auth-app-without-hook' && finding.severity === 'error')).toBe(true)
  })

  test('a clean configuration produces no errors', () => {
    const findings = deployChecks({
      ...settings,
      debug: false,
      database: { dialect: 'postgres', url: 'postgres://x' },
      throttle: { store: new MemoryThrottleStore() },
      mcp: { readOnly: true },
    })
    expect(hasBlockingFindings(findings)).toBe(false)
  })

  test('a finding can be silenced by id', () => {
    const findings = deployChecks({ ...settings, debug: true }, { silence: ['debug-enabled'] })
    expect(findings.some((finding) => finding.id === 'debug-enabled')).toBe(false)
  })
})
