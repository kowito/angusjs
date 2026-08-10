# Angus roadmap

## Thesis

> **Optimising for one thing: how fast someone goes from an empty directory to a production application on Elysia.**

Angus provides the application-level primitives Elysia intentionally leaves open: domain models, persistence, identity, authorization, admin, application services, typed clients, background work, and agent interfaces.

**Elysia is the foundation. Angus is the application layer.**

The architectural north star underneath that:

> **One field declaration should be able to drive every application surface derived from that field.**

Every item below either adds a surface to that declaration, removes a reason to leave the Elysia ecosystem, or deletes conceptual surface area. Items that do none of the three don't belong here.

---

## The governing rule

> **If Elysia already solves it well, Angus integrates with it. If Angus discovers that Elysia needs a better primitive to support production applications, improve Elysia rather than rebuilding that primitive inside Angus.**

This is not deference for its own sake. It produces a flywheel:

```text
   Angus drives real application requirements
                    ↓
            Elysia gets stronger
                    ↓
             Angus gets stronger
                    ↓
   Elysia becomes a more credible foundation
                    ↓
              (repeat)
```

The failure mode this rule prevents: Angus quietly reimplementing routing, validation, or transport because a seam was slightly awkward, and ending up as a framework that *contains* Elysia rather than one that *extends* it.

---

## The real constraint

Implementation capacity is not the limiting factor. **Conceptual surface area is.**

Every primitive added is something a developer must learn, hold in their head, and debug at 2am. A framework with forty well-built concepts is worse than one with twelve, even if the forty are individually excellent — and it is much worse to teach.

So the recurring question for each item is not *can we build this?* but:

> **What is the smallest coherent abstraction that covers this need, and does it belong in Angus at all?**

Where two proposed primitives overlap, the roadmap should collapse them. Where a primitive only serves one surface, it probably belongs in application code, not the framework.

---

## Landscape

Django and AdonisJS are **reference points, not enemies**. They have both proven which conventions production applications actually need; that evidence is worth more than a feature-parity contest.

```text
                     Application layer
                            ↑
                            │
          Django ───────────┼─────────── AdonisJS
                            │
                       ┌────┴────┐
                       │  Angus  │
                       └────┬────┘
                            │
                       ┌────┴────┐
                       │ Elysia  │
                       └────┬────┘
                            │
                           Bun
```

The question is not *"can Angus beat AdonisJS on battery count?"* It is:

> **"Can Angus make Elysia a credible choice for an entire application lifecycle?"**

That reframing changes what to build and, more importantly, what to skip.

---

## Definition of strong

Two benchmarks, because one measures velocity and the other measures whether the velocity survives contact with a real project.

### Golden path — day-1 velocity

> **Empty directory → deployed, authenticated CRUD application in under 10 minutes.**

### Production path — day-2 continuity

> **That same application can add transactions, relations, domain services, background jobs, file storage, email, permissions, testing, observability and agent access without leaving the Angus/Elysia ecosystem.**

```text
                      ANGUS
                        │
            ┌───────────┴───────────┐
       Day-1 velocity          Day-2 continuity
            │                       │
         <10 min            never leave Elysia
            └───────────┬───────────┘
                        ▼
              Production application
```

Today the golden path stops at "authenticated," and the production path stops at "transactions." Both are P0–P2 problems.

---

> **Status, updated.** Much of P0–P2 now ships. Done: the IR conformance suite,
> the Elysia plugin surface, the error contract, testing infrastructure,
> LICENSE/CI/changelog, the identity and authorization model with admin login,
> transactions, F-expressions, and application services. Outstanding in those
> phases: relations (reverse, prefetch, M2M), OIDC, and the MySQL decision.
> See [CHANGELOG.md](CHANGELOG.md).

## P0 — Core contract and ecosystem foundation

*The contracts everything else is built on. Getting these wrong is expensive later in a way that a missing feature never is.*

### Canonical model IR

The single most important piece of the project, and mostly latent already.

