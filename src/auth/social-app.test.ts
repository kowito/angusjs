/**
 * The callback route end to end, with the provider stubbed. Each failure path
 * is a real attack or a real user experience: a forged state, a replayed
 * callback, a declined consent screen.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { authModels, User } from './models.ts'
import { providers } from './oauth.ts'
import { socialAuthRoutes } from './social-app.ts'
import { SESSION_COOKIE } from './app.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

const SECRET = 's'.repeat(32)

let db: TestDatabase
let app: Elysia<any, any>

/** A provider that talks to a local stub rather than the internet. */
const stubProvider = () => ({
  ...providers.github('client-id', 'client-secret'),
  name: 'stub',
  tokenEndpoint: 'http://127.0.0.1:1/token',
  userinfoEndpoint: 'http://127.0.0.1:1/user',
})

beforeAll(async () => {
  db = await testDatabase({ models: Object.values(authModels) })
  app = new Elysia().use(
    socialAuthRoutes({
      providers: [stubProvider()],
      secret: SECRET,
      baseUrl: 'https://app.example.com',
      secureCookies: false,
    }).toElysia(),
  )
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
})

const get = (path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://localhost${path}`, { headers, redirect: 'manual' }))

/** Pulls one Set-Cookie value out of a response. */
const cookieValue = (response: Response, name: string): string | null => {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const [pair] = header.split(';')
    const [key, ...rest] = pair!.split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

describe('starting the flow', () => {
  test('redirects to the provider and sets a flow cookie', async () => {
    const response = await get('/auth/stub')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('github.com/login/oauth/authorize')
    expect(cookieValue(response, 'angus_oauth_flow')).toBeTruthy()
  })

  test('the redirect URI is built from baseUrl, not the request host', async () => {
    // A proxy makes the request's own host something else entirely, and the
    // provider matches this string exactly.
    const location = (await get('/auth/stub')).headers.get('location')!
    const redirect = new URL(location).searchParams.get('redirect_uri')

    expect(redirect).toBe('https://app.example.com/auth/stub/callback')
  })

  test('a `next` is carried through the flow rather than the URL', async () => {
    // In the URL it would be attacker-editable between the two requests.
    const response = await get('/auth/stub?next=/dashboard')
    expect(new URL(response.headers.get('location')!).searchParams.get('next')).toBeNull()
    expect(cookieValue(response, 'angus_oauth_flow')).toBeTruthy()
  })

  test('the flow cookie is not readable by scripts', async () => {
    const header = (await get('/auth/stub')).headers.getSetCookie!()[0]!
    expect(header).toContain('HttpOnly')
    // Strict would withhold the cookie on the provider's cross-site callback.
    expect(header).toContain('SameSite=Lax')
  })

  test('providers are listed for a login page to render', async () => {
    expect(await (await get('/auth/providers')).json()).toEqual({ providers: ['stub'] })
  })
})

describe('the callback refuses what it should', () => {
  /** Starts a flow and returns the cookie header plus the issued state. */
  async function startFlow() {
    const response = await get('/auth/stub')
    const flow = cookieValue(response, 'angus_oauth_flow')!
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!
    return { cookie: `angus_oauth_flow=${encodeURIComponent(flow)}`, state }
  }

  test('a callback with no flow cookie is refused', async () => {
    const response = await get('/auth/stub/callback?code=x&state=y')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('error=expired')
  })

  test('a forged state is refused', async () => {
    // The attack: an attacker completes their login in your browser, binding
    // your session to their account.
    const { cookie } = await startFlow()
    const response = await get('/auth/stub/callback?code=x&state=not-the-state', { cookie })

    expect(response.headers.get('location')).toContain('error=state_mismatch')
  })

  test('a tampered flow cookie is refused', async () => {
    const response = await get('/auth/stub/callback?code=x&state=y', {
      cookie: 'angus_oauth_flow=eyJhbGciOiJIUzI1NiJ9.forged.signature',
    })

    expect(response.headers.get('location')).toContain('error=expired')
  })

  test("the provider's own error is passed on", async () => {
    // A declined consent screen is the common case, and it is not a failure.
    const response = await get('/auth/stub/callback?error=access_denied')
    expect(response.headers.get('location')).toContain('error=access_denied')
  })

  test('a callback with a valid state but no code is refused', async () => {
    const { cookie, state } = await startFlow()
    const response = await get(`/auth/stub/callback?state=${state}`, { cookie })

    expect(response.headers.get('location')).toContain('error=no_code')
  })

  test('the flow cookie is cleared on every failure', async () => {
    // Leaving a used one behind invites a replay against it.
    const { cookie } = await startFlow()
    const response = await get('/auth/stub/callback?code=x&state=wrong', { cookie })

    expect(response.headers.getSetCookie!().join()).toContain('angus_oauth_flow=;')
  })

  test('an unreachable provider fails without leaking the reason', async () => {
    const { cookie, state } = await startFlow()
    const response = await get(`/auth/stub/callback?code=real-code&state=${state}`, { cookie })

    // The token endpoint points at a closed port. The user learns it failed,
    // not what our network looks like.
    expect(response.headers.get('location')).toContain('error=provider_error')
    expect(await User.objects.count()).toBe(0)
  })

  test('no session cookie is issued on failure', async () => {
    const response = await get('/auth/stub/callback?code=x&state=y')
    expect(cookieValue(response, SESSION_COOKIE)).toBeNull()
  })
})

describe('configuration', () => {
  test('a short secret is refused at construction, not at first login', () => {
    expect(() =>
      socialAuthRoutes({ providers: [stubProvider()], secret: 'short', baseUrl: 'https://a' }),
    ).toThrow(/at least 32/)
  })
})
