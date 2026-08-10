/**
 * Sign in with an external provider — OAuth 2.0 authorization code flow, and
 * OpenID Connect on top of it.
 *
 * The flow is short and every step of it exists to stop a specific attack, so
 * none of them are optional here:
 *
 * - **PKCE** stops an intercepted authorization code being redeemed by whoever
 *   intercepted it. Mandatory, including for confidential clients — the cost is
 *   one hash and the failure it prevents is complete account takeover.
 * - **`state`** stops an attacker completing *their* login in *your* browser,
 *   which silently binds your session to their account.
 * - **`nonce`** ties an OIDC ID token to the request that asked for it, so a
 *   token captured elsewhere cannot be replayed into your callback.
 *
 * The state, verifier and nonce live in a signed, short-lived cookie rather
 * than server state, so the flow survives a restart and needs no shared store
 * across instances.
 *
 * The other rule this enforces: an email address from a provider is only
 * trusted when the provider says it is verified. Matching an unverified email
 * to an existing account is account takeover by registration — sign up at the
 * provider with someone else's address, and log in as them.
 */

import { signJwt, verifyJwt, verifyJwtWithJwks, type Jwk, type JwtClaims } from './jwt.ts'

export interface ProviderConfig {
  /** How the provider is named in URLs and stored rows. */
  name: string
  clientId: string
  clientSecret: string
  authorizationEndpoint: string
  tokenEndpoint: string
  /** OIDC only. When set, the ID token is verified against this JWKS. */
  jwksUri?: string
  /** Expected `iss` of the ID token. Required whenever `jwksUri` is set. */
  issuer?: string
  /** Called when there is no ID token — GitHub, for one, has none. */
  userinfoEndpoint?: string
  scopes: string[]
  /** Extra authorization parameters, such as Google's `prompt`. */
  authorizationParams?: Record<string, string>
}

/** What a provider told us about someone. */
export interface ProviderProfile {
  /** The provider's own stable id. Never the email — people change those. */
  subject: string
  email?: string
  /**
   * Whether the *provider* verified the email.
   *
   * Only ever true when the provider said so. An unverified address must not
   * be matched to an existing account.
   */
  emailVerified: boolean
  name?: string
  avatarUrl?: string
  /** Everything the provider returned, for an application that wants more. */
  raw: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Endpoints for the providers people actually use.
 *
 * Written out rather than discovered at startup: discovery is a network call on
 * every boot, and these URLs change roughly never.
 */
export const providers = {
  google: (clientId: string, clientSecret: string): ProviderConfig => ({
    name: 'google',
    clientId,
    clientSecret,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: 'https://accounts.google.com',
    scopes: ['openid', 'email', 'profile'],
  }),

  github: (clientId: string, clientSecret: string): ProviderConfig => ({
    name: 'github',
    clientId,
    clientSecret,
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    // GitHub is OAuth 2.0, not OIDC: there is no ID token, so the profile comes
    // from the API and the email needs a second call.
    userinfoEndpoint: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
  }),

  microsoft: (clientId: string, clientSecret: string, tenant = 'common'): ProviderConfig => ({
    name: 'microsoft',
    clientId,
    clientSecret,
    authorizationEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    jwksUri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
    scopes: ['openid', 'email', 'profile'],
  }),
} as const

// ---------------------------------------------------------------------------
// PKCE and state
// ---------------------------------------------------------------------------

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** The S256 challenge for a verifier. Plain challenges are not supported. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export interface FlowState {
  state: string
  verifier: string
  nonce: string
  /** Where to send the user afterwards. Validated before use. */
  next?: string
}

/**
 * Packs the flow state into a short-lived signed token for the cookie.
 *
 * Signed rather than stored: the flow then survives a restart and needs no
 * shared store between instances. Five minutes is generous for a redirect and
 * short enough that a stolen cookie is rarely still usable.
 */
export function sealFlowState(state: FlowState, secret: string): Promise<string> {
  return signJwt({ ...state }, secret, { expiresIn: 300 })
}

export async function openFlowState(token: string, secret: string): Promise<FlowState> {
  const claims = await verifyJwt(token, secret)
  return {
    state: String(claims.state),
    verifier: String(claims.verifier),
    nonce: String(claims.nonce),
    next: typeof claims.next === 'string' ? claims.next : undefined,
  }
}

// ---------------------------------------------------------------------------
// Step one: send them to the provider
// ---------------------------------------------------------------------------

export interface AuthorizationRequest {
  /** Where to redirect the browser. */
  url: string
  /** Seal this and set it as a cookie; the callback needs it. */
  flow: FlowState
}

export async function beginAuthorization(
  provider: ProviderConfig,
  redirectUri: string,
  options: { next?: string; loginHint?: string } = {},
): Promise<AuthorizationRequest> {
  const flow: FlowState = {
    state: randomToken(),
    verifier: randomToken(64),
    nonce: randomToken(),
    next: options.next,
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: provider.scopes.join(' '),
    state: flow.state,
    code_challenge: await pkceChallenge(flow.verifier),
    code_challenge_method: 'S256',
    ...(provider.jwksUri ? { nonce: flow.nonce } : {}),
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
    ...provider.authorizationParams,
  })

  return { url: `${provider.authorizationEndpoint}?${params}`, flow }
}

// ---------------------------------------------------------------------------
// Step two: the provider sends them back
// ---------------------------------------------------------------------------