```text
                    defineModel()
                          ↓
                       Model IR
                          ↓
   ┌────────┬────────┬────┴───┬────────┬────────┬────────┐
   DB     Types  Validation  REST   OpenAPI   Admin     MCP
```

`FieldSpec` and `RouteDefinition` are already this in embryo — dialect-free descriptions that four and three consumers read respectively. What's missing is treating them as a **published contract** rather than an implementation detail:

- A documented, versioned IR shape, stable across minor releases.
- A conformance test suite: for every field kind, assert the column, the TypeBox schema, the admin widget, the OpenAPI fragment and the MCP parameter it produces. **Adding a field kind should mean filling in a table, not touching six subsystems.**
- Serializable to JSON, so external tooling (client generators, docs, editor plugins) can consume it without importing Angus.
- An extension point, so a third party can add a field kind and have every surface pick it up.

This is worth more than any individual ORM feature. It is the mechanism by which the SSoT thesis stays true as the surface count grows.

### Elysia-native plugin surface

Angus composes today via `router().toElysia()`, which works but reads as a seam rather than an invitation. Make the ecosystem shape explicit:

```ts
new Elysia()
  .use(angus(settings))
  .use(auth())
  .use(admin())
  .use(mcp())
```

Each returns a real Elysia plugin. **Incremental adoption is a first-class path, not a fallback** — an existing Elysia application should be able to take models without taking the CLI, or the admin without taking the ORM.

### Error contract

One canonical error model, consumed by every surface:

```text
              Angus error
                   │
   ┌───────┬───────┼───────┬────────────┐
  REST   Admin    MCP   OpenAPI   Typed client
```

`APIError` already does this for REST and MCP. Formalise it: a stable code taxonomy, field-level detail shape, and a documented mapping to HTTP status, MCP `isError`, admin form errors, and generated client error types. Clients should be able to branch on a code, not parse a string.

### Application context

Define precisely what Angus adds to Elysia's context, and make it typed:

```text
request → identity → permissions → scope → services
```

This is the foundation P1, the admin and MCP all build on. Getting it right once means authorization is uniform by construction rather than by discipline.

### Testing infrastructure — **moved from P3**

A framework that derives five interfaces from one declaration needs contract tests from day one, not after the interfaces multiply.

- `angusjs/testing`: test client, transactional cases that roll back, model factories, identity helpers.
- The IR conformance suite described above.
- Cross-surface tests asserting REST, admin and MCP agree about the same operation.

*(The broken `./testing` export has already been removed rather than left pointing at a missing file; it returns with the implementation.)*

### Housekeeping

LICENSE file, npm publish (`angusjs` is still available), CI, changelog, semver policy.

---

## P1 — Application identity and security

*Not "add login." Build one security architecture that every surface consumes.*

```text
   Authentication
        ↓
     Identity
        ↓
  Roles / permissions
        ↓
      Scopes
        ↓
 Object-level authorization
        ↓
   QuerySet filtering
```

Then, and this is the point:

```text
                  Security
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
      REST         Admin         MCP
```

**Build the model first, the features second.** Password login, API tokens and OIDC should all be authentication *strategies* plugged into one identity pipeline — not three parallel implementations that happen to coexist.

**Authentication.** Password (argon2id via `Bun.password`, no dependency), sessions, API tokens, JWT with refresh, OIDC/social. Password reset and email verification.

**Authorization.** Roles and permissions, scopes, object-level rules, and — critically — **queryset filtering as a first-class authorization mechanism**. `queryset: (ctx) => ...` already scopes reads and writes; make it the documented way to express row-level security so it can't be forgotten on one surface.

**Admin, promoted.** Admin login, admin permissions, then admin actions and an audit log. The admin is the most legible demonstration of the whole thesis — `f.char({ choices })` becoming a dropdown, `f.foreignKey()` becoming a relation picker — and it stays a demo until it has real auth.

**Hardening.** CSRF for cookie sessions, security headers, session fixation and timing-safe comparison.

### Email ships with P1, not P4

Password reset and verification *are* email features. Auth must not depend on a future phase.

