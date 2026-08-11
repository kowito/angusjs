/**
 * The auth app: an `authenticate` hook, the endpoints, and a login page.
 *
 * A credential can arrive two ways and both resolve to the same identity, which
 * is why the admin and the API can share one permission model:
 *
 *   Authorization: Bearer <secret>   ->  API clients, agents
 *   Cookie: angus_session=<secret>   ->  browsers, the admin
 */

import { t } from 'elysia'
import { defineApp, type AngusApp } from '../core/app.ts'
import { BadRequest, NotFound, Unauthorized } from '../http/errors.ts'
import { router, type Context, type Permission } from '../routing/router.ts'
import { view } from '../routing/view.ts'
import { serializer } from '../serializers/index.ts'
import { html, page, seeOther, esc } from '../html.ts'
import { STYLES } from '../admin/render.ts'
import {
  authenticate as verifyCredentials,
  consumeVerificationToken,
  createUser,
  issueCredential,
  issueVerificationToken,
  resolveCredential,
  revokeSession,
  setPassword,
  touchSession,
} from './credentials.ts'
import { passwordResetEmail, sendEmail } from '../email/index.ts'
import { isAuthenticated } from './permissions.ts'
import { Session, User } from './models.ts'

export const SESSION_COOKIE = 'angus_session'

export const UserSerializer = serializer(User, {
  name: 'User',
  // The hash must never leave the process, so it is excluded rather than
  // marked read-only — read-only fields still appear in responses.
  exclude: ['passwordHash'],
  readOnly: ['id', 'isStaff', 'isSuperuser', 'roles', 'emailVerifiedAt', 'lastLoginAt', 'createdAt', 'updatedAt'],
})

// ---------------------------------------------------------------------------
// Reading a credential off a request
// ---------------------------------------------------------------------------

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

export function credentialFrom(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  return readCookie(request, SESSION_COOKIE)
}

/**
 * The project's `authenticate` hook. Put it in settings and every surface gets
 * `context.user` and `context.identity`.
 *
 * ```ts
 * export default defineSettings({ authenticate, apps: [authApp()] })
 * ```
 */
export async function authenticate(context: Context): Promise<unknown> {
  const secret = credentialFrom(context.request as Request)
  if (!secret) return null

  const resolved = await resolveCredential(secret)
  if (!resolved) return null

  void touchSession(resolved.session)

  // `identity` carries the credential; `user` is what permissions read.
  ;(context as Record<string, unknown>).identity = {
    user: resolved.user,
    session: resolved.session,
    scopes: resolved.session.scopes ?? [],
  }

  return resolved.user
}

/**
 * Whether a request arrived over HTTPS.
 *
 * The correct source for the cookie `Secure` flag — a cookie should be Secure
 * exactly when the connection carrying it is encrypted, on every deploy,
 * without consulting `NODE_ENV`. An unset variable on a TLS deploy would
 * otherwise ship the session token without `Secure`, so any plaintext hop
 * exposes it. Honours `x-forwarded-proto` for the common TLS-terminating proxy.
 */