export class OAuthError extends Error {
  constructor(message: string, readonly provider?: string) {
    super(message)
    this.name = 'OAuthError'
  }
}

export interface TokenResponse {
  access_token: string
  id_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  [field: string]: unknown
}

/** Exchanges the authorization code, proving possession of the PKCE verifier. */
export async function exchangeCode(
  provider: ProviderConfig,
  code: string,
  redirectUri: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(provider.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // GitHub returns form-encoded unless asked otherwise, which is the kind
      // of thing that only shows up in production.
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code_verifier: verifier,
    }),
  })

  if (!response.ok) {
    // The body often explains what is wrong — a stale redirect URI, a revoked
    // secret — and losing it makes this hours of guesswork.
    const detail = await response.text().catch(() => '')
    throw new OAuthError(
      `${provider.name} rejected the code exchange (${response.status}): ${detail.slice(0, 200)}`,
      provider.name,
    )
  }

  const tokens = (await response.json()) as TokenResponse
  if (typeof tokens.access_token !== 'string') {
    throw new OAuthError(`${provider.name} returned no access token.`, provider.name)
  }

  return tokens
}

/** Cached per JWKS URI: providers rotate keys, but not on the timescale of a request. */
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>()
const JWKS_TTL_MS = 10 * 60 * 1000

export async function fetchJwks(uri: string, fetchImpl: typeof fetch = fetch): Promise<{ keys: Jwk[] }> {
  const cached = jwksCache.get(uri)
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return { keys: cached.keys }

  const response = await fetchImpl(uri)
  if (!response.ok) throw new OAuthError(`Could not fetch the JWKS from ${uri} (${response.status}).`)

  const jwks = (await response.json()) as { keys: Jwk[] }
  jwksCache.set(uri, { keys: jwks.keys, fetchedAt: Date.now() })
  return jwks
}

export function _clearJwksCache(): void {
  jwksCache.clear()
}

/**
 * Turns a token response into a profile.
 *
 * OIDC providers are read from the verified ID token; everyone else needs the
 * userinfo call. The ID token is preferred because it is signed — a userinfo
 * response is only as trustworthy as the transport.
 */
export async function fetchProfile(
  provider: ProviderConfig,
  tokens: TokenResponse,
  nonce: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderProfile> {
  if (provider.jwksUri && tokens.id_token) {
    const jwks = await fetchJwks(provider.jwksUri, fetchImpl)
    const claims = await verifyJwtWithJwks(tokens.id_token, jwks, {
      issuer: provider.issuer,
      audience: provider.clientId,
    })

    // Without this an ID token obtained elsewhere can be replayed into this
    // callback — the whole reason the nonce was sent.
    if (claims.nonce !== nonce) {
      throw new OAuthError(`The ID token's nonce does not match this login attempt.`, provider.name)
    }

    return profileFromClaims(claims)
  }

  if (!provider.userinfoEndpoint) {
    throw new OAuthError(`${provider.name} returned no ID token and has no userinfo endpoint.`, provider.name)
  }

  const response = await fetchImpl(provider.userinfoEndpoint, {
    headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
  })
  if (!response.ok) {
    throw new OAuthError(`${provider.name} rejected the profile request (${response.status}).`, provider.name)
  }

  return profileFromUserinfo(provider, (await response.json()) as Record<string, unknown>)
}

function profileFromClaims(claims: JwtClaims): ProviderProfile {
  return {
    subject: String(claims.sub),
    email: typeof claims.email === 'string' ? claims.email : undefined,
    // Strictly true only: some providers send the string "true", and treating
    // any truthy value as verified would accept "false".
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
    raw: claims as Record<string, unknown>,
  }
}

function profileFromUserinfo(provider: ProviderConfig, data: Record<string, unknown>): ProviderProfile {
  const subject = data.sub ?? data.id
  if (subject === undefined || subject === null) {
    throw new OAuthError(`${provider.name} returned a profile with no stable id.`, provider.name)
  }

  return {
    subject: String(subject),
    email: typeof data.email === 'string' ? data.email : undefined,
    // A plain OAuth userinfo response carries no verification signal, so the
    // honest answer is no. GitHub's /user/emails can say otherwise, and the
    // application can ask for it explicitly if it wants to.
    emailVerified: data.email_verified === true,
    name: typeof data.name === 'string' ? data.name : typeof data.login === 'string' ? data.login : undefined,
    avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : undefined,
    raw: data,
  }
}

/**
 * Checks the callback's `state` against the sealed one, in constant time.
 *
 * Returns rather than throws so a caller can decide the response — this fires
 * on ordinary events too, such as a user reloading a stale callback URL.
 */
export function stateMatches(returned: string | null, expected: string): boolean {
  if (!returned || returned.length !== expected.length) return false

  let difference = 0
  for (let index = 0; index < returned.length; index++) {
    difference |= returned.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

/**
 * Whether a post-login redirect target is safe to use.
 *
 * An open redirect is the standard way this parameter is abused: the login
 * looks legitimate, and the user lands on a page the attacker controls. Only
 * same-site paths are allowed — and `//evil.com` is a protocol-relative URL,
 * not a path, which is the case a naive `startsWith('/')` lets through.
 */
export function safeRedirect(next: string | undefined, fallback = '/'): string {
  if (!next) return fallback
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  return next
}
