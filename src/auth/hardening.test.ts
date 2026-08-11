/**
 * Security defaults that must not depend on NODE_ENV being set correctly:
 * the session cookie's Secure flag follows the request scheme, and an OIDC
 * provider that would skip issuer validation is refused at construction.
 */

import { describe, expect, test } from 'bun:test'
import { isSecureRequest } from './app.ts'
import { assertProviderConfig, providers } from './oauth.ts'

describe('secure cookie follows the request scheme, not NODE_ENV', () => {
  const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

  test('https request -> secure', () => {
    expect(isSecureRequest(req('https://app.example.com/auth/login'))).toBe(true)
  })

  test('http request -> not secure (local dev over http still works)', () => {
    expect(isSecureRequest(req('http://localhost:8000/auth/login'))).toBe(false)
  })

  test('a TLS-terminating proxy is honoured via x-forwarded-proto', () => {
    expect(isSecureRequest(req('http://internal/auth/login', { 'x-forwarded-proto': 'https' }))).toBe(true)
    expect(isSecureRequest(req('http://internal/auth/login', { 'x-forwarded-proto': 'https, http' }))).toBe(true)
  })
})

describe('OIDC issuer is mandatory when a JWKS is used', () => {
  test('the Microsoft preset requires a specific tenant and sets the issuer', () => {
    const provider = providers.microsoft('id', 'secret', 'contoso.onmicrosoft.com')
    expect(provider.issuer).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0')
    expect(() => assertProviderConfig(provider)).not.toThrow()
  })

  test('a hand-rolled provider with jwksUri but no issuer is refused', () => {
    const bad = { name: 'custom', clientId: 'x', clientSecret: 'y', authorizationEndpoint: 'a', tokenEndpoint: 't', jwksUri: 'j', scopes: [] }
    expect(() => assertProviderConfig(bad)).toThrow(/no issuer/)
  })

  test('Google and GitHub presets pass (Google has an issuer, GitHub has no JWKS)', () => {
    expect(() => assertProviderConfig(providers.google('i', 's'))).not.toThrow()
    expect(() => assertProviderConfig(providers.github('i', 's'))).not.toThrow()
  })
})
