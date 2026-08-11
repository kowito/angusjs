# Changelog

All notable changes to Angus are recorded here. Pre-1.0, minor versions may
contain breaking changes; those are listed first in each entry.

## Unreleased

### Added — a route-aware test client

`TestResponse.expect(status)` returns the body when the status matches and
throws otherwise. The throw is the point: on a mismatch it includes the response
body, and on a 404 it says what the app actually serves — the wrong method for a
path ("/posts accepts GET, POST"), a trailing-slash miss, a dropped prefix, or a
near-miss path. A bare `NOT_FOUND` makes you guess; the framework knows its own
routes, so this does not.

`client.routes()` lists them directly. Both come from Elysia's own route table,
so they cannot drift from what is served.

This came out of a real episode: chasing a "broken" viewset for twenty minutes
when the actual cause was a test URL with a single-character host
(`http://x/path`) that misparses to a 404. The client uses a safe origin so that
trap cannot recur, and the diagnosis would have ended the hunt on the first
assertion.

### Fixed — stored XSS through URL fields in the admin (security)

A `url` field value rendered into an `<a href>` in the admin was HTML-escaped
but not scheme-checked, and `javascript:alert(document.cookie)` has no
HTML-special characters — so it passed through escaping untouched and executed
when a staff user clicked the link. Because a URL field is caller-supplied (a
profile link, a webhook target), a lower-privileged user could store one that
fires in an admin's authenticated session: stored XSS escalating to admin
account takeover.

Found in a security scan of the whole project. Write-time validation did not
catch it either — `javascript:`, `data:` and `vbscript:` all pass the `uri`
format check.

`safeUrl()` now neutralises `javascript:`, `data:`, `vbscript:` and `file:`
schemes wherever a value becomes an `href` — the admin URL widget and the email
templates. The fix is on the sink, not the write path, because data reaches a
column through bulk import, seeds and raw ORM writes that never touch a
serializer. The visible link text is unchanged, so nothing is silently hidden.

### Changed — project layout

Cross-cutting test suites moved from `src/` to `tests/`, so `src/` is library
code and its unit tests, and nothing that spans several areas at once. It also
keeps them out of the published package.

Added `SECURITY.md` — a framework handling passwords, OAuth flows and agent
authorisation should say where to report a problem, and it documents the
security decisions rather than leaving them to be reverse-engineered. Added
`CONTRIBUTING.md` and `.editorconfig`.

Removed `.client-live.ts`, a generated client left behind by a verification run
and committed by accident.

`bun run test:postgres` refuses to run rather than silently falling back to
SQLite when `ANGUS_TEST_DATABASE_URL` is unset — a Postgres check that quietly
tests SQLite is worse than no check.

### Fixed — three bugs found by running the suite on Postgres

The suite had only ever run on SQLite. Pointing it at a real Postgres server
via `ANGUS_TEST_DATABASE_URL` found three failures immediately, and CI now runs
both.

**Constraint violations were 500s on Postgres.** Drizzle wraps driver errors in
a `DrizzleQueryError` whose message is the SQL rather than the failure, so the
classifier — which read only the top-level message — matched nothing. It now
walks the `cause` chain and prefers SQLSTATE (`23505` and friends), which is
better evidence than message text anyway: standardised, stable, and unaffected
by the server's locale. The 409/400 mapping worked on SQLite the whole time.

**`groupBy` produced invalid SQL on Postgres.** A model's default ordering was
applied to a grouped query, so `ORDER BY id` appeared with no `id` in the
`GROUP BY`. Postgres rejects that outright; SQLite permits a bare column and
returns an arbitrary row's value for it. Inherited ordering is now dropped, and
an ordering the caller asked for by name raises an explanation instead.

**JSON defaults produced invalid DDL.** The test harness rendered a `[]`
default as `String([])` — the empty string — which SQLite stores happily in a
text column and Postgres rejects as invalid JSON.

### Fixed — `startapp` now installs the app it creates

An app scaffolded by `startapp` was created on disk but never added to `apps`
in the settings, leaving the developer to do it from printed instructions. Skip
that step and the app produces nothing — no tables, no routes — and `angus
check` reports a clean project, because from its point of view there is nothing
there.

