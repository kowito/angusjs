# Changelog

All notable changes to Angus are recorded here. Pre-1.0, minor versions may
contain breaking changes; those are listed first in each entry.

## Unreleased

### Added — typed client

**`angus client`** generates a typed fetch client from the same route
definitions that produce the OpenAPI document, so it cannot describe an endpoint
the server does not have.

The output is self-contained — its own interfaces, error class and fetch wrapper,
importing nothing — because a frontend should not have to install the backend
framework to call the API. Failures throw `ApiError` carrying the error
contract's `status`, `code`, `detail` and field-level `errors`.

Eden was investigated first, per the governing rule. It imports the server's
*type*, which needs the client to compile against the server's source — fine in a
monorepo, impossible across repos — and it cannot see Angus routes at all,
because mounting them as data is exactly what erases the per-route types Eden
reads.

Component names that would clash with the generated runtime (`Error`,
`Response`, `ClientOptions`) are renamed rather than left to shadow it.

### Added — relations

**`prefetch()`** for reverse relations. `selectRelated` joins the many-to-one
direction; a one-to-many join would multiply the parent row and break `limit`,
so this issues one extra query per relation instead — 50 authors with their
posts is two queries, not fifty-one.

```ts
const authors = await Author.objects.prefetch({ posts: Post })
authors[0].posts   // PostRow[], typed, no second round trip
```

The related model is passed explicitly rather than looked up by a reverse name,
which keeps the result typed without a global registry and keeps the extra query
visible at the call site. An ambiguous relation — two foreign keys pointing at
the same model — is an error naming the `via` that resolves it, rather than a
guess that would produce quietly wrong data.

**Many-to-many** via `manyToMany({ from, to, through })`. The join table is an
ordinary model you define, never a hidden one the ORM owns — because the "extra
column on the join" moment arrives in almost every project, and in ORMs that
hide the table it means migrating to a through model you should have had from
the start.

`add()` ignores links that already exist rather than raising a uniqueness error,
so a resubmitted form is harmless. `set()` runs in one transaction and leaves
untouched links alone, preserving their extra columns. `forMany()` groups by
owner in two queries regardless of how many owners.

### Fixed — testing

- **`countQueries()` counted nothing.** Drizzle keeps its logger on the
  *session*, not the database object, so swapping `db.logger` was a no-op — an
  N+1 assertion would have passed while proving nothing. It now swaps
  `db.session.logger`, and the prefetch suite asserts the query count stays at 2
  as the row count grows.

### Added — production layer

**Security.** `csrf()`, `securityHeaders()` and `cors()`, on by default where
appropriate. CSRF applies only to *ambient* credentials: a cookie is ambient, an
`Authorization` header is not, because an attacker's page cannot make the
browser attach one — so cookie-authenticated writes must prove same-origin and
bearer clients are unaffected. `cors({ origin: '*', credentials: true })` now
throws at configuration time rather than producing a combination browsers reject
and that would defeat the CSRF check.

**Rate limiting.** `throttle()` with a `ThrottleStore` interface and an
in-memory default, tighter rules on login, registration and password reset.
Enabled automatically in production only: five attempts per five minutes is
right against credential stuffing and wrong while building a login form.

**Health probes.** `/healthz` (liveness) deliberately touches nothing external —
if it checked the database, one blip would fail every replica and the
orchestrator would restart them all. `/readyz` (readiness) does check, plus any
custom checks, so a struggling instance leaves the pool without being killed.

**Observability.** A request id on every response, preserving an inbound
`x-request-id` so a trace survives across services, and one structured log line
per request with method, path, status and duration.

**Graceful shutdown.** `stop()` drains in-flight requests up to
`server.shutdownTimeoutMs` before closing the database, so a rolling deploy
doesn't 502 requests that were already in progress.

**Typed configuration.** `defineEnv()` validates the environment once at import
and reports every problem at once, so a missing variable fails at boot rather
than at the first request that needed it.

**Deployment audit.** `angus check --deploy` reports what is invisible in
development and expensive in production — debug mode, an unguarded admin,
disabled CSRF or throttling, SQLite on an ephemeral filesystem, an in-memory
rate-limit store behind several replicas. Findings carry stable ids that can be
silenced deliberately, and the command exits non-zero on any error.

**Migration safety.** `angus migrate --check` exits non-zero when migrations are
unapplied, so a pipeline can refuse to promote a build; `--dry-run` prints the
SQL without executing it. Both are safe in CI.