export function isSecureRequest(request: Request | undefined): boolean {
  const forwarded = request?.headers.get('x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0]!.trim() === 'https'
  try {
    return request ? new URL(request.url).protocol === 'https:' : false
  } catch {
    return false
  }
}

function sessionCookie(secret: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(secret)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

const clearedCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AuthAppOptions {
  /** Mount point for the API endpoints. Defaults to `/auth`. */
  prefix?: string
  /** Allow self-service registration. Defaults to `false` — opt in deliberately. */
  allowRegistration?: boolean
  /** Session lifetime in seconds. Defaults to two weeks. */
  sessionTtlSeconds?: number
  /** Force the cookie `Secure` flag. Defaults to following the request scheme — Secure over HTTPS, not over local HTTP. */
  secureCookies?: boolean
  /**
   * Overrides delivery of the reset link. By default the configured email
   * backend sends the built-in template, so this is only needed for a custom
   * message or a different channel.
   */
  sendPasswordReset?: (input: { user: { id: number; email: string }; token: string; url: string }) => Promise<void> | void
  /**
   * Where the reset link points. `{token}` is substituted.
   * Defaults to `<siteUrl>/reset-password?token={token}`.
   */
  passwordResetUrl?: string
  /** Absolute base URL, used to build links in emails. */
  siteUrl?: string
  /** Product name, shown in emails. */
  siteName?: string
  /** Where the admin login form redirects after success. Defaults to `/admin`. */
  adminPath?: string
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

export function authApp(options: AuthAppOptions = {}): AngusApp {
  const prefix = options.prefix ?? '/auth'
  const ttl = options.sessionTtlSeconds ?? 60 * 60 * 24 * 14
  const secureFor = (request: Request | undefined) => options.secureCookies ?? isSecureRequest(request)
  const adminPath = options.adminPath ?? '/admin'

  const credentials = t.Object({
    email: t.String({ format: 'email' }),
    password: t.String({ minLength: 8 }),
  })

  const routes = router()

  // --- session lifecycle ---------------------------------------------------

  routes.post(
    '/login',
    view({
      body: credentials,
      response: t.Object({ token: t.String(), user: UserSerializer.read }),
      summary: 'Sign in with an email and password',
      name: 'auth-login',
      tags: ['auth'],
      async handler({ body, set, request }) {
        const user = await verifyCredentials(body.email, body.password)
        // One message for every failure: distinguishing them enumerates accounts.
        if (!user) throw new Unauthorized('Incorrect email address or password.')

        const { secret } = await issueCredential(user, { kind: 'session', ttlSeconds: ttl })
        set.headers['set-cookie'] = sessionCookie(secret, ttl, secureFor(request))

        return { token: secret, user: await UserSerializer.toRepresentation(user) }
      },
    }),
  )

  routes.post(
    '/logout',
    view({
      summary: 'Revoke the current credential',
      name: 'auth-logout',
      tags: ['auth'],
      permissions: [isAuthenticated],
      async handler(context) {
        const identity = context.identity as { session: { id: number } } | undefined
        if (identity) await revokeSession(identity.session.id)
        context.set.headers['set-cookie'] = clearedCookie
        context.set.status = 204
        return null
      },
    }),
  )

  routes.get(
    '/me',
    view({
      response: UserSerializer.read,
      summary: 'The signed-in user',
      name: 'auth-me',
      tags: ['auth'],
      permissions: [isAuthenticated],
      handler: ({ user }) => UserSerializer.toRepresentation(user as never),
    }),
  )

  if (options.allowRegistration) {
    routes.post(
      '/register',
      view({
        body: t.Object({
          email: t.String({ format: 'email' }),
          password: t.String({ minLength: 8 }),
          name: t.Optional(t.String({ maxLength: 150 })),
        }),
        response: { 201: t.Object({ token: t.String(), user: UserSerializer.read }) },
        summary: 'Create an account',
        name: 'auth-register',
        tags: ['auth'],
        async handler({ body, set, request }) {
          const existing = await User.objects.getOrNull({ email: body.email.trim().toLowerCase() })
          if (existing) throw new BadRequest('That email address is already registered.')

          const user = await createUser({ email: body.email, password: body.password, name: body.name })
          const { secret } = await issueCredential(user, { kind: 'session', ttlSeconds: ttl })
          set.headers['set-cookie'] = sessionCookie(secret, ttl, secureFor(request))
          set.status = 201

          return { token: secret, user: await UserSerializer.toRepresentation(user) }
        },
      }),
    )
  }

  // --- API tokens ----------------------------------------------------------

  routes.post(
    '/tokens',
    view({
      body: t.Object({
        label: t.String({ maxLength: 100 }),
        scopes: t.Optional(t.Array(t.String())),
        expiresInDays: t.Optional(t.Numeric({ minimum: 1 })),
      }),
      response: { 201: t.Object({ token: t.String(), label: t.String(), scopes: t.Array(t.String()) }) },
      summary: 'Issue an API token',
      description: 'The token is shown once and cannot be retrieved again.',
      name: 'auth-token-create',
      tags: ['auth'],
      permissions: [isAuthenticated],
      async handler({ body, user, set }) {
        const { secret, session } = await issueCredential(user as never, {
          kind: 'token',
          label: body.label,
          scopes: body.scopes ?? [],
          ttlSeconds: body.expiresInDays ? body.expiresInDays * 86_400 : null,
        })
        set.status = 201
        return { token: secret, label: session.label, scopes: session.scopes ?? [] }
      },
    }),
  )

  routes.get(
    '/tokens',
    view({
      summary: 'List your API tokens',
      name: 'auth-token-list',
      tags: ['auth'],
      permissions: [isAuthenticated],
      async handler({ user }) {
        const rows = await Session.objects
          .filter({ user: (user as { id: number }).id, kind: 'token', revokedAt__isnull: true })
          .orderBy('-createdAt')
        // The secret is not stored, so it cannot appear here.
        return rows.map((row) => ({
          id: row.id,
          label: row.label,
          scopes: row.scopes,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        }))
      },
    }),
  )

  routes.delete(
    '/tokens/:id',
    view({
      params: t.Object({ id: t.Numeric() }),
      summary: 'Revoke an API token',
      name: 'auth-token-revoke',
      tags: ['auth'],
      permissions: [isAuthenticated],
      async handler({ params, user, set }) {
        const owned = await Session.objects.getOrNull({ id: params.id, user: (user as { id: number }).id } as never)
        if (!owned) throw new NotFound('No such token.')
        await revokeSession(owned.id)
        set.status = 204
        return null
      },
    }),
  )

  // --- password reset ------------------------------------------------------

  routes.post(
    '/password-reset',
    view({
      body: t.Object({ email: t.String({ format: 'email' }) }),
      summary: 'Request a password reset link',
      name: 'auth-password-reset',
      tags: ['auth'],
      async handler({ body }) {
        const user = await User.objects.getOrNull({ email: body.email.trim().toLowerCase() })

        if (user?.isActive) {
          const token = await issueVerificationToken(user.id, 'password-reset')
          const base = options.siteUrl ?? Bun.env.SITE_URL ?? ''
          const url = (options.passwordResetUrl ?? `${base}/reset-password?token={token}`).replace(
            '{token}',
            encodeURIComponent(token),
          )

          if (options.sendPasswordReset) {
            await options.sendPasswordReset({ user: { id: user.id, email: user.email }, token, url })
          } else {
            const template = passwordResetEmail({ resetUrl: url, siteName: options.siteName })
            // Failures are logged, not surfaced: telling the caller that
            // delivery failed for *this* address confirms the account exists.
            await sendEmail({ to: user.email, ...template }).catch((error) => {
              console.error('angus auth: could not send the password reset email.', error)
            })
          }
        }

        // Always the same answer, whether or not the address exists.
        return { detail: 'If that address has an account, a reset link is on its way.' }
      },
    }),
  )

  routes.post(
    '/password-reset/confirm',
    view({
      body: t.Object({ token: t.String(), password: t.String({ minLength: 8 }) }),
      summary: 'Set a new password using a reset token',
      name: 'auth-password-reset-confirm',
      tags: ['auth'],
      async handler({ body }) {
        const user = await consumeVerificationToken(body.token, 'password-reset')
        if (!user) throw new BadRequest('That reset link is invalid or has expired.')

        // Also revokes existing sessions, so a stolen one dies with the change.
        await setPassword(user.id, body.password)
        return { detail: 'Password updated. Please sign in again.' }
      },
    }),
  )

  routes.post(
    '/password',
    view({
      body: t.Object({ currentPassword: t.String(), password: t.String({ minLength: 8 }) }),
      summary: 'Change your password',
      name: 'auth-password-change',
      tags: ['auth'],
      permissions: [isAuthenticated],
      async handler({ body, user, set }) {
        const current = user as { id: number; email: string }
        const verified = await verifyCredentials(current.email, body.currentPassword)
        if (!verified) throw new BadRequest('Your current password is incorrect.')

        await setPassword(current.id, body.password)
        set.headers['set-cookie'] = clearedCookie
        return { detail: 'Password updated. Please sign in again.' }
      },
    }),
  )

  return defineApp({
    name: 'auth',
    prefix,
    models: { User, Session },
    urls: routes,
  })
}

/**
 * The admin's sign-in page.
 *
 * A separate app because it must mount at the absolute admin path — `/admin/login`
 * — whereas the API endpoints live under the auth app's own prefix. Register both:
 *
 * ```ts
 * apps: [authApp(), adminAuthApp(), admin.app()]
 * ```
 */
export function adminAuthApp(options: AuthAppOptions = {}): AngusApp {
  const ttl = options.sessionTtlSeconds ?? 60 * 60 * 24 * 14
  const secureFor = (request: Request | undefined) => options.secureCookies ?? isSecureRequest(request)
  const adminPath = options.adminPath ?? '/admin'
  const routes = router()

  // --- admin login page ----------------------------------------------------

  const loginPage = (error?: string, email = '') =>
    page(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Sign in</title>
<style>${STYLES}
main.signin { max-width: 380px; margin: 12vh auto; padding: 0 20px; }
main.signin h1 { font-size: 20px; margin: 0 0 4px; }
main.signin p.sub { color: var(--muted); margin: 0 0 20px; }
</style></head><body>
<main class="signin">${
        html`<h1>Sign in</h1>
          <p class="sub">Administration</p>
          ${error ? html`<div class="alert error">${error}</div>` : ''}
          <form method="post" class="card">
            <div class="field">
              <label for="id_email">Email</label>
              <input type="email" id="id_email" name="email" value="${email}" required autofocus>
            </div>
            <div class="field">
              <label for="id_password">Password</label>
              <input type="password" id="id_password" name="password" required>
            </div>
            <div class="actions"><button type="submit" class="primary">Sign in</button></div>
          </form>`.value
      }</main></body></html>`,
      error ? 401 : 200,
    )

  routes.get(`/login`, () => loginPage(), { hidden: true, name: 'admin-login' })

  routes.post(
    `/login`,
    async (context: Context) => {
      const request = context.request as Request
      // Same-origin only: this form sets a session cookie.
      const site = request.headers.get('sec-fetch-site')
      if (site && site !== 'same-origin' && site !== 'none') {
        return loginPage('Cross-site sign-in is not allowed.')
      }

      const body = (context.body ?? {}) as Record<string, string>
      const user = await verifyCredentials(body.email ?? '', body.password ?? '')

      if (!user) return loginPage('Incorrect email address or password.', body.email ?? '')
      if (!user.isStaff && !user.isSuperuser) {
        return loginPage('That account does not have access to the admin.', body.email ?? '')
      }

      const { secret } = await issueCredential(user, { kind: 'session', ttlSeconds: ttl })
      const response = seeOther(adminPath)
      response.headers.set('set-cookie', sessionCookie(secret, ttl, secureFor(request)))
      return response
    },
    { hidden: true, name: 'admin-login-submit' },
  )

  routes.get(
    `/logout`,
    async (context: Context) => {
      const identity = context.identity as { session: { id: number } } | undefined
      if (identity) await revokeSession(identity.session.id)
      const response = seeOther(`${adminPath}/login`)
      response.headers.set('set-cookie', clearedCookie)
      return response
    },
    { hidden: true, name: 'admin-logout' },
  )

  void esc

  return defineApp({ name: 'admin-auth', prefix: adminPath, absolutePrefix: true, urls: routes })
}

/**
 * Redirects an anonymous browser to the login page instead of returning 403.
 * Pass it to `adminSite({ permissions })` together with `isStaff`.
 */
export function redirectToLogin(adminPath = '/admin'): Permission {
  return (context) => {
    if (context.user) return true
    // Throwing a Response is how a permission short-circuits with a redirect.
    throw seeOther(`${adminPath}/login`)
  }
}
