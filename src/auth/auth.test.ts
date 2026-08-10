/**
 * Identity and authorization, tested through the surfaces that consume them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { adminSite } from '../admin/site.ts'
import { createApp } from '../core/project.ts'
import { clientFor, testDatabase, type TestClient, type TestDatabase } from '../testing/index.ts'
import { adminAuthApp, authApp, authenticate, SESSION_COOKIE } from './app.ts'
import {
  createUser,
  hashPassword,
  issueCredential,
  resolveCredential,
  revokeAllSessions,
  setPassword,
  verifyPassword,
} from './credentials.ts'
import { authModels, Session, User } from './models.ts'
import { hasRole, hasScope, isStaff, isSuperuser } from './permissions.ts'

const admin = adminSite({ title: 'Test admin', permissions: [isStaff] })
admin.register(User, { listDisplay: ['id', 'email', 'isStaff'], searchFields: ['email'] })

const settings = {
  apps: [authApp({ allowRegistration: true, prefix: '/auth' }), adminAuthApp(), admin.app()],
  prefix: '/api',
  openapi: false as const,
  authenticate,
}

let db: TestDatabase
let client: TestClient
let root: TestClient

const password = 'correct-horse-battery'

beforeAll(async () => {
  db = await testDatabase({ models: Object.values(authModels) })
  const app = await createApp(settings, { connectDatabase: false })
  client = clientFor(app, { basePath: '/api' })
  root = clientFor(app)
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  await createUser({ email: 'ada@example.com', password, name: 'Ada' })
  await createUser({ email: 'staff@example.com', password, isStaff: true })
})

const login = async (email: string) => {
  const response = await client.post('/auth/login', { email, password })
  return response.body.token as string
}

describe('password hashing', () => {
  test('produces an argon2id hash that verifies', async () => {
    const hash = await hashPassword(password)
    expect(hash.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword(password, hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  test('hashes differ for the same password', async () => {
    expect(await hashPassword(password)).not.toBe(await hashPassword(password))
  })

  test('rejects a password that is too short', async () => {
    expect(hashPassword('short')).rejects.toThrow(/at least 8/)
  })

  test('an empty stored hash never verifies', async () => {
    expect(await verifyPassword('anything', '')).toBe(false)
  })
})

describe('credentials', () => {
  test('the secret is returned once and only its hash is stored', async () => {
    const user = await User.objects.get({ email: 'ada@example.com' })
    const { secret, session } = await issueCredential(user)

    expect(secret.length).toBeGreaterThan(30)
    expect(session.tokenHash).not.toBe(secret)
    // Nothing in the row can be replayed as a credential.
    expect(JSON.stringify(session)).not.toContain(secret)
  })

  test('resolves to the owning user', async () => {
    const user = await User.objects.get({ email: 'ada@example.com' })
    const { secret } = await issueCredential(user)
    expect((await resolveCredential(secret))?.user.id).toBe(user.id)
  })

  test('refuses an expired credential', async () => {
    const user = await User.objects.get({ email: 'ada@example.com' })
    const { secret } = await issueCredential(user, { ttlSeconds: -1 })
    expect(await resolveCredential(secret)).toBeNull()
  })

  test('refuses a revoked credential', async () => {
    const user = await User.objects.get({ email: 'ada@example.com' })
    const { secret, session } = await issueCredential(user)
    await Session.objects.filter({ id: session.id }).update({ revokedAt: new Date() })
    expect(await resolveCredential(secret)).toBeNull()
  })

  test('refuses a credential belonging to a deactivated user', async () => {
    const user = await User.objects.get({ email: 'ada@example.com' })
    const { secret } = await issueCredential(user)
    await User.objects.filter({ id: user.id }).update({ isActive: false })
    expect(await resolveCredential(secret)).toBeNull()
  })

  test('an unknown secret resolves to nothing', async () => {
    expect(await resolveCredential('not-a-real-secret')).toBeNull()
  })

  test('changing a password revokes existing sessions', async () => {
    const user = await User.objects.get({ email: 'ada@example.com' })
    const { secret } = await issueCredential(user)
    await setPassword(user.id, 'a-brand-new-password')
    expect(await resolveCredential(secret)).toBeNull()
  })

  test('revokeAllSessions can spare API tokens', async () => {
    const user = await User.objects.get({ email: 'ada@example.com' })
    const browser = await issueCredential(user, { kind: 'session' })
    const token = await issueCredential(user, { kind: 'token', ttlSeconds: null })

    await revokeAllSessions(user.id, { kind: 'session' })

    expect(await resolveCredential(browser.secret)).toBeNull()
    expect(await resolveCredential(token.secret)).not.toBeNull()
  })
})

describe('login', () => {
  test('returns a token, a cookie and the user', async () => {
    const response = await client.post('/auth/login', { email: 'ada@example.com', password })
    expect(response.status).toBe(200)
    expect(response.body.token).toBeString()
    expect(response.body.user.email).toBe('ada@example.com')
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  })

  test('never returns the password hash', async () => {
    const response = await client.post('/auth/login', { email: 'ada@example.com', password })
    expect(response.text).not.toContain('argon2')
    expect(response.body.user.passwordHash).toBeUndefined()
  })

  test('a wrong password and an unknown address give the same answer', async () => {
    const wrong = await client.post('/auth/login', { email: 'ada@example.com', password: 'nope-nope-nope' })
    const missing = await client.post('/auth/login', { email: 'nobody@example.com', password })

    expect(wrong.status).toBe(401)
    expect(missing.status).toBe(401)
    // Identical wording: anything else enumerates accounts.
    expect(wrong.body.detail).toBe(missing.body.detail)
  })

  test('a deactivated user cannot sign in', async () => {
    await User.objects.filter({ email: 'ada@example.com' }).update({ isActive: false })
    expect((await client.post('/auth/login', { email: 'ada@example.com', password })).status).toBe(401)
  })

  test('records the last login', async () => {
    await login('ada@example.com')
    expect((await User.objects.get({ email: 'ada@example.com' })).lastLoginAt).not.toBeNull()
  })
})

describe('authenticated requests', () => {
  test('a bearer token identifies the caller', async () => {
    const token = await login('ada@example.com')
    const response = await client.as(token).get('/auth/me')
    expect(response.status).toBe(200)
    expect(response.body.email).toBe('ada@example.com')
  })

  test('a session cookie identifies the caller too', async () => {
    const token = await login('ada@example.com')
    const response = await client.get('/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(response.status).toBe(200)
  })

  test('an anonymous request is refused', async () => {
    expect((await client.get('/auth/me')).status).toBe(401)
  })

  test('logout revokes the credential immediately', async () => {
    const token = await login('ada@example.com')
    const authed = client.as(token)

    expect((await authed.post('/auth/logout')).status).toBe(204)
    expect((await authed.get('/auth/me')).status).toBe(401)
  })
})

describe('API tokens', () => {
  test('are issued, listed without the secret, and revoked', async () => {
    const session = await login('ada@example.com')
    const authed = client.as(session)

    const issued = await authed.post('/auth/tokens', { label: 'CI', scopes: ['posts:read'] })
    expect(issued.status).toBe(201)
    const token = issued.body.token as string

    // The token works as a credential in its own right.
    expect((await client.as(token).get('/auth/me')).status).toBe(200)

    const listed = await authed.get('/auth/tokens')
    expect(listed.body[0].label).toBe('CI')
    expect(listed.text).not.toContain(token)

    expect((await authed.delete(`/auth/tokens/${listed.body[0].id}`)).status).toBe(204)
    expect((await client.as(token).get('/auth/me')).status).toBe(401)
  })

  test('one user cannot revoke another account token', async () => {
    const adaToken = await login('ada@example.com')
    const created = await client.as(adaToken).post('/auth/tokens', { label: 'ada-only' })
    const listed = await client.as(adaToken).get('/auth/tokens')

    const staffToken = await login('staff@example.com')
    const response = await client.as(staffToken).delete(`/auth/tokens/${listed.body[0].id}`)

    expect(response.status).toBe(404)
    expect((await client.as(created.body.token).get('/auth/me')).status).toBe(200)
  })
})

describe('password reset', () => {
  test('answers identically whether or not the address exists', async () => {
    const known = await client.post('/auth/password-reset', { email: 'ada@example.com' })
    const unknown = await client.post('/auth/password-reset', { email: 'nobody@example.com' })
    expect(known.body).toEqual(unknown.body)
  })

  test('a reset token sets a new password exactly once', async () => {
    let captured = ''
    const app = await createApp(
      {
        ...settings,
        apps: [authApp({ sendPasswordReset: ({ token }) => void (captured = token) })],
      },
      { connectDatabase: false },
    )
    const isolated = clientFor(app, { basePath: '/api' })

    await isolated.post('/auth/password-reset', { email: 'ada@example.com' })
    expect(captured).not.toBe('')

    const first = await isolated.post('/auth/password-reset/confirm', { token: captured, password: 'a-new-password' })
    expect(first.status).toBe(200)

    // Single use.
    const second = await isolated.post('/auth/password-reset/confirm', { token: captured, password: 'another-one' })
    expect(second.status).toBe(400)

    const user = await User.objects.get({ email: 'ada@example.com' })
    expect(await verifyPassword('a-new-password', user.passwordHash)).toBe(true)
  })
})

describe('permissions', () => {
  const contextFor = (user: unknown, extra: Record<string, unknown> = {}) => ({ user, ...extra }) as never

  test('isStaff admits staff and superusers', () => {
    expect(isStaff(contextFor({ isStaff: true }))).toBe(true)
    expect(isStaff(contextFor({ isSuperuser: true }))).toBe(true)
    expect(isStaff(contextFor({ isStaff: false }))).toBe(false)
    expect(isStaff(contextFor(null))).toBe(false)
  })

  test('hasRole matches any listed role, and a superuser bypasses', () => {
    expect(hasRole('editor')(contextFor({ roles: ['editor'] }))).toBe(true)
    expect(hasRole('editor')(contextFor({ roles: ['viewer'] }))).toBe(false)
    expect(hasRole('editor')(contextFor({ roles: [], isSuperuser: true }))).toBe(true)
  })

  test('hasScope restricts a credential below its user', () => {
    // An unscoped credential can do whatever the user can.
    expect(hasScope('posts:write')(contextFor({}, { identity: { scopes: [] } }))).toBe(true)
    expect(hasScope('posts:write')(contextFor({}, { identity: { scopes: ['posts:read'] } }))).toBe(false)
    expect(hasScope('posts:read')(contextFor({}, { identity: { scopes: ['posts:read'] } }))).toBe(true)
  })

  test('isSuperuser is narrower than isStaff', () => {
    expect(isSuperuser(contextFor({ isStaff: true }))).toBe(false)
    expect(isSuperuser(contextFor({ isSuperuser: true }))).toBe(true)
  })
})

describe('admin login', () => {
  test('the login page renders', async () => {
    const response = await root.get('/admin/login')
    expect(response.status).toBe(200)
    expect(response.text).toContain('name="password"')
  })

  test('signing in as staff sets a cookie and redirects to the admin', async () => {
    const response = await root.form('/admin/login', { email: 'staff@example.com', password })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/admin')
    expect(response.headers.get('set-cookie')).toContain(SESSION_COOKIE)
  })

  test('a non-staff account is refused', async () => {
    const response = await root.form('/admin/login', { email: 'ada@example.com', password })
    expect(response.status).toBe(401)
    expect(response.text).toContain('does not have access')
  })

  test('a wrong password is refused without saying which part was wrong', async () => {
    const response = await root.form('/admin/login', { email: 'staff@example.com', password: 'wrong-password' })
    expect(response.status).toBe(401)
    expect(response.text).toContain('Incorrect email address or password')
  })

  test('the admin refuses an anonymous visitor and admits staff', async () => {
    expect((await root.get('/admin')).status).toBe(401)

    const signIn = await root.form('/admin/login', { email: 'staff@example.com', password })
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!

    const allowed = await root.get('/admin', { headers: { cookie } })
    expect(allowed.status).toBe(200)
    expect(allowed.text).toContain('Test admin')
  })

  test('a signed-in non-staff user still cannot reach the admin', async () => {
    const token = await login('ada@example.com')
    expect((await root.get('/admin', { headers: { authorization: `Bearer ${token}` } })).status).toBe(403)
  })
})
