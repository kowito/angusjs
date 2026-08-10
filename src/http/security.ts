/**
 * Security middleware: CSRF, response headers, and CORS.
 *
 * The CSRF model here is worth stating plainly, because it decides what is and
 * isn't checked:
 *
 * > CSRF is only possible with an **ambient** credential — one the browser
 * > attaches automatically. A cookie is ambient. An `Authorization` header is
 * > not: an attacker's page cannot make the browser add it.
 *
 * So requests carrying a bearer token are exempt, and cookie-authenticated
 * unsafe requests must prove same-origin. `SameSite=Lax` on the session cookie
 * already blocks the classic cross-site form POST; this is the second layer,
 * for older browsers, sibling subdomains, and anything that strips SameSite.
 */

import { Elysia } from 'elysia'
import { PermissionDenied } from './errors.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface CsrfOptions {
  /**
   * Origins allowed to make credentialed unsafe requests, beyond the server's
   * own. Use full origins (`https://app.example.com`), not bare hostnames.
   */
  trustedOrigins?: readonly string[]
  /** Paths exempt from the check, e.g. a webhook receiver. */
  exempt?: readonly (string | RegExp)[]
  /**
   * Header a client may send instead of proving origin, for cases where the
   * browser omits `Origin`. Presence is enough: an attacker's cross-origin
   * request cannot set a custom header without a successful CORS preflight.
   */
  headerName?: string
}

function isExempt(path: string, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.some((pattern) =>
    typeof pattern === 'string' ? path === pattern || path.startsWith(pattern) : pattern.test(path),
  )
}

/** True when the request carries a credential the browser attached by itself. */
function usesAmbientCredential(request: Request): boolean {
  if (request.headers.get('authorization')) return false
  return request.headers.get('cookie') !== null
}

