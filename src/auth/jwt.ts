/**
 * JSON Web Tokens.
 *
 * Angus's own sessions are opaque tokens checked against the database, which is
 * the right default: they can be revoked instantly, they carry no claims that
 * can go stale, and a leaked one is useless once deleted. JWTs are here for the
 * cases where that model does not fit — a token another service must verify
 * without calling you, and the ID tokens an OIDC provider issues.
 *
 * That trade is the thing to understand before reaching for these: a JWT is
 * valid until it expires, and *nothing you do* revokes it in the meantime. Keep
 * the lifetime short.
 *
 * Signing is HS256 (shared secret) or ES256/RS256 (public key). Verification
 * supports all three, because an OIDC provider will hand you RS256 or ES256 and
 * you do not get to choose.
 */

export type Algorithm = 'HS256' | 'RS256' | 'ES256'

/**
 * A JSON Web Key, declared locally because the project does not pull in the DOM
 * type library — and this is the shape a provider's JWKS endpoint returns.
 */
export interface Jwk {
  kty?: string
  crv?: string
  kid?: string
  alg?: string
  use?: string
  n?: string
  e?: string
  x?: string
  y?: string
  [property: string]: unknown
}

export interface JwtClaims {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  iat?: number
  jti?: string
  [claim: string]: unknown
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JwtError'
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function base64UrlEncode(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Web Crypto wants a buffer backed by an ArrayBuffer specifically, while
 * TextEncoder's output is typed loosely enough to include SharedArrayBuffer.
 * The copy is a few bytes and keeps the call sites readable.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const raw = atob(padded)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

const HMAC = { name: 'HMAC', hash: 'SHA-256' } as const

export interface SignOptions {
  /** Seconds until expiry. Defaults to 3600 — keep it short; JWTs cannot be revoked. */
  expiresIn?: number
  issuer?: string
  audience?: string | string[]
  subject?: string
  /** Key id, for a verifier choosing between several keys. */
  keyId?: string
}

/**
 * Signs claims with a shared secret.
 *
 * HS256 only: asymmetric signing needs a private key the caller has to manage,
 * and offering it here without a key management story would invite people to
 * paste PEMs into settings.
 */
export async function signJwt(claims: JwtClaims, secret: string, options: SignOptions = {}): Promise<string> {
  if (secret.length < 32) {
    // A short HMAC secret is brute-forceable offline, and the token gives an
    // attacker everything they need to try.
    throw new JwtError('The signing secret must be at least 32 characters.')
  }

  const now = Math.floor(Date.now() / 1000)
  const payload: JwtClaims = {
    ...claims,
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + (options.expiresIn ?? 3600),
    ...(options.issuer ? { iss: options.issuer } : {}),
    ...(options.audience ? { aud: options.audience } : {}),
    ...(options.subject ? { sub: options.subject } : {}),
  }

  const header = { alg: 'HS256', typ: 'JWT', ...(options.keyId ? { kid: options.keyId } : {}) }
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`

  const key = await crypto.subtle.importKey('raw', bufferOf(encoder.encode(secret)), HMAC, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, bufferOf(encoder.encode(signingInput))))

  return `${signingInput}.${base64UrlEncode(signature)}`
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  issuer?: string
  audience?: string | string[]
  /** Tolerance for clock skew between signer and verifier. Defaults to 60s. */
  clockToleranceSeconds?: number
  /** Algorithms to accept. Defaults to whatever the key can verify. */
  algorithms?: Algorithm[]
}

/** Header and claims without verifying anything — for reading `kid` and `iss`. */
export function decodeJwt(token: string): { header: Record<string, unknown>; claims: JwtClaims } {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('Not a JWT: expected three dot-separated parts.')

  try {
    return {
      header: JSON.parse(decoder.decode(base64UrlDecode(parts[0]!))),
      claims: JSON.parse(decoder.decode(base64UrlDecode(parts[1]!))),
    }
  } catch {
    throw new JwtError('The token is not valid JSON.')
  }
}

/**
 * Verifies a token signed with a shared secret.
 *
 * The algorithm is taken from the caller's expectation, never from the token's
 * own header. Trusting the header is the classic JWT vulnerability: a token
 * claiming `alg: none`, or claiming HS256 against a service holding an RSA
 * public key, verifies against a key the attacker already has.
 */
export async function verifyJwt(token: string, secret: string, options: VerifyOptions = {}): Promise<JwtClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('Not a JWT: expected three dot-separated parts.')

  const { header, claims } = decodeJwt(token)
  if (header.alg !== 'HS256') {
    throw new JwtError(`Expected an HS256 token, got ${String(header.alg)}.`)
  }

  const key = await crypto.subtle.importKey('raw', bufferOf(encoder.encode(secret)), HMAC, false, ['verify'])
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    bufferOf(base64UrlDecode(parts[2]!)),
    bufferOf(encoder.encode(`${parts[0]}.${parts[1]}`)),
  )

  if (!valid) throw new JwtError('The signature does not match.')

  assertClaims(claims, options)
  return claims
}

/**
 * Verifies a token against a JWKS, which is how OIDC ID tokens arrive.
 *
 * The key is chosen by the token's `kid`, but the *algorithm* still comes from
 * the key itself rather than the token header — for the same reason as above.
 */
export async function verifyJwtWithJwks(
  token: string,
  jwks: { keys: Jwk[] },
  options: VerifyOptions = {},
): Promise<JwtClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('Not a JWT: expected three dot-separated parts.')

  const { header, claims } = decodeJwt(token)
  const kid = header.kid as string | undefined

  const candidates = kid ? jwks.keys.filter((key) => (key as { kid?: string }).kid === kid) : jwks.keys
  if (candidates.length === 0) {
    throw new JwtError(`No key in the JWKS matches kid "${String(kid)}".`)
  }

  let verified = false

  for (const jwk of candidates) {
    const algorithm = algorithmFor(jwk)
    if (!algorithm) continue
    if (options.algorithms && !options.algorithms.includes(algorithm.name)) continue

    try {
      const key = await crypto.subtle.importKey('jwk', jwk as never, algorithm.params as never, false, ['verify'])
      verified = await crypto.subtle.verify(
        algorithm.verifyParams as never,
        key,
        bufferOf(base64UrlDecode(parts[2]!)),
        bufferOf(encoder.encode(`${parts[0]}.${parts[1]}`)),
      )
    } catch {
      // A key that cannot be imported is not a verification failure. Try the
      // next candidate; if none work, the error below is the honest one.
      continue
    }

    if (verified) break
  }

  if (!verified) throw new JwtError('The signature does not match any key in the JWKS.')

  // Outside the loop deliberately: a claims failure on a validly signed token
  // must surface as "expired", not as "no key matched". Raising it inside the
  // try would have been caught by the key-import handler and reported as the
  // wrong problem entirely.
  assertClaims(claims, options)
  return claims
}

/** Maps a JWK to the Web Crypto parameters that verify it. */
function algorithmFor(jwk: Jwk): { name: Algorithm; params: object; verifyParams: string | object } | null {
  if (jwk.kty === 'RSA') {
    return {
      name: 'RS256',
      params: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      verifyParams: 'RSASSA-PKCS1-v1_5',
    }
  }

  if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
    return {
      name: 'ES256',
      params: { name: 'ECDSA', namedCurve: 'P-256' },
      verifyParams: { name: 'ECDSA', hash: 'SHA-256' },
    }
  }

  return null
}

/**
 * Checks the registered claims.
 *
 * Every one of these has been the subject of a real vulnerability. `exp`
 * unchecked means tokens never expire; `aud` unchecked means a token minted for
 * another service is accepted here; `iss` unchecked means any provider can mint
 * one for you.
 */
function assertClaims(claims: JwtClaims, options: VerifyOptions): void {
  const now = Math.floor(Date.now() / 1000)
  const tolerance = options.clockToleranceSeconds ?? 60

  if (typeof claims.exp === 'number' && now > claims.exp + tolerance) {
    throw new JwtError('The token has expired.')
  }

  if (typeof claims.nbf === 'number' && now + tolerance < claims.nbf) {
    throw new JwtError('The token is not valid yet.')
  }

  if (options.issuer !== undefined && claims.iss !== options.issuer) {
    throw new JwtError(`Expected issuer ${options.issuer}, got ${String(claims.iss)}.`)
  }

  if (options.audience !== undefined) {
    const expected = Array.isArray(options.audience) ? options.audience : [options.audience]
    const actual = Array.isArray(claims.aud) ? claims.aud : claims.aud === undefined ? [] : [claims.aud]

    if (!actual.some((entry) => expected.includes(entry))) {
      throw new JwtError(`The token's audience does not include ${expected.join(' or ')}.`)
    }
  }
}