```text
P1  Identity
    ├── Password · Sessions · Tokens · OIDC
    ├── Password reset · Email verification
    ├── Roles · Permissions · Object-level
    └── Email  ── console · SMTP · Resend · templates
```

Scope the email work to exactly what auth needs plus a clean backend interface. Templating and campaigns are not P1.

---

## P2 — Production data layer, and application services

*Two tracks, both about correctness rather than features.*

### Data layer

Correctness first — these are holes, not conveniences:

```text
Transactions · F-expressions · Relations · Prefetch · M2M · Constraints
```

- **Transactions.** `atomic()` with savepoints. There is currently *no way* to make two writes atomic.
- **F-expressions.** The example's view counter does `views + 1` in JS — a read-modify-write that loses increments under concurrency. Make the safe form the easy form.
- **Reverse relations and `prefetchRelated`.** `selectRelated` solves only many-to-one, so any list with related data is a latent N+1.
- **Many-to-many with through models.**
- **Constraints.** Check constraints, composite uniqueness, deferred FKs.

Then ergonomics:

```text
Soft delete · Timestamp models · Hooks · Aggregations · Cursor pagination
```

And explicit escape hatches, so Angus doesn't have to become the whole database ecosystem:

```ts
Model.query()   // Drizzle query builder, typed to this model
Model.db()      // raw connection
Model.raw(sql)  // raw SQL, rows mapped back to the model
```

> Angus provides a productive ORM abstraction without trying to own everything a database can do. **This is where discipline matters most** — the temptation is to keep adding query features until the abstraction is as large as SQL, at which point developers would rather write SQL.

Also: decide MySQL. Implement the `SELECT`-after-write fallback for the missing `RETURNING`, or state "Postgres and SQLite, deliberately." Ambiguity costs more than either answer.

### Application services — the missing primitive

Today the vocabulary is:

```text
Model → Serializer → ViewSet
```

That covers CRUD and nothing else. Real applications have operations that aren't CRUD:

```ts
approveInvoice()   cancelInvoice()   refundInvoice()
transferOwnership()   publishPost()
```

These need to be callable from every surface, with one implementation:

```text
    REST      Admin      MCP       CLI       Jobs
      └──────────┴─────────┼─────────┴─────────┘
                           ▼
                 Application Service
                           ▼
                        Model
                           ▼
                       Database
```

**A service is a declaration, exactly like a model** — which is what keeps the SSoT thesis intact one level up:

```ts
export const publishPost = service({
  name: 'publish-post',
  input: t.Object({ postId: t.Numeric(), notify: t.Optional(t.Boolean()) }),
  output: PostSerializer.read,
  permissions: [isStaff],
  transactional: true,
  async handler({ input, actor, tx }) { /* ... */ },
})
```

Each surface is then a *reader* of that declaration, not a re-implementation:

| Surface | How it consumes the service |
| --- | --- |
| REST | `router().post('/posts/:id/publish', fromService(publishPost))` |
| MCP | becomes a tool automatically, with the same permissions |
| Admin | appears as a row or bulk action |
| CLI | `angus run publish-post --postId 3` |
| Jobs | `enqueue(publishPost, { postId: 3 })` |

**This is what turns Angus from a sophisticated CRUD generator into an application framework.** It is also the natural home for transactions (`transactional: true`), for the audit log, and for agent confirmation on destructive operations — all of which otherwise get reimplemented per surface.

---

## P3 — Developer experience

> **Objective: make the Elysia + Angus development loop extremely short.**

The CLI is the glue that makes the architecture visible:

```bash
angus create my-app     # scaffold
angus dev               # run, watch, migrate
angus generate model Product
angus generate crud Product
angus migrate
angus test
angus client            # typed client
angus seed
```

### Typed client — highest priority in this phase

It completes the SSoT chain end to end:

```text
Model → API → OpenAPI → Client
```

The target experience:

```ts
const users = await api.users.list({ search: 'ada' })
const user  = await api.users.get(id)
await api.users.update(id, { name: 'Tom' })
```

with the types coming from the same backend declaration — no codegen drift, no hand-written fetch wrappers.

