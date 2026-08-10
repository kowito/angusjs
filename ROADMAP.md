# angusjs roadmap

Optimising for one thing: **how fast someone goes from empty directory to a deployed, authenticated CRUD app.** Everything below is ranked by how much it moves that number, not by how interesting it is to build.

---

## The thesis

One field declaration already produces seven things:

```ts
title: f.char({ maxLength: 200 })
```

→ the column, the migration, the insert/row types, the validator, the OpenAPI component, the admin widget, the MCP tool parameter.

**That is the product.** Not the ORM, not the router — the fact that they share one source of truth. Every roadmap item should either add an eighth output to that declaration or remove a reason to leave the framework.

Positioning: *Django's productivity, TypeScript's inference, agent-native by default, on Bun.*

---

## Where it actually stands

**Strong today.** Models → migrations → REST → admin → OpenAPI → MCP, in minutes. Typed lookups (`views__gte`) with compile-time field checking. 163 tests, clean typecheck.

**The day-2 cliff.** Every real project hits this in week one, and right now angusjs has no answer to any of it:

| Need | Status |
| --- | --- |
| Log a user in | ✗ nothing |
| Two writes in one transaction | ✗ nothing |
| `author.posts` | ✗ nothing |
| Tags on a post (M2M) | ✗ nothing |
| Upload an avatar | ✗ nothing |
| Send a password reset email | ✗ nothing |
| Run a job in the background | ✗ nothing |
| Write a test | ✗ broken export |
| Deploy it | ✗ no story |

A framework that nails day 1 and abandons you on day 2 gets tried and discarded. **Closing this cliff is the whole game.**

---

## Competitive read

| | Batteries | Types | Admin | Agent-native | Runtime |
| --- | --- | --- | --- | --- | --- |
| **Django** | ✓✓ | ✗ | ✓ built-in | ✗ | Python |
| **AdonisJS** | ✓✓ | ✓✓ | bolt-on (AdminJS) | ✗ | Node |
| **NestJS** | ✗ assemble it | ✓ | bolt-on | ✗ | Node |
| **Hono / Elysia** | ✗ | ✓✓ | ✗ | ✗ | Bun |
| **Supabase / Directus** | ✓✓ | ✓ | ✓ | partial | hosted |
| **angusjs** | ✗ *(the gap)* | ✓✓ | ✓ built-in | ✓✓ | Bun |