`generate crud` already registers models with their app for exactly this
reason. This is the same failure one level up, and it is now handled the same
way.

The CI smoke test asserted only that `check` passed, which it did throughout.
It now asserts the models actually arrived.

### Added — documentation site

Thirteen pages in `docs/`, building to a static site with
`bun scripts/build-docs.ts`. The README was carrying 730 lines of reference
material and is now 194, pointing at the pages instead.

The generator is hand-rolled for the same reason the framework has two runtime
dependencies: the whole job is turning a dozen markdown files into a dozen HTML
files with a sidebar. Output is self-contained — no CDN, no build step, no
JavaScript needed to read a page.

### Added — JWT, OIDC and social sign-in

`signJwt` / `verifyJwt` for shared-secret tokens, and `verifyJwtWithJwks` for
the RS256 and ES256 tokens an OIDC provider issues. The algorithm always comes
from the verifier, never from the token's own header — that header is
attacker-controlled, and trusting it is the classic JWT vulnerability.

`socialAuthRoutes` adds sign-in with Google, GitHub or Microsoft: PKCE, `state`
and `nonce` on the way out, all three checked on the way back, then an ordinary
Angus session. The session is deliberately the normal one — proving identity
through a provider should leave nothing downstream caring how you arrived.

The default link policy is `verified-email`: a provider's address links to an
existing account only when the provider verified it. The alternative is account
takeover by registration — sign up at the provider with someone else's address
and log in as them. `any-email` relaxes it and has to be asked for by name.

Angus's own sessions stay opaque and database-backed. A JWT is valid until it
expires and nothing revokes it in the meantime.

### Added — OpenTelemetry tracing

Traces spanning service → query, so the question a slow request always raises —
*where did the time go?* — has an answer. An access log says a request took
900ms; it cannot say that 850ms of it was one N+1 loop inside a service two
calls down.

`@opentelemetry/api` is an optional peer dependency. Without it every function
is a no-op costing one branch, and the framework keeps its two runtime
dependencies. Ask for tracing without the SDK installed and it says so at
startup, rather than leaving you wondering why the traces are empty.

The root span comes from Elysia's `.wrap()`, which is a higher-order function
over the composed handler rather than a lifecycle hook — it runs before
`onRequest` and after the response is built, so it genuinely encloses the
request and everything else nests beneath it.

Request logs now carry the trace ID when one is recording, which is what makes
logs and traces usable together.

### Added — full-text search

`Model.objects.search(query, fields)`, and `?search=` on any view set that
declares `searchFields`.

Postgres gets a real text search engine: stemming, stop words, quoted phrases,
`-` exclusion and relevance ranking. SQLite gets substring matching through the
same call, ranked by how many fields matched. The API is identical because the
alternative — every caller branching on dialect — pushes the problem outward,
and quality degrades in the direction you would want: finding fewer things in
development is an inconvenience, while silently finding *different* things in
production would be a bug.

Postgres uses `websearch_to_tsquery`, not `to_tsquery`. The latter raises a
syntax error on input as ordinary as an unbalanced quote, so a search box wired
to it turns typing into a 500.

### Added — object-level permissions

"Anyone signed in may read a post, but only its author may edit it" was not
expressible. A `Permission` runs before anything is fetched, so it can only ask
about the caller and the URL; a scoped `queryset` would hide other people's
posts from readers as well as from editors.

`objectPermissions` is checked against the row once it is loaded — one function
for every detail action, or an object to vary it per action. Checks may be
async, because object rules often depend on something the row does not carry.

It hangs off the single point every detail action already passes through, so a
rule cannot be enforced on three of them and forgotten on the fourth. A refused
call is answered before any write, and an anonymous caller gets 401 rather than
403, since signing in might actually help.

### Added — realtime application events

Elysia already provides WebSockets, so this is the layer above one. What an
application wants to say is "this order shipped, and the people allowed to know
are the customer and the warehouse" — a statement about the domain, not about
sockets. Left to the transport, that rule gets written once per connection
handler and again for every other way the event needs to go out.

