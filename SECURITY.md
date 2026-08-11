# Security policy

Angus handles passwords, sessions, OAuth flows and agent authorisation. A bug in any of those is a bug in every application built on it.

## Reporting a vulnerability

Report privately, not as a public issue:

- **Email:** hi@kowito.com
- **GitHub:** [private security advisory](https://github.com/kowito/angusjs/security/advisories/new)

Please include what you can — a description, the version, and ideally a minimal reproduction. You will get an acknowledgement within a few days.

Angus is pre-1.0 and maintained without a dedicated security team. There is no bug bounty, and no formal response-time guarantee beyond an honest effort. Saying so is better than implying a process that does not exist.

## Supported versions

Pre-1.0: only the latest release. There are no maintenance branches.

## What is in scope

Anything that lets an application built on Angus be compromised through Angus's own code:

- Authentication or session handling — token generation, comparison, expiry, revocation.
- The OAuth and OIDC flows — PKCE, `state`, `nonce`, ID token verification, account linking.
- Permission checks, including object-level permissions and MCP tool policy.
- SQL injection through the query builder or lookups.
- The admin's authorisation, including its fail-closed behaviour in production.
- Path traversal through storage keys.
- Anything that leaks secrets into logs, traces, error responses or audit records.

## What is not

- Vulnerabilities in Bun, Elysia, Drizzle or TypeBox. Report those to their maintainers; if Angus is using them unsafely, that part is ours.
- Misconfiguration in an application — a permissive `linkPolicy`, missing permissions, `debug` left on in production. Where a default is the unsafe one, that *is* our bug.
- Denial of service through unbounded request bodies or query complexity. Rate limiting is provided; tuning it is the application's.

## Security decisions worth knowing

These are deliberate, and documented so nobody has to reverse-engineer the intent:

| Decision | Reasoning |
| --- | --- |
| Sessions are opaque database tokens, not JWTs | They can be revoked. A JWT is valid until it expires whatever you do. |
| Passwords use argon2id via `Bun.password` | No dependency, and a better default than most alternatives. |
| API tokens are stored as SHA-256 hashes | The database never holds anything usable. |
| Login timing is equalised | Otherwise the endpoint enumerates your users. |
| Social login links only on a provider-verified email by default | Otherwise anyone can register at a provider with someone else's address and sign in as them. |
| PKCE, `state` and `nonce` are mandatory, not optional | Each stops a specific attack and none costs anything. |
| The JWT algorithm comes from the verifier, never the token header | The header is attacker-controlled. This is the classic JWT vulnerability. |
| The admin refuses to serve in production without configured permissions | An admin that stayed open because nobody configured it is the failure worth designing against. |
| URLs in admin links and emails are scheme-checked, not just HTML-escaped | `javascript:` has no HTML-special characters, so escaping alone lets it reach an `href` and run in a staff session. |
| MCP deletes require explicit confirmation | An irreversible action should not happen on a single inference. |
| Audit logs redact secret-looking keys and store a digest of the caller | A log outlives the credential in it, and is read by more people than the database. |

## Known limitations

Stated rather than discovered:

- **It has never been run in production by anyone.** Everything here is reasoned and tested, not battle-tested.
- The default realtime broker is in-process, so channel authorisation is per-instance. Scaling out needs a real broker.
- Rate limiting is in-memory by default and therefore per-instance.
