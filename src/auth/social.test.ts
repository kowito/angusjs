/**
 * Social login's security lives in one decision: when a provider hands you an
 * email that already has an account, do you sign that person in? Most of these
 * tests exist to pin the answer.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { authModels, SocialAccount, User } from './models.ts'
import {
  beginAuthorization,
  exchangeCode,
  fetchProfile,
  OAuthError,
  openFlowState,
  pkceChallenge,
  providers,
  safeRedirect,
  sealFlowState,
  stateMatches,
  _clearJwksCache,
} from './oauth.ts'
import { linkedProviders, resolveSocialUser, SocialLoginError, unlinkProvider } from './social.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

const SECRET = 's'.repeat(32)

const profile = (over: Partial<Parameters<typeof resolveSocialUser>[1]> = {}) => ({
  subject: 'provider-123',
  email: 'person@example.com',
  emailVerified: true,
  name: 'A Person',
  raw: {},
  ...over,
})

let db: TestDatabase

beforeAll(async () => {
  db = await testDatabase({ models: Object.values(authModels) })
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  _clearJwksCache()
})

describe('the authorization request', () => {
  test('carries PKCE, state and a nonce for OIDC', async () => {
    const { url, flow } = await beginAuthorization(providers.google('id', 'secret'), 'https://app/callback')
    const params = new URL(url).searchParams

    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBe(await pkceChallenge(flow.verifier))
    expect(params.get('state')).toBe(flow.state)
    expect(params.get('nonce')).toBe(flow.nonce)
  })

  test('omits the nonce for plain OAuth, which has no ID token to bind it to', async () => {
    const { url } = await beginAuthorization(providers.github('id', 'secret'), 'https://app/callback')
    expect(new URL(url).searchParams.get('nonce')).toBeNull()
    // PKCE is not optional even without OIDC.
    expect(new URL(url).searchParams.get('code_challenge')).toBeTruthy()
  })

  test('each attempt is unique, so two tabs cannot be confused', async () => {
    const google = providers.google('id', 'secret')
    const one = await beginAuthorization(google, 'https://app/callback')
    const two = await beginAuthorization(google, 'https://app/callback')

    expect(one.flow.state).not.toBe(two.flow.state)
    expect(one.flow.verifier).not.toBe(two.flow.verifier)
  })

  test('the flow survives a round trip through a cookie', async () => {
    const { flow } = await beginAuthorization(providers.google('id', 'x'), 'https://app/cb', { next: '/dashboard' })
    const reopened = await openFlowState(await sealFlowState(flow, SECRET), SECRET)

    expect(reopened).toEqual(flow)
  })

  test('a flow sealed with another secret is refused', async () => {
    const { flow } = await beginAuthorization(providers.google('id', 'x'), 'https://app/cb')
    const sealed = await sealFlowState(flow, SECRET)

    expect(openFlowState(sealed, 'o'.repeat(32))).rejects.toThrow()
  })
})

describe('state and redirect checks', () => {
  test('a mismatched state is refused', () => {
    expect(stateMatches('abc', 'abc')).toBe(true)
    expect(stateMatches('abc', 'abd')).toBe(false)
    expect(stateMatches(null, 'abc')).toBe(false)
    expect(stateMatches('', 'abc')).toBe(false)
  })

  test('only same-site paths are accepted as a redirect target', () => {
    expect(safeRedirect('/dashboard')).toBe('/dashboard')
    expect(safeRedirect('https://evil.example')).toBe('/')
    // The one a naive startsWith('/') lets through: protocol-relative.
    expect(safeRedirect('//evil.example')).toBe('/')
    expect(safeRedirect('/\\evil.example')).toBe('/')
    expect(safeRedirect(undefined, '/home')).toBe('/home')
  })
})

describe('the code exchange', () => {
  const google = providers.google('client', 'secret')

  test('sends the verifier, which is what makes a stolen code useless', async () => {
    let body: URLSearchParams | undefined
    const stub = (async (_url: string, init: any) => {
      body = init.body
      return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })
    }) as unknown as typeof fetch

    await exchangeCode(google, 'the-code', 'https://app/cb', 'the-verifier', stub)

    expect(body!.get('code_verifier')).toBe('the-verifier')
    expect(body!.get('grant_type')).toBe('authorization_code')
  })

  test('a rejection keeps the provider’s explanation', async () => {
    const stub = (async () =>
      new Response('redirect_uri_mismatch', { status: 400 })) as unknown as typeof fetch

    // Losing this body turns a stale redirect URI into hours of guesswork.
    expect(exchangeCode(google, 'c', 'https://app/cb', 'v', stub)).rejects.toThrow(/redirect_uri_mismatch/)
  })

  test('a response without an access token is an error, not an empty success', async () => {
    const stub = (async () => new Response(JSON.stringify({ error: 'bad' }), { status: 200 })) as unknown as typeof fetch
    expect(exchangeCode(google, 'c', 'https://app/cb', 'v', stub)).rejects.toThrow(/no access token/)
  })
})

describe('the profile', () => {
  test('a userinfo profile is never treated as verified without the provider saying so', async () => {
    const stub = (async () =>
      new Response(JSON.stringify({ id: 99, login: 'octo', email: 'o@example.com' }), {
        status: 200,
      })) as unknown as typeof fetch

    const found = await fetchProfile(providers.github('i', 's'), { access_token: 'at' }, 'nonce', stub)

    expect(found.subject).toBe('99')
    // Plain OAuth carries no verification signal, so the honest answer is no.
    expect(found.emailVerified).toBe(false)
  })

  test('a profile with no stable id is refused rather than keyed on email', async () => {
    const stub = (async () =>
      new Response(JSON.stringify({ email: 'o@example.com' }), { status: 200 })) as unknown as typeof fetch

    expect(fetchProfile(providers.github('i', 's'), { access_token: 'at' }, 'n', stub)).rejects.toThrow(
      /no stable id/,
    )
  })

  test('an OIDC provider with no ID token and no userinfo says so', async () => {
    const google = providers.google('i', 's')
    expect(fetchProfile({ ...google, jwksUri: undefined }, { access_token: 'at' }, 'n')).rejects.toThrow(
      OAuthError,
    )
  })
})

describe('resolving a user', () => {
  test('creates an account when nothing matches', async () => {
    const result = await resolveSocialUser('google', profile())

    expect(result.created).toBe(true)
    expect(result.user.email).toBe('person@example.com')
    // The provider verified it, so the flag is set.
    expect(result.user.emailVerifiedAt).not.toBeNull()
  })

  test('a created account has no usable password', async () => {
    const { user } = await resolveSocialUser('google', profile())
    expect(user.passwordHash).toBe('')
  })

  test('signing in again finds the same account rather than making another', async () => {
    const first = await resolveSocialUser('google', profile())
    const second = await resolveSocialUser('google', profile())

    expect(second.user.id).toBe(first.user.id)
    expect(second.created).toBe(false)
    expect(await SocialAccount.objects.count()).toBe(1)
  })

  test('the link survives the person changing their email at the provider', async () => {
    // Keyed on the provider's subject, not the address.
    const first = await resolveSocialUser('google', profile())
    const second = await resolveSocialUser('google', profile({ email: 'new@example.com' }))

    expect(second.user.id).toBe(first.user.id)
  })

  test('an unverified email does NOT link to an existing account', async () => {
    // The takeover: register at a provider with someone else's address.
    await User.objects.create({ email: 'victim@example.com', passwordHash: 'x', roles: [] })

    expect(
      resolveSocialUser('github', profile({ email: 'victim@example.com', emailVerified: false })),
    ).rejects.toThrow(SocialLoginError)
  })

  test('a verified email does link', async () => {
    const victim = await User.objects.create({ email: 'person@example.com', passwordHash: 'x', roles: [] })
    const result = await resolveSocialUser('google', profile({ emailVerified: true }))

    expect(result.user.id).toBe(victim.id)
    expect(result.linked).toBe(true)
  })

  test('the loose policy has to be asked for by name', async () => {
    const existing = await User.objects.create({ email: 'person@example.com', passwordHash: 'x', roles: [] })
    const result = await resolveSocialUser('github', profile({ emailVerified: false }), {
      linkPolicy: 'any-email',
    })

    expect(result.user.id).toBe(existing.id)
  })

  test('the never policy refuses rather than colliding on a taken email', async () => {
    // `email` is unique, so there is no second account to create. Explaining
    // that beats a constraint violation surfacing from three calls down.
    await User.objects.create({ email: 'person@example.com', passwordHash: 'x', roles: [] })

    expect(resolveSocialUser('google', profile(), { linkPolicy: 'never' })).rejects.toThrow(/already uses/)
  })

  test('the never policy creates a separate account when the email is free', async () => {
    const other = await User.objects.create({ email: 'someone@example.com', passwordHash: 'x', roles: [] })
    const result = await resolveSocialUser('google', profile(), { linkPolicy: 'never' })

    expect(result.created).toBe(true)
    expect(result.user.id).not.toBe(other.id)
  })

  test('a deactivated account cannot be revived through a second sign-in route', async () => {
    const { user } = await resolveSocialUser('google', profile())
    await User.objects.filter({ id: user.id }).update({ isActive: false })

    // Otherwise deactivation means nothing to anyone with a linked provider.
    expect(resolveSocialUser('google', profile())).rejects.toThrow(/not active/)
  })

  test('sign-up can be refused for an application that provisions accounts elsewhere', async () => {
    expect(resolveSocialUser('google', profile(), { signUp: false })).rejects.toThrow(/No account matches/)
  })

  test('onCreate runs for a new account only', async () => {
    let calls = 0
    await resolveSocialUser('google', profile(), { onCreate: () => void calls++ })
    await resolveSocialUser('google', profile(), { onCreate: () => void calls++ })

    expect(calls).toBe(1)
  })

  test('an unverified email with no existing account still creates one, unverified', async () => {
    const result = await resolveSocialUser('github', profile({ emailVerified: false }))

    expect(result.created).toBe(true)
    // Nothing was taken over, but the address is not confirmed either.
    expect(result.user.emailVerifiedAt).toBeNull()
  })
})

describe('unlinking', () => {
  test('lists what a user has connected', async () => {
    const { user } = await resolveSocialUser('google', profile())
    await resolveSocialUser('github', profile({ subject: 'gh-1' }), { linkPolicy: 'any-email' })

    expect((await linkedProviders(user.id)).sort()).toEqual(['github', 'google'])
  })

  test('refuses to remove the last way in', async () => {
    const { user } = await resolveSocialUser('google', profile())

    // Someone who never set a password would otherwise lock themselves out.
    expect(unlinkProvider(user.id, 'google')).rejects.toThrow(/no way to sign in/)
    expect(await SocialAccount.objects.count()).toBe(1)
  })

  test('allows it when a password exists', async () => {
    const { user } = await resolveSocialUser('google', profile())
    await User.objects.filter({ id: user.id }).update({ passwordHash: 'argon2-hash' })

    await unlinkProvider(user.id, 'google')
    expect(await linkedProviders(user.id)).toEqual([])
  })

  test('allows it when another provider remains', async () => {
    const { user } = await resolveSocialUser('google', profile())
    await resolveSocialUser('github', profile({ subject: 'gh-1' }), { linkPolicy: 'any-email' })

    await unlinkProvider(user.id, 'google')
    expect(await linkedProviders(user.id)).toEqual(['github'])
  })
})