**[AdonisJS](https://adonisjs.com/) is the real competitor** — mature, fully typed, and it already ships auth, Lucid ORM, mail, queues, cache and testing. Do not try to out-feature it head-on; match its floor, then win on the two columns it can't easily copy.

Two honest notes:

- **The admin is a narrower edge than it looks.** [AdminJS](https://adminjs.co/) has been the Node ecosystem's Django-admin answer for years, and there's a [NestJS port](https://github.com/Theodo-UK/nestjs-admin). The edge isn't "we have an admin" — it's that ours needs *zero configuration and no adapter layer*, because it reads the same field specs. Market it that way.
- **Agent-native is genuinely uncontested.** Nothing in that table generates an MCP server from its routes. This is the differentiator with the longest runway.

---

## P0 — Credibility fixes

*Days. These are bugs and omissions that make the package un-adoptable regardless of features.*

| Item | Why |
| --- | --- |
| **Fix the `./testing` export** | `package.json` points at `./src/testing/index.ts`, which **does not exist**. Anyone importing `angusjs/testing` gets a resolution error. Either build it (see P3) or drop the export. |
| **Add a LICENSE file** | `package.json` says MIT; there is no LICENSE. Legally ambiguous, and blocks corporate adoption. |
| **Publish to npm** | `angusjs` is **available**. Claim it before someone else does. (`angus` is taken.) |
| **CI** | GitHub Actions: typecheck + tests on push. Zero-cost credibility signal. |
| **Semver + CHANGELOG** | Pre-1.0 breaking changes are fine, but they must be announced. |

---

## P1 — Auth · **the single highest-value thing you can build**

*L. Nothing else on this list matters as much. Every project needs it on line one, and its absence currently makes the admin dev-only.*

Bun ships `Bun.password` with argon2id, so this needs no crypto dependency.

- **`angusjs/auth` contrib app** — a `User` model that projects can extend, password hashing, and the `authenticate` wiring already anticipated in settings.
- **Sessions and tokens** — signed cookie sessions for the admin and browser clients; API tokens for services; JWT with refresh for SPAs. All three, because "which auth" is the question that stalls adoption.
- **Endpoints out of the box** — register, login, logout, refresh, password reset, email verification. Generated as a router you `include()`.
- **Admin login** — today the admin is open in development and refuses in production. Give it a real login page and this stops being a demo feature and becomes the reason people choose the framework.
- **Permissions** — `isOwner('author')`, groups/roles, per-object checks. The primitives exist; they need a user to check against.
- **Social auth** — Google, GitHub, and one generic OIDC. Table stakes for rapid dev.
- **Scoped API keys** — the natural authority mechanism for MCP callers (see the moat section).

**Ship order within P1:** password + session + login/logout → admin login → tokens/JWT → reset/verify → social. Get to "the admin has a login page" as fast as possible; that's the demo.

---

## P2 — ORM depth

*L. Removes daily friction and two real correctness risks.*

- **Transactions** — `atomic()` with savepoint nesting. Currently there is *no way* to make two writes atomic. This is a correctness hole, not a convenience gap.
- **F-expressions** — `update({ views: F('views').add(1) })`. The example's view counter does `views: existing.views + 1`, a read-modify-write that **loses increments under concurrency**. The framework should make the safe version the easy one.
- **Reverse relations and `prefetchRelated`** — `author.posts` doesn't exist, so every list view with related data is an N+1 waiting to happen. `selectRelated` only solves the many-to-one direction.
- **Many-to-many**, with through models. Tags, roles, memberships — you cannot model a normal app without it.
- **Abstract models / mixins** — `TimestampedModel`, `SoftDeleteModel`. Django's most-copied pattern.
- **Signals / lifecycle hooks** — `beforeSave`, `afterCreate`. Needed for audit trails, cache invalidation, denormalisation.
- **`annotate` / `groupBy`** — aggregates per group, not just per queryset.
- **Cursor pagination** — offset pagination degrades badly past a few thousand rows.
- **Decide on MySQL** — currently excluded because Drizzle's MySQL driver lacks `RETURNING`. Either implement the `SELECT`-after-write fallback or say "Postgres and SQLite, deliberately" in the README. Ambiguity costs more than either answer.

---

## P3 — Rapid-development multipliers

*M–L. This is where "rapid" stops being a claim and becomes measurable.*

- **Typed client generation** — `angus client --out ../web/src/api.ts`, emitting a fully typed fetch client. Elysia's Eden may make this nearly free. **For a fullstack developer this is the single biggest time saver on the list** — it collapses the backend/frontend contract to zero work. Consider optional React Query hook generation.
- **`angus generate crud <Model>`** — one command producing model + serializer + viewset + admin registration + migration. The scaffolding exists per-app; make it per-model.
- **Testing utilities** (`angusjs/testing`) — test client, transactional test cases that roll back, model factories, `createUser()` helpers. This closes the P0 bug *and* removes a real adoption blocker: people don't adopt frameworks they can't test.
- **Fixtures and seeding** — `angus loaddata` / `dumpdata`, plus a `seed.ts` convention. Demos and onboarding both need it.

---

## P4 — Batteries

*XL cumulatively. Ship in the order below; each one independently removes a reason to leave.*

1. **Background jobs** — in-process queue for dev, Postgres- or Redis-backed for production; retries, dead-letter, scheduled/cron tasks. The most-requested thing after auth.
2. **Email** — console/SMTP/Resend backends and templates. P1's password reset depends on this; build them together.
3. **File storage** — `f.file()` / `f.image()`, local and S3 backends, signed URLs, image resizing. Blocks any app with an avatar.
4. **Caching** — cache API, per-view caching, invalidation on save (needs P2 signals).
5. **Throttling** — per-user and per-IP rate limits, DRF-style.
6. **Realtime** — WebSockets and SSE. Elysia supports both natively, so the cost is low and the demo value is high.
7. **Full-text search** — Postgres FTS behind a `search()` queryset method.

---

## P5 — Production readiness

*M. Not exciting; entirely decisive when someone evaluates for real work.*

- Structured logging with request IDs; OpenTelemetry traces.
- Health and readiness endpoints; graceful shutdown; pool tuning.
- **Typed env config** — `defineEnv({ DATABASE_URL: z.string() })`, validated at boot. Nothing wastes more time than a misconfigured deploy failing at first request.
- **Migration safety** — `angus migrate --check` for CI, dry-run SQL, guidance on backwards-compatible migrations.
- Security defaults: CORS, security headers, CSRF for cookie sessions (needed the moment P1 ships cookies).
- A Dockerfile and one-command deploy recipes for Fly/Railway.

---

## P6 — Adoption

*Continuous. A framework nobody can learn is not a framework.*

- **Documentation site.** This is make-or-break and is worth more than any two features on this list. Django and AdonisJS both win substantially on docs.
- **Benchmarks** against Nest and Adonis. Bun is a real advantage — prove it with numbers.
- **Project templates** — `angus startproject --template saas` (auth + billing + admin + jobs preconfigured).
- Example apps, a plugin/contrib convention, and somewhere to ask questions.

---

## The moat: lean into agent-native

MCP already works and **nothing else in the market has it.** Cheap ways to extend a lead you already hold:

- **Scoped tool authority** — per-tool permission scopes so an agent gets `post-list` but never `post-destroy`. Pairs directly with P1's API keys.
- **Agent audit log** — every tool call recorded with actor, arguments and result. The first question any company asks before letting an agent touch production data.
- **Elicitation on destructive tools** — use MCP's input-required flow to force human confirmation before a delete.
- **MCP resources** — expose the schema, the OpenAPI document and the docs as resources, so an agent can *read about* the API before calling it.
- **`angus mcp install`** — write the config block into Claude Desktop / Claude Code for the user. Removes the last step between "I built an API" and "my agent can use it."

The pitch writes itself: *build a CRUD API and your agent can drive it, with permissions, in one command.* No one else can say that today.

---

## Suggested 90-day sequence

Assuming one developer:

| Weeks | Focus |
| --- | --- |
| 1 | P0 in full. Publish `angusjs@0.1.0`. |
| 2–5 | **Auth**: password → session → login endpoints → **admin login** → tokens. |
| 4–6 | Transactions, F-expressions, reverse relations, M2M *(overlaps auth; different part of the codebase)*. |
| 6–8 | Testing utilities, typed client generation, `generate crud`. |
| 8–11 | Jobs + email together, then file storage. |
| 11–12 | Env config, Docker, deploy recipe, benchmarks. |
| Throughout | Docs for every feature as it lands — never after. |

**Ship 0.1.0 to npm in week 1, even incomplete.** A published package with a real README attracts feedback that changes what's worth building next; an unpublished one attracts nothing.

---

## Definition of "strong"

A concrete target to measure against, rather than a feeling:

> A developer who has never seen angusjs goes from `angus startproject` to a **deployed, authenticated CRUD API with an admin, typed client, and working agent integration in under 10 minutes.**

Today that path stops dead at "authenticated." Everything in P0–P3 exists to unblock this sentence.

---

## Explicit non-goals

Saying no is what keeps the above achievable:

- **Not a frontend or SSR framework.** Generate a typed client; let people pick their own UI.
- **Not a BaaS.** People choose this to own their backend.
- **GraphQL: not now.** Revisit only on real demand — OpenAPI + MCP covers the same ground for this audience.
- **i18n: later.** Rarely the blocker for an API-first framework.
- **No multi-runtime support.** Bun-native is a feature; a Node compatibility layer would cost the speed advantage and double the test matrix.