`defineChannel` names an event and decides who may listen. Publishing is a
function call from anywhere; the sockets are a consumer of it rather than where
it lives. `broadcastOnWrite(Model, channel)` wires it to the ORM, and
`filter` narrows one channel per subscriber.

Two transports: a WebSocket at `realtime.path`, and SSE at `${path}/stream` for
clients that only need to receive — it reconnects on its own and passes through
proxies that mishandle upgrades.

The default broker is in-process, which is correct for one server and wrong for
two. `setBroker()` replaces it without any application code changing.

### Added — MCP resources

Tools say what an agent may do; they say little about the shape of the data
behind them. An agent with only tools learns the domain by trying things, which
on a write endpoint means learning by causing failures.

The server now serves `resources/list` and `resources/read`: the model list,
each model's fields with their types, constraints and relations, the route
table, and the OpenAPI document. All generated from the declarations the server
runs on, so what the agent reads is what the API enforces.

The field description answers the question agents get wrong first — which
values the *caller* must supply, as against those the database fills in. A
relation names the model to go and read next rather than the column. The route
resource says a route is guarded without saying how, since the latter is a map
of what to attack.

### Added — agent policy, confirmation and audit

Route permissions already stop an agent exceeding the person operating it,
because tool calls go through those routes. The gap was the other direction: an
agent should usually have *less* authority than its user. "May read orders and
issue refunds, may not delete customers" is not expressible as a user
permission, since the same human can do all three through the admin.

`mcp.policy` says it. `allow`/`deny` decide which tools exist at all — a
withheld tool is absent from `tools/list` and unreachable by name, so the
capability cannot be argued into existence by a prompt. `confirm` keeps a tool
available but makes its effect two steps.

**Deletes now require confirmation by default.** A destructive tool takes a
`confirm: true` argument, declared in its schema, and refuses without it before
the call reaches the database. The requirement lives in the schema rather than
in an elicitation handshake because the modern protocol has no server-to-client
channel on a stateless POST — there is nothing to elicit through. Set
`confirm: []` to opt out.

`mcp.audit` records each call: the tool, the arguments the model chose, the
outcome, and a digest of the caller rather than their token. The HTTP access
log sees the request a tool produced but not the tool, and never sees a call
that was refused before dispatch.

`angus mcp install [claude-code|cursor|claude-desktop]` registers the project
with a client, merging into an existing config rather than replacing it.

### Fixed — constraint violations are no longer 500s

A duplicate value, or a foreign key pointing at a row that does not exist, was
reported as `500 ServerError` with the driver's message and a stack trace. Both
are caused by the submitted data, so they belong to the caller: they are now
`409 Conflict` and `400 Bad Request`, with the offending column named under
`errors` so a form can put the message beside the input.

This also stops constraint failures from burying real 500s in the logs. The
admin now shares the same classifier rather than keeping its own copy of the
driver patterns.

### Added — generators and seeding

`angus generate crud <app> <Name> [field:type ...]` scaffolds a model,
serializer, view set and admin registration into an app that already exists —
the second and third model being the common case, and copying the first by hand
being where consistency starts to drift.

Generated code is appended, never overwritten, and the generator manages imports
and registers the model in the app's `models` map. Both matter: appending a
reference without its import breaks the build at the moment the tool reports
success, and a model missing from `models` gets no table, which only shows up at
the first request.

`angus seed` runs a project's `seed.ts` inside a transaction, so a seed that
fails halfway leaves the database as it was. A script rather than a fixtures
format, because "an author, then twenty posts belonging to them" is what seeding
is usually for and a JSON fixture cannot say it.

### Added — ORM ergonomics

Field mixins (`timestamps()`, `softDelete()`, `publicId()`) as plain objects
rather than model inheritance, so what ends up on the table stays visible at the
declaration.

`softDelete()` adds `deletedAt` plus `alive()`, `deleted()`, `softRemove()` and
`restore()`. It deliberately does **not** make `delete()` soft: silently
reinterpreting a call means a developer reading it cannot tell what it does.

