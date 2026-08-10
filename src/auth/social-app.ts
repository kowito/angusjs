/**
 * The two routes a social login needs, plus the plumbing between them.
 *
 * `GET /auth/{provider}` sends the browser to the provider with PKCE, state and
 * a nonce. `GET /auth/{provider}/callback` checks all three, exchanges the code,
 * resolves the user and issues an ordinary Angus session.
 *
 * The session is the normal one, deliberately. A social login is a way of
 * *proving who you are*, not a different kind of session: once proven, the
 * result should be indistinguishable from a password login, so nothing
 * downstream has to care which route someone came in by.
 */

import { router, type Router } from '../routing/router.ts'
import { issueCredential } from './credentials.ts'
import {
  beginAuthorization,
  exchangeCode,
  fetchProfile,
  openFlowState,
  safeRedirect,
  sealFlowState,
  stateMatches,
  type ProviderConfig,
} from './oauth.ts'
import { resolveSocialUser, SocialLoginError, type SocialLoginOptions } from './social.ts'
import { SESSION_COOKIE } from './app.ts'

const FLOW_COOKIE = 'angus_oauth_flow'

export interface SocialAuthOptions extends SocialLoginOptions {
  /** Providers to expose, keyed by the URL segment they answer on. */
  providers: ProviderConfig[]
  /**
   * Signs the flow cookie. Must be at least 32 characters.
   *
   * Reuse of an application-wide secret is fine — this signs a five-minute
   * cookie, not anything durable.
   */
  secret: string
  /**
   * Absolute base URL of this application, used to build the redirect URI.
   *
   * Required and not inferred from the request: the redirect URI has to match
   * what is registered with the provider exactly, and a proxy can make the
   * request's own host something else entirely.
   */
  baseUrl: string
  /** Mount point. Defaults to `/auth`. */
  prefix?: string
  /** Where to land after a successful login. Defaults to `/`. */
  successRedirect?: string
  /** Where to send someone whose login failed. Defaults to `/login`. */
  failureRedirect?: string
  /** Session lifetime in seconds. Defaults to two weeks. */
  sessionTtlSeconds?: number
  secureCookies?: boolean
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: the callback is a cross-site GET from the
    // provider, and Strict would withhold the cookie exactly then.
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/**
 * Builds the social login routes.
 *
 * ```ts
 * socialAuthRoutes({
 *   providers: [providers.google(env.GOOGLE_ID, env.GOOGLE_SECRET)],
 *   secret: env.SECRET_KEY,
 *   baseUrl: 'https://app.example.com',
 * })
 * ```
 */
export function socialAuthRoutes(options: SocialAuthOptions): Router {
  const prefix = options.prefix ?? '/auth'
  const ttl = options.sessionTtlSeconds ?? 60 * 60 * 24 * 14
  const secure = options.secureCookies ?? Bun.env.NODE_ENV === 'production'
  const successRedirect = options.successRedirect ?? '/'
  const failureRedirect = options.failureRedirect ?? '/login'

  if (options.secret.length < 32) {
    throw new Error('socialAuthRoutes: `secret` must be at least 32 characters.')
  }

  const byName = new Map(options.providers.map((provider) => [provider.name, provider]))
  const routes = router()

  const redirectUriFor = (name: string) => `${options.baseUrl.replace(/\/$/, '')}${prefix}/${name}/callback`

  for (const provider of options.providers) {
    routes.get(
      `${prefix}/${provider.name}`,
      async (context) => {
        const next = (context.query as Record<string, unknown>)?.next
        const { url, flow } = await beginAuthorization(provider, redirectUriFor(provider.name), {
          next: typeof next === 'string' ? next : undefined,
        })

        context.set.status = 302
        context.set.headers.location = url
        // Five minutes: long enough to sign in at the provider, short enough
        // that a stolen cookie is rarely still usable.
        context.set.headers['set-cookie'] = cookie(FLOW_COOKIE, await sealFlowState(flow, options.secret), 300, secure)
        return null
      },
      {
        summary: `Sign in with ${provider.name}`,
        tags: ['auth'],
        name: `auth-${provider.name}`,
      },
    )

    routes.get(
      `${prefix}/${provider.name}/callback`,
      async (context) => {
        const query = (context.query ?? {}) as Record<string, string | undefined>

        const fail = (reason: string) => {
          context.set.status = 302
          context.set.headers.location = `${failureRedirect}?error=${encodeURIComponent(reason)}`
          // Always clear the flow cookie, whatever happened: leaving a used
          // one behind lets a replay be attempted against it.
          context.set.headers['set-cookie'] = cookie(FLOW_COOKIE, '', 0, secure)
          return null
        }

        // The provider itself refused — a declined consent screen, usually.
        if (query.error) return fail(query.error)

        const sealed = readCookie(context.request, FLOW_COOKIE)
        if (!sealed) return fail('expired')

        let flow
        try {
          flow = await openFlowState(sealed, options.secret)
        } catch {
          return fail('expired')
        }

        // Without this an attacker completes *their* login in *your* browser,
        // silently binding your session to their account.
        if (!stateMatches(query.state ?? null, flow.state)) return fail('state_mismatch')
        if (!query.code) return fail('no_code')

        try {
          const tokens = await exchangeCode(provider, query.code, redirectUriFor(provider.name), flow.verifier)
          const profile = await fetchProfile(provider, tokens, flow.nonce)
          const { user } = await resolveSocialUser(provider.name, profile, options)

          const credential = await issueCredential(user, { kind: 'session', ttlSeconds: ttl })

          context.set.status = 302
          context.set.headers.location = safeRedirect(flow.next, successRedirect)
          context.set.headers['set-cookie'] = [
            cookie(SESSION_COOKIE, credential.secret, ttl, secure),
            cookie(FLOW_COOKIE, '', 0, secure),
          ] as never
          return null
        } catch (error) {
          // A SocialLoginError is something the person can act on — an
          // unverified email, a deactivated account — so its reason travels
          // back. Anything else is ours, and says nothing beyond "failed".
          return fail(error instanceof SocialLoginError ? error.reason : 'provider_error')
        }
      },
      {
        summary: `${provider.name} sign-in callback`,
        tags: ['auth'],
        name: `auth-${provider.name}-callback`,
      },
    )
  }

  /** Which providers are configured, for a login page to render buttons from. */
  routes.get(
    `${prefix}/providers`,
    () => ({ providers: [...byName.keys()] }),
    { summary: 'Configured sign-in providers', tags: ['auth'], name: 'auth-providers' },
  )

  return routes
}
