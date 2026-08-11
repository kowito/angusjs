# Angus

**The application framework for [Elysia](https://elysiajs.com).**

Angus builds production applications on top of Elysia and [Bun](https://bun.sh).

Define your domain model once. Angus derives the database schema, migrations, TypeScript types, validation, REST API, OpenAPI document, admin interface, and MCP tools from the same source of truth.

```ts
export const Product = defineModel('product', {
  fields: {
    name: f.char({ maxLength: 200 }),
    price: f.decimal({ precision: 10, scale: 2 }),
    status: f.char({ choices: ['draft', 'active', 'archived'], default: 'draft' }),
    supplier: f.foreignKey(() => Supplier),
  },
  meta: { ordering: ['-createdAt'] },
})
```

One declaration, many surfaces:

```text
                        defineModel()
                              │
        ┌──────────┬──────────┼──────────┬──────────┐
        │          │          │          │          │
     Database  TypeScript  Validation  Admin UI  MCP tools
     schema      types      schemas       │          │
        │          │          │          │          │
    Migrations  Row/insert  Elysia    Forms &    Agent
                  types      routes    filters    access
                              │
                          OpenAPI
```

---

## Why Angus

Elysia gives you an exceptionally fast, type-safe foundation for TypeScript APIs.

Angus sits one layer above and supplies the application conventions most production systems eventually need: models, CRUD endpoints, serialization, permissions, an admin interface, and agent access.

```text
┌──────────────────────────────────────────────┐
│                  Your App                    │
├──────────────────────────────────────────────┤
│                    Angus                     │
│                                              │
│  Models · QuerySets · Serializers · ViewSets │
│  Services · Auth · Admin · OpenAPI · MCP     │
│  Security · Throttling · Health · CLI        │
├──────────────────────────────────────────────┤
│                   Elysia                     │
│                                              │
│  Routing · Validation · Plugins · Lifecycle  │
│  HTTP · WebSockets                           │
├──────────────────────────────────────────────┤
│                     Bun                      │
└──────────────────────────────────────────────┘
```

Angus does not replace Elysia. **Angus extends Elysia.**

See [ARCHITECTURE.md](ARCHITECTURE.md) for where the boundary sits and why.

---

## Quick start

Requires Bun 1.2+. There is no Node build — the ORM uses `bun:sqlite` and `Bun.SQL`.

```bash
# Create a project (bunx runs the CLI without a global install)
bunx angusjs startproject myapi
cd myapi && bun install
```

From inside the project, the CLI runs through `bun run` — the `angus` bin lives
in `node_modules/.bin`, not on your `PATH`:

```bash
bun run angus startapp blog       # models, serializers, urls, admin
bun run angus generate crud blog Comment body:text post:fk=Blog
bun run angus makemigrations      # models -> SQL
bun run angus migrate             # SQL -> database
bun run angus runserver           # API, /docs, /admin, /mcp
```

A complete worked example lives in [`examples/blog`](examples/blog).

---

## Elysia-native

Angus composes with Elysia rather than abstracting it away. A router is a plain data structure that compiles to an Elysia instance, so you can adopt one piece without adopting the framework.

```ts
import { Elysia } from 'elysia'
import { modelViewSet } from 'angusjs/routing'

const app = new Elysia()
  .get('/health', () => ({ status: 'ok' }))          // your ordinary routes
  .onRequest(({ request }) => log(request))          // your ordinary hooks
  .use(modelViewSet({ model: Product, serializer: ProductSerializer })
    .toElysia({ prefix: '/products' }))              // six endpoints from Angus
  .listen(3000)
```

Lifecycle hooks, guards, decorators and plugins apply to Angus routes exactly as they do to your own, because they are the same Elysia instance. The ORM has no HTTP dependency at all, so it works just as well in a worker or a script.

**Your existing Elysia application does not need to become an Angus application.** Add Angus where you want higher-level primitives; use `createApp(settings)` when you want the whole convention.

---

## One model, many surfaces

| Layer | Derived from the model | Status |
| --- | --- | --- |
| Database | Column types, constraints, indexes | ✅ |
| Migrations | Drizzle schema and SQL | ✅ |
| TypeScript | Row, insert and update types | ✅ |
| Validation | TypeBox schemas | ✅ |
| REST | Elysia CRUD routes | ✅ |
| OpenAPI | Named component schemas | ✅ |
| Admin | Tables, filters, forms, widgets | ✅ |
| MCP | Tool input and output schemas | ✅ |
| Typed client | End-to-end typed fetch client | ✅ |

Beyond the model, an **application service** declares a non-CRUD operation once and is read by REST, OpenAPI, MCP and the CLI the same way.

Input and output contracts stay separate, so input coercion never leaks into your public API types. (Elysia's `t.Integer` accepts `"3"` from a query string and serialises as `anyOf: [string, integer]` — correct for a request, wrong for a response, where it would make a generated client type the field `string | number`. Angus builds response schemas from plain TypeBox and keeps coercion on the way in.)

---

## Documentation

Full documentation is in [`docs/`](docs/), and builds to a static site:

```bash
bun scripts/build-docs.ts
```

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | An empty directory to a running API |
| [Architecture](docs/architecture.md) | What belongs to Elysia, what belongs to Angus |
| [Models](docs/models.md) · [Queries](docs/queries.md) | The ORM |
| [Views and routing](docs/views.md) | View sets, permissions, serializers |
| [Authentication](docs/auth.md) | Sessions, roles, social sign-in, JWT |
| [Admin](docs/admin.md) | The auto-generated admin |
| [Agents and MCP](docs/agents.md) | Tool policy, audit, resources |
| [Realtime](docs/realtime.md) · [Search](docs/search.md) | Events and full-text search |
| [Production](docs/production.md) · [CLI](docs/cli.md) | Deploying and running it |

---

## What's included

| | |
| --- | --- |
| **ORM** | Type-first models, migrations, relations, transactions, aggregation, cursor pagination, full-text search |
| **API** | Serializers, view sets, permissions including object-level, pagination, filtering |
| **Identity** | Sessions, argon2id passwords, API tokens, roles and scopes, OIDC and social sign-in, JWT |
| **Admin** | Generated from the models — no adapter layer, no resource definitions |
| **Agents** | MCP with per-tool policy, confirmation on destructive calls, audit log, resources |
| **Batteries** | Background jobs, email, storage, caching, rate limiting, realtime events |
| **Operations** | Health checks, structured logging, OpenTelemetry, graceful shutdown, security headers |
| **Tooling** | Scaffolding, generators, seeding, typed client, route and model inspection |

---

## Status

Pre-1.0. The API is stabilising but not frozen.

Everything listed above is built, and the suite — 724 tests — passes on both SQLite and Postgres, which CI runs separately. The first Postgres run found three real bugs, which is the argument for running it.

Two things are outstanding, and neither is code:

- **Not published to npm.** Until that happens nobody else can use this.
- **One report to file with Elysia.** [UPSTREAM.md](UPSTREAM.md) records what building this found — including three candidates that turned out not to be gaps at all, corrections kept.

It has never been run in production by anyone. That is the honest limit on any claim made here.

---

## Design principles

**One declaration, many surfaces.** A change that would put the database, the validation, the admin and the agent tools out of step is not expressible, because there is only one place to make it.

**Elysia is the foundation, not an implementation detail.** Angus never reimplements routing, never wraps the context object, and never intercepts the request lifecycle. If Elysia solves something well, Angus integrates with it.

**Escape hatches are part of the contract.** `getConnection().db` for raw Drizzle, `toElysia()` for the raw instance, `$where` for raw SQL, `serializer.read` for the raw schema. Past a point, developers would rather write SQL than learn a query language as expressive as SQL.

**Fail closed, and say why.** The admin refuses to serve in production without configured permissions. Constraint violations are reported to the caller rather than as server faults. An optional integration that is missing says so at startup rather than going quiet.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The one thing worth reading before an ORM change: run `bun run test:postgres` as well as `bun test`, because SQLite is permissive enough to pass tests that Postgres rejects.

Security issues go to [SECURITY.md](SECURITY.md), privately rather than as an issue.

---

## Licence

MIT. See [LICENSE](LICENSE).
