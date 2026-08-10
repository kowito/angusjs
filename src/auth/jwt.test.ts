/**
 * Every check here corresponds to a JWT vulnerability that has been exploited
 * in the wild. The negative tests are the point of the file.
 */

import { describe, expect, test } from 'bun:test'
import { decodeJwt, JwtError, signJwt, verifyJwt, verifyJwtWithJwks } from './jwt.ts'

const SECRET = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

describe('round trip', () => {
  test('claims survive signing and verification', async () => {
    const token = await signJwt({ sub: '42', role: 'staff' }, SECRET)
    const claims = await verifyJwt(token, SECRET)

    expect(claims.sub).toBe('42')
    expect(claims.role).toBe('staff')
  })

  test('iat and exp are filled in', async () => {
    const claims = await verifyJwt(await signJwt({}, SECRET, { expiresIn: 60 }), SECRET)

    expect(typeof claims.iat).toBe('number')
    expect(claims.exp! - claims.iat!).toBe(60)
  })

  test('issuer, audience and subject can be set through options', async () => {
    const token = await signJwt({}, SECRET, { issuer: 'angus', audience: 'api', subject: '7' })
    const claims = await verifyJwt(token, SECRET, { issuer: 'angus', audience: 'api' })

    expect(claims.sub).toBe('7')
  })

  test('decode reads the header without verifying', async () => {
    const token = await signJwt({ sub: '1' }, SECRET, { keyId: 'k1' })
    expect(decodeJwt(token).header.kid).toBe('k1')
  })
})

describe('signatures', () => {
  test('another secret does not verify', async () => {
    const token = await signJwt({ sub: '1' }, SECRET)
    expect(verifyJwt(token, OTHER)).rejects.toThrow(/signature does not match/)
  })

  test('a tampered payload does not verify', async () => {
    const token = await signJwt({ sub: '1', admin: false }, SECRET)
    const [header, , signature] = token.split('.')

    const forged = btoa(JSON.stringify({ sub: '1', admin: true })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    expect(verifyJwt(`${header}.${forged}.${signature}`, SECRET)).rejects.toThrow(JwtError)
  })

  test('a short secret is refused at signing time', async () => {
    // Offline brute force is the attack, and the token gives an attacker
    // everything needed to try.
    expect(signJwt({}, 'short')).rejects.toThrow(/at least 32/)
  })
})

describe('algorithm confusion', () => {
  test('alg: none is rejected', async () => {
    // The original JWT vulnerability: a token that declares itself unsigned.
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })).replace(/=+$/, '')
    const payload = btoa(JSON.stringify({ sub: 'admin' })).replace(/=+$/, '')

    expect(verifyJwt(`${header}.${payload}.`, SECRET)).rejects.toThrow(/Expected an HS256 token/)
  })

  test('the algorithm comes from the verifier, not the token header', async () => {
    // A token claiming RS256 must not be verified as RS256 just because it says
    // so — the header is attacker-controlled.
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=+$/, '')
    const payload = btoa(JSON.stringify({ sub: 'admin' })).replace(/=+$/, '')

    expect(verifyJwt(`${header}.${payload}.anything`, SECRET)).rejects.toThrow(/Expected an HS256 token/)
  })

  test('a malformed token is refused rather than parsed loosely', async () => {
    expect(verifyJwt('not.a.jwt', SECRET)).rejects.toThrow(JwtError)
    expect(verifyJwt('onlyonepart', SECRET)).rejects.toThrow(/three dot-separated parts/)
  })
})

describe('claims', () => {
  test('an expired token is refused', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200
    const token = await signJwt({ exp: past }, SECRET)

    expect(verifyJwt(token, SECRET)).rejects.toThrow(/expired/)
  })

  test('a small clock difference is tolerated', async () => {
    // Two servers disagreeing by seconds must not reject every token.
    const justExpired = Math.floor(Date.now() / 1000) - 10
    const claims = await verifyJwt(await signJwt({ exp: justExpired }, SECRET), SECRET)

    expect(claims.exp).toBe(justExpired)
  })

  test('a not-yet-valid token is refused', async () => {
    const future = Math.floor(Date.now() / 1000) + 7200
    expect(verifyJwt(await signJwt({ nbf: future }, SECRET), SECRET)).rejects.toThrow(/not valid yet/)
  })

  test('a token for another audience is refused', async () => {
    // Otherwise a token your provider minted for a different service is
    // accepted here.
    const token = await signJwt({}, SECRET, { audience: 'other-service' })
    expect(verifyJwt(token, SECRET, { audience: 'this-service' })).rejects.toThrow(/audience/)
  })

  test('one matching audience out of several is enough', async () => {
    const token = await signJwt({ aud: ['a', 'b'] }, SECRET)
    expect((await verifyJwt(token, SECRET, { audience: 'b' })).sub).toBeUndefined()
  })

  test('a token from another issuer is refused', async () => {
    const token = await signJwt({}, SECRET, { issuer: 'someone-else' })
    expect(verifyJwt(token, SECRET, { issuer: 'us' })).rejects.toThrow(/Expected issuer us/)
  })

  test('an absent audience does not satisfy an expected one', async () => {
    const token = await signJwt({}, SECRET)
    expect(verifyJwt(token, SECRET, { audience: 'api' })).rejects.toThrow(/audience/)
  })
})

describe('JWKS verification', () => {
  /** A real RS256 key pair, since the point is to verify a real signature. */
  async function rsaKeyPair() {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    return { pair, jwk: { ...jwk, kid: 'test-key' } }
  }

  const b64 = (bytes: Uint8Array | string) =>
    btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

  async function signRs256(claims: object, privateKey: CryptoKey, kid = 'test-key') {
    const input = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))}.${b64(JSON.stringify(claims))}`
    const signature = new Uint8Array(
      await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)),
    )
    return `${input}.${b64(signature)}`
  }

  test('an RS256 token verifies against the matching key', async () => {
    const { pair, jwk } = await rsaKeyPair()
    const token = await signRs256({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 }, pair.privateKey)

    expect((await verifyJwtWithJwks(token, { keys: [jwk] })).sub).toBe('user-1')
  })

  test('a token signed by a different key is refused', async () => {
    const { pair } = await rsaKeyPair()
    const other = await rsaKeyPair()
    const token = await signRs256({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 }, pair.privateKey)

    expect(verifyJwtWithJwks(token, { keys: [other.jwk] })).rejects.toThrow(/does not match/)
  })

  test('an unknown kid is named rather than silently trying every key', async () => {
    const { pair, jwk } = await rsaKeyPair()
    const token = await signRs256({ sub: 'x' }, pair.privateKey, 'some-other-kid')

    expect(verifyJwtWithJwks(token, { keys: [jwk] })).rejects.toThrow(/No key in the JWKS/)
  })

  test('claims are still checked after the signature passes', async () => {
    const { pair, jwk } = await rsaKeyPair()
    const token = await signRs256({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 7200 }, pair.privateKey)

    expect(verifyJwtWithJwks(token, { keys: [jwk] })).rejects.toThrow(/expired/)
  })
})