**Investigate Elysia Eden before building anything.** Elysia already has a typed client story; if Eden can carry this, the right move is to make Angus routers Eden-compatible and contribute whatever is missing upstream, rather than inventing a parallel type pipeline. This is the governing rule's first real test.

### Generators and fixtures

`generate crud` producing model, serializer, viewset, admin registration and migration in one command. Fixtures and seeding for demos, onboarding and tests.

---

## Agent-native track

**MCP is not a future moat — it is part of the identity of Angus.** It already works, so the roadmap is about depth, and it threads through the phases rather than sitting at the end:

| Phase | Agent capability |
| --- | --- |
| P0 | Tool schema generation from the IR — **shipped** |
| P1 | Tools inherit the identity and permission model |
| P2 | Per-tool scopes; services become tools with their own authorization |
| P3 | Agent audit log; confirmation on destructive actions via MCP elicitation |
| P4 | MCP resources — schema, OpenAPI and docs readable by the agent before it acts |

The architecture that matters:

```text
                     Angus
                       │
              Application Service
                       │
            ┌──────────┴──────────┐
            ↓                     ↓
          REST                   MCP
```

Same business logic, same permissions, same validation, same identity. **That is the moat** — not the fact that tools exist, but that they cannot diverge from the API.

Plus `angus mcp install`, writing the config into Claude Desktop or Claude Code directly — the last step between "I built an API" and "my agent can drive it."

---

## P4 — Batteries for Elysia applications

*In this order. Each independently removes a reason to leave.*

**P4.1 Jobs** — job, queue, retry, dead letter, schedule, cron. In-process for dev, Postgres- or Redis-backed for production. Services are the unit of work, so `enqueue(publishPost, {...})` needs no new abstraction.

**P4.2 Email** — if any of it remains after P1.

**P4.3 Storage** — `f.file()` and `f.image()` as IR field kinds, so they flow to validation, admin widgets and OpenAPI for free. Local, S3, R2, signed URLs.

**P4.4 Cache** — cache API, per-view caching, invalidation via model hooks.

**P4.5 Rate limiting** — per-user and per-IP, applied at the route so every surface inherits it.

**P4.6 Realtime** — **Elysia-native by construction:**

```text
Elysia WebSocket / SSE
          ↓
  Angus application events
```

Don't rebuild transport primitives Elysia already provides. Angus's contribution is the *event* layer — model change events, permission-aware subscriptions — riding on Elysia's transport.

---

## P5 — Operational layer

*Not "deployment recipes." Operational correctness in production.*

- Health and readiness endpoints; graceful shutdown; connection pool behaviour under load.
- Structured logging with request IDs; OpenTelemetry traces spanning route → service → query.
- Typed, validated configuration — fail at boot, not at first request.
- Migration safety: `migrate --check` for CI, dry-run SQL, backwards-compatible migration guidance, and a documented zero-downtime story.
- Security headers, CORS, CSRF (from P1), rate limits (from P4.5) as defaults rather than opt-ins.

Deployment recipes are secondary. Optimise for *"the application is operationally correct"*, not *"it deploys to Fly."*

---

## Continuous tracks

These are not phases. They run alongside everything.

### Documentation

**Documentation is infrastructure, not an adoption phase.** Every feature lands with implementation, tests, docs and an example — in the same change. By the time P1 ships, the docs should already teach the whole path:

```text
Elysia → Angus → Model → API → Auth → Admin
```

Undocumented architecture accumulates a debt that gets more expensive to pay the longer it is deferred, because the person who understood it has moved on.

### Elysia contribution track

The roadmap's second question, alongside *what should Angus build?*:

> **What should Angus prove, improve, or contribute back to Elysia?**

```text
   Angus requirement
          ↓
  Elysia primitive insufficient
          ↓
      Improve Elysia
          ↓
     Angus consumes it
          ↓
  Production validation
```

Concrete candidates, from friction hit while building the current version — these are observations, not complaints, and each needs upstream discussion before it is a proposal:

- **Response vs request schema types.** `t.Integer` is coercing and serialises to `anyOf: [string, integer]`, which is right for a request and wrong for a response. Angus works around this by building response schemas from plain TypeBox. A first-class direction-aware type would help every Elysia user generating clients or documentation.
- **Body parsing and re-reading.** `request.formData()` throws after Elysia has parsed the body, which is a sharp edge for anything doing custom form handling.
- **Route metadata and introspection.** Angus keeps its own `RouteDefinition` partly because reading a compiled Elysia instance's route table isn't a supported operation. A stable introspection API would benefit every documentation, gateway and tooling plugin.
- **Typed context extension.** Formalising how a plugin contributes typed fields (`user`, `permissions`, `services`) to the context.
- **Plugin composition and lifecycle ordering** for plugins that must run before or after each other.
- **Testing ergonomics** for `app.handle()`-based integration tests.
- **Eden** as the shared typed-client substrate, rather than each framework growing its own.

This turns Angus into an **Elysia proving ground**, which is strategically worth more than making Angus bigger.

---

## 90 days

| Period | Focus | Outcome |
| --- | --- | --- |
| Week 1 | Core contract, IR conformance suite, testing utilities, npm, CI, docs foundation | Credible package |
| Weeks 2–3 | Identity pipeline, sessions, permissions | Secure application |
| Weeks 3–4 | Admin auth, roles, object permissions, email | Production admin |
| Weeks 4–6 | Transactions, F-expressions, relations, M2M | Production data layer |
| Weeks 5–7 | Application services, domain actions | Real business logic |
| Weeks 6–8 | Typed client, CLI, scaffolding, fixtures | Rapid development |
| Weeks 7–9 | MCP scopes, audit, confirmation | Agent-native application |
| Weeks 8–10 | Jobs, storage, caching | Batteries |
| Weeks 10–11 | Realtime, search, throttling | Complete application layer |
| Weeks 11–12 | Observability, deployment, security hardening | Production |
| Continuous | Elysia integration and contributions, docs, examples | Ecosystem |

The 90-day milestone:

> **Elysia + Angus can build and operate a serious production application without requiring developers to assemble a dozen unrelated libraries.**

**Still publish `0.1.0` in week 1**, incomplete. A published package with a real README attracts the feedback that changes what's worth building next; an unpublished one attracts nothing.

---

## Deliberately not built

Saying no is what keeps conceptual surface area survivable.

| Not building | Because |
| --- | --- |
| Frontend or SSR framework | Generate a typed client; let people pick their UI. |
| Backend-as-a-service | People choose this to own their backend. |
| GraphQL | REST + OpenAPI + MCP already cover this audience. Revisit only on real demand. |
| A second routing or validation layer | Elysia's. Non-negotiable — this is the governing rule. |
| A migration diff engine | drizzle-kit does it well. Angus generates the schema and hands over. |
| A query language as expressive as SQL | Past a point, developers would rather write SQL. Give them `Model.raw()`. |
| Multi-runtime support | Bun-native is a feature; a Node layer would cost the performance story and double the test matrix. |
| Internationalisation | Rarely the blocker for an API-first framework. |

---

## The philosophy shift

The earlier version of this roadmap read as *"add enough batteries to compete with AdonisJS and Django."* That was the wrong optimisation target.

> **Make Angus the application layer that takes Elysia from prototype through production.**

```text
┌─────────────────────────────────────┐
│            Application              │
│                                     │
│   Domain · Services · Auth · Admin  │
│   Jobs · Storage · MCP · CLI        │
│                                     │
│                Angus                │
├─────────────────────────────────────┤
│                                     │
│   HTTP · Routing · Validation       │
│   Plugins · Lifecycle · Realtime    │
│                                     │
│               Elysia                │
├─────────────────────────────────────┤
│                 Bun                 │
└─────────────────────────────────────┘
```

Under that frame the recurring design question stops being *what can we build?* and becomes:

> **What belongs in Elysia versus Angus, and what is the smallest coherent abstraction developers actually need to learn?**

That question, answered consistently, is what decides whether this becomes a useful ecosystem or merely a very large framework.