function originAllowed(request: Request, trusted: readonly string[]): boolean {
  const origin = request.headers.get('origin')

  if (!origin) {
    // No Origin at all. Modern browsers always send it on unsafe requests, so
    // this is a non-browser client — which cannot be a CSRF victim. Fall back
    // to Sec-Fetch-Site when the browser provided it.
    const site = request.headers.get('sec-fetch-site')
    return site === null || site === 'same-origin' || site === 'none'
  }

  if (trusted.includes(origin)) return true

  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

/**
 * Rejects cross-site state-changing requests that rely on a cookie.
 *
 * ```ts
 * middleware: [csrf({ trustedOrigins: ['https://app.example.com'] })]
 * ```
 */
export function csrf(options: CsrfOptions = {}): Elysia<any, any> {
  const trusted = options.trustedOrigins ?? []
  const exempt = options.exempt ?? []
  const headerName = (options.headerName ?? 'x-csrf-token').toLowerCase()

  return new Elysia({ name: 'angus:csrf' }).onRequest(({ request }) => {
    if (SAFE_METHODS.has(request.method)) return
    if (!usesAmbientCredential(request)) return

    const path = new URL(request.url).pathname
    if (isExempt(path, exempt)) return

    if (request.headers.get(headerName)) return
    if (originAllowed(request, trusted)) return

    throw new PermissionDenied(
      'Cross-site request rejected. Send the request from an allowed origin, ' +
        'or authenticate with a bearer token instead of a cookie.',
    )
  }) as unknown as Elysia<any, any>
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

export interface SecurityHeaderOptions {
  /** `Strict-Transport-Security` max-age in seconds. 0 disables. Default 1 year. */
  hstsMaxAge?: number
  /** Adds `includeSubDomains` to HSTS. Default `true`. */
  hstsIncludeSubdomains?: boolean
  /** `Content-Security-Policy`. Defaults to a policy suited to a JSON API. */
  contentSecurityPolicy?: string | false
  /** `Referrer-Policy`. Default `strict-origin-when-cross-origin`. */
  referrerPolicy?: string
  /** `X-Frame-Options`. Default `DENY`. */
  frameOptions?: string | false
  /** Extra headers, or overrides. */
  headers?: Record<string, string>
}

/**
 * Sets the response headers a production deployment is expected to have.
 *
 * HSTS is only emitted over HTTPS — sending it on a plaintext response is
 * meaningless, and in development it would pin `localhost` to HTTPS in the
 * browser for a year, which is a genuinely painful thing to undo.
 */
export function securityHeaders(options: SecurityHeaderOptions = {}): Elysia<any, any> {
  const hstsMaxAge = options.hstsMaxAge ?? 31_536_000
  const csp =
    options.contentSecurityPolicy ??
    // Suited to JSON plus the server-rendered admin, which uses one inline
    // <style> block and no scripts at all.
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

  // Set before the handler runs, not after: Elysia builds the response from
  // `set` at that point, so a mutation in `onAfterHandle` or `mapResponse` is
  // silently dropped. Doing it here also means error responses carry the
  // headers, which is when they matter most.
  return new Elysia({ name: 'angus:security-headers' }).onRequest(({ request, set }) => {
    const headers = set.headers as Record<string, string>

    headers['x-content-type-options'] = 'nosniff'
    headers['referrer-policy'] = options.referrerPolicy ?? 'strict-origin-when-cross-origin'
    if (options.frameOptions !== false) headers['x-frame-options'] = options.frameOptions ?? 'DENY'
    if (csp !== false) headers['content-security-policy'] = csp

    if (hstsMaxAge > 0 && new URL(request.url).protocol === 'https:') {
      headers['strict-transport-security'] =
        `max-age=${hstsMaxAge}${options.hstsIncludeSubdomains === false ? '' : '; includeSubDomains'}`
    }

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers[name.toLowerCase()] = value
    }
  }) as unknown as Elysia<any, any>
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

export interface CorsOptions {
  /**
   * Allowed origins, or a predicate. `'*'` is accepted but **cannot be combined
   * with credentials** — the browser rejects that pairing, and allowing any
   * origin to send cookies would defeat the CSRF protection above.
   */
  origin: readonly string[] | '*' | ((origin: string) => boolean)
  methods?: readonly string[]
  allowedHeaders?: readonly string[]
  exposedHeaders?: readonly string[]
  /** Allows cookies and `Authorization` on cross-origin requests. */
  credentials?: boolean
  /** Preflight cache lifetime in seconds. Default 1 day. */
  maxAge?: number
}

export function cors(options: CorsOptions): Elysia<any, any> {
  if (options.origin === '*' && options.credentials) {
    throw new Error(
      'cors(): `origin: "*"` cannot be combined with `credentials: true`. ' +
        'Browsers reject that pairing, and it would let any site send a session cookie. ' +
        'List the origins you actually trust.',
    )
  }

  const methods = (options.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).join(', ')
  const allowedHeaders = (options.allowedHeaders ?? ['content-type', 'authorization', 'x-csrf-token']).join(', ')
  const maxAge = String(options.maxAge ?? 86_400)

  const resolve = (origin: string | null): string | null => {
    if (options.origin === '*') return '*'
    if (!origin) return null
    if (typeof options.origin === 'function') return options.origin(origin) ? origin : null
    return options.origin.includes(origin) ? origin : null
  }

  return new Elysia({ name: 'angus:cors' }).onRequest(({ request, set }) => {
    const allowed = resolve(request.headers.get('origin'))
    if (!allowed) return

    // A preflight is answered here and never reaches a route.
    if (request.method === 'OPTIONS') {
      const preflight: Record<string, string> = {
        'access-control-allow-origin': allowed,
        'access-control-allow-methods': methods,
        'access-control-allow-headers': allowedHeaders,
        'access-control-max-age': maxAge,
        vary: 'origin',
      }
      if (options.credentials) preflight['access-control-allow-credentials'] = 'true'
      return new Response(null, { status: 204, headers: preflight })
    }

    const headers = set.headers as Record<string, string>
    headers['access-control-allow-origin'] = allowed
    headers.vary = 'origin'
    if (options.credentials) headers['access-control-allow-credentials'] = 'true'
    if (options.exposedHeaders?.length) {
      headers['access-control-expose-headers'] = options.exposedHeaders.join(', ')
    }
  }) as unknown as Elysia<any, any>
}