**Deployment scaffolding.** `startproject` now writes a multi-stage `Dockerfile`
that runs as a non-root user with a liveness-only healthcheck, a
`.dockerignore`, and a `.env.example`.

**App metadata.** `AppConfig.meta` lets an app declare structured facts for
tooling that inspects a project without running it.

### Added

**Application services** — the fourth primitive, alongside models, serializers
and view sets. A service declares its input schema, output schema, permissions
and transaction boundary; REST, OpenAPI, MCP and the CLI all read that one
declaration rather than re-implementing the operation.

```ts
export const approveInvoice = service({
  name: 'approve-invoice',
  input: t.Object({ invoiceId: t.Numeric() }),
  output: InvoiceSerializer.read,
  permissions: [isStaff],
  async handler({ input, actor }) { /* ... */ },
})

router().post('/invoices/:invoiceId/approve', fromService(approveInvoice, {
  params: t.Object({ invoiceId: t.Numeric() }),
}))
```

Mounting is the only adapter: OpenAPI and MCP already read the route table, so
a mounted service reaches every surface with no second registration and no
second place for them to disagree. Also callable as `angus run approve-invoice
--invoiceId 3`.

**Identity and authorization** (`angusjs/auth`) — one security model consumed by
REST, the admin and MCP alike.

- `User`, `Session` and `VerificationToken` models. Sessions cover browser
  logins and API tokens, which differ only in how the secret travels.
- argon2id password hashing via `Bun.password` — no dependency added.
- Endpoints: login, logout, register (opt-in), `me`, API token issue/list/revoke,
  password change, password reset request and confirm.
- Bearer tokens and `HttpOnly` session cookies resolve to the same identity.
- Permissions: `isAuthenticated`, `isStaff`, `isSuperuser`, `hasRole`,
  `hasScope`, `isOwner`, `all`, `any`, and `ownedBy` for row-level scoping.
- **Admin login** (`adminAuthApp()`), so the admin is no longer development-only.

**Transactions** — `atomic()` with savepoint nesting, and `rollbackAfter()`.
Ambient via `AsyncLocalStorage`, so a query several frames deep inside a service
joins the transaction without a handle being threaded through.

**F-expressions** — `update({ views: F('views').add(1) })` compiles to
`SET views = views + 1`, which the database applies atomically. Also usable to
compare two columns in a filter: `filter({ price__lt: F('cost') })`.

**Testing utilities** (`angusjs/testing`) — `testDatabase()` creating tables
directly from model definitions, `transactional()` cases that roll back,
`TestClient` driving the app with no port, and `factory()` for fixtures.

**Elysia plugin surface** (`angusjs/plugin`) — `angus()`, `mount()`,
`openapi()`, `mcp()` and `admin()` as ordinary Elysia plugins, so an existing
Elysia application can adopt one piece without adopting the conventions.

**Error contract** (`ERROR_CODES`) — a stable machine-readable `code` on every
error response, so clients branch on a code rather than matching a message.
Shared by REST, the admin, MCP and OpenAPI.

**IR conformance suite** — asserts that every field kind produces a coherent
result on all four consumers (Drizzle column, TypeBox schema, admin widget, MCP
tool parameter). Adding a field kind now means filling in a table row; omitting
a consumer fails here rather than in an application.

### Fixed

- **`atomic()` does not use Drizzle's `bun-sqlite` transaction**, which is
  synchronous and silently commits when its callback is async — a thrown error
  did not roll back. Angus issues `BEGIN`/`SAVEPOINT` itself on SQLite; Postgres
  keeps the driver's own transaction because its connection is pooled.
- `json` fields serialised to an empty `{}` schema, telling OpenAPI readers and
  agents nothing. Found by the conformance suite.
- A permission may now short-circuit with a `Response`, which is what lets the
  admin redirect an anonymous browser to a login page instead of returning 403.
- `./http` was exported without a barrel file and failed to resolve.
- `./testing` pointed at a file that did not exist; it now has an implementation.

### Added — housekeeping

- `LICENSE` (MIT), which `package.json` had claimed without shipping.
- GitHub Actions CI: typecheck, tests, and a scaffold smoke test that catches a
  broken generator — invisible to unit tests, fatal to every new user.
- This changelog.

## 0.1.0

Initial release: models, migrations, QuerySets with typed lookups, serializers,
views and view sets, permissions, admin, OpenAPI 3.1, MCP (dual-era), and the
`angus` CLI.
