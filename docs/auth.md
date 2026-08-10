---
title: Authentication
section: Building
order: 4
---

# Authentication

```ts
export default defineSettings({
  apps: [authApp(), ...],
  authenticate,
})
```

That gives every surface `context.user` and `context.identity`, and adds the session endpoints.

## Sessions

Angus sessions are opaque tokens checked against the database. They can be revoked instantly, they carry no claims that go stale, and a leaked one is useless once deleted.

```ts
POST /auth/login      { email, password }   → sets an HttpOnly cookie
POST /auth/logout
GET  /auth/me
POST /auth/password   { current, next }
```

Passwords are argon2id through `Bun.password` — no dependency, and a better default than most of them. Login timing is equalised so a wrong address and a wrong password take the same time; otherwise the endpoint enumerates your users.

Rate limiting applies in production only. Five attempts per five minutes would lock a developer out of their own machine.

## API tokens

```ts
const credential = await issueCredential(user, { kind: 'token', scopes: ['posts:read'] })
```

Stored as a SHA-256 hash, so the database never holds anything usable. The secret is returned exactly once.

## Permissions and roles

```ts
permissions: [hasRole('editor')]
permissions: [hasScope('posts:write')]
```

## Social sign-in

```ts
socialAuthRoutes({
  providers: [
    providers.google(env.GOOGLE_ID, env.GOOGLE_SECRET),
    providers.github(env.GITHUB_ID, env.GITHUB_SECRET),
  ],
  secret: env.SECRET_KEY,
  baseUrl: 'https://app.example.com',
})
```

Two routes: one sends the browser to the provider with PKCE, `state` and a nonce; the other checks all three, exchanges the code, and issues an ordinary Angus session. Presets for Google, GitHub and Microsoft.

Each of those three is mandatory rather than configurable, because each stops a specific attack:

- **PKCE** stops an intercepted authorization code being redeemed by whoever intercepted it.
- **`state`** stops an attacker completing *their* login in *your* browser, silently binding your session to their account.
- **`nonce`** ties an OIDC ID token to the request that asked for it.

### The link policy

The decision that matters is what happens when a provider returns an email that already has an account.

| Policy | Behaviour |
| --- | --- |
| `verified-email` *(default)* | Links only when the provider verified the address |
| `any-email` | Links on a matching address regardless |
| `never` | Always a separate account; refuses when the address is taken |

The default is not conservatism. With `any-email` and a provider that does not verify addresses, anyone can register at that provider using someone else's email and sign in as them. Choose it only when every provider you have configured verifies addresses itself.

Accounts are keyed on the provider's subject rather than on email, so the link survives someone changing their address at the provider.

```ts
await linkedProviders(user.id)
await unlinkProvider(user.id, 'google')   // refuses to remove the last way in
```

## JWTs

```ts
const token = await signJwt({ sub: String(user.id) }, env.SECRET_KEY, { expiresIn: 900 })
const claims = await verifyJwt(token, env.SECRET_KEY, { issuer, audience })
```

For tokens another service must verify without calling you, and for the ID tokens an OIDC provider issues (`verifyJwtWithJwks`).

The algorithm always comes from the verifier, never from the token's own header — that header is attacker-controlled, and trusting it is the classic JWT vulnerability.

> A JWT is valid until it expires and nothing revokes it in the meantime. That is why Angus's own sessions are not JWTs. Keep the lifetime short.