`groupBy()` aggregates per group, the counterpart to `aggregate()`. `page()`
does keyset pagination — one query per page, no count, and immune to the
shifting that makes offset pagination show a reader the same row twice.
`Model.objects.query()` exposes the Drizzle builder for anything the lookup
language cannot express.

`Manager` was missing `aggregate`, `values` and `limit` proxies; added.

### Decided — MySQL

Not supported, and settled rather than pending. Every write uses `RETURNING` so
`create()` and `update()` return the row as stored. Drizzle's MySQL driver has
none, and the follow-up `SELECT` that would replace it is a second round trip,
not atomic with the write, and can return another transaction's version of the
row. Two write paths with different consistency guarantees is worse to own than
one missing dialect.

### Added — cache and model hooks

`cached()`, `getCache()`, `cacheResponses()` and a `CacheStore` interface with an
in-memory default. `getOrSet` shares one in-flight computation per key, so a hot
key expiring does not make every concurrent request recompute it. Tags group
entries so one write clears everything derived from a model.

Model hooks — `onModel(Post, 'beforeCreate', ...)` — fire on ORM writes, with
`before` hooks able to reshape the payload and `beforeDelete` seeing the rows
about to go. `invalidateCacheOnWrite(Model)` wires the two together in a line.
Hooks do not fire for raw SQL or migrations, and say so.

`cacheResponses()` skips authenticated requests unless `varyByUser` is set:
caching a personalised response under a shared key is a data leak, not a
performance bug.

### Added — file storage

`f.file()` and `f.image()` as IR field kinds, so validation, the admin widget
and the OpenAPI schema all follow from one declaration — and the conformance
suite covers them like every other kind.

The column holds a storage **key**, not bytes: rows stay small, a CDN becomes
possible, and moving from local disk to S3 is configuration rather than schema.
Backends are `localStorage()`, `s3Storage()` (via Bun's built-in S3 client, so
no AWS SDK and real presigned URLs) and `memoryStorage()` for tests.

Uploads use a dedicated endpoint rather than multipart on every write, which
keeps JSON endpoints — and the generated client — free of multipart.

Path traversal is made inexpressible rather than detectable: `safeKey()` strips
every separator and dot-segment, and the local backend re-checks the resolved
path against its root regardless.

### Added — background jobs

`job()`, `enqueue()`, `schedule()`, `startWorker()` and `angus worker`.

The queue is a table in the project's own database rather than Redis, which
buys the property that matters most: **enqueueing joins the caller's
transaction**, so a job cannot outlive a rolled-back write. That race is
unavoidable with a separate broker and is the most common source of phantom
jobs. The cost is throughput — polling suits emails, webhooks and thumbnails,
not a firehose — and the storage is separable so a Redis queue can replace it.

Retries use exponential backoff; a stalled worker's jobs are reclaimed when
their lease expires; `uniqueKey` prevents a second pending copy; and a job whose
code has been deleted fails immediately rather than spinning. Schedules use
intervals rather than cron, and derive a per-slot deduplication key so several
workers still enqueue once.

Delivery is at-least-once and documented as such: a worker can succeed and die
before recording it, so handlers must be idempotent.

### Added — email

Four backends: `consoleBackend()` (stderr, the default), `memoryBackend()` (an
assertable outbox for tests), `httpBackend()` (Resend by default, other
providers through `body`), and `nullBackend()`.

`redirectTo` diverts every recipient to one address while recording the
originals in `X-Original-To` — the safety catch for staging against a copy of
production data.

**Password reset now sends itself.** It previously needed a `sendPasswordReset`
callback; the built-in template goes through the configured backend, and a
delivery failure is logged rather than surfaced, because a 500 there would
confirm the account exists.

SMTP is deliberately absent: a correct client means STARTTLS, several AUTH
mechanisms, line folding and dot-stuffing, none of which could be verified here.
A client that drops mail silently is worse than an honest gap, and
`EmailBackend` is one method.

`angus check --deploy` now flags an unconfigured backend, and a `console`,
`memory` or `null` backend in production — all of which accept mail and send
nothing.

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
