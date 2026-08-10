# Architecture

Angus is an application layer on top of [Elysia](https://elysiajs.com). This document defines the boundary between them, so it stays a boundary rather than becoming a wrapper.

---

## The division

```text
Elysia owns                        Angus owns
─────────────────────────────      ─────────────────────────────
HTTP                               Domain models
Routing and route matching         ORM conventions and QuerySets
Request lifecycle and hooks        Migrations pipeline
Validation execution               Serializers
Plugins and composition            ViewSets and generic CRUD
Transport (HTTP, WebSockets)       Permissions and scoping
Context construction               Admin interface
Response encoding                  OpenAPI document
                                   MCP tools
                                   Project conventions and CLI
```

The rule that decides which side something falls on:

> **If it is about moving bytes over a connection, it is Elysia's. If it is about what your application means, it is Angus's.**

Angus never reimplements routing, never wraps the context object, and never intercepts the request lifecycle. It produces Elysia primitives and hands them over.

And when the seam is uncomfortable, the resolution is fixed in advance:

> **If Elysia already solves it well, Angus integrates with it. If Angus discovers that Elysia needs a better primitive to support production applications, improve Elysia rather than rebuilding that primitive inside Angus.**

The failure mode this prevents is gradual: a slightly awkward seam gets worked around, then the workaround grows, and eventually Angus *contains* Elysia rather than extending it. Places where that pressure is currently real — direction-aware schema types, route introspection, typed context extension — are tracked as upstream candidates in [ROADMAP.md](ROADMAP.md), not as things to build locally.

---

## The seam

Everything Angus knows about HTTP flows through one narrow interface: a `Router` is a plain data structure, and `toElysia()` is the only place it becomes a server.

```text
   defineModel()                model definitions
        │
        ├─ buildTables()  ──────► Drizzle tables ──► drizzle-kit ──► SQL
        │
        ├─ serializer()   ──────► TypeBox schemas
        │                              │
        └─ modelViewSet() ──► Router ──┤
                                │      │
                     ┌──────────┼──────┴──────────┬─────────────┐
                     │          │                 │             │
                flatten()   toElysia()      generateOpenApi()  buildTools()
                     │          │                 │             │
                 route table  Elysia app       OpenAPI       MCP tools
                (CLI, docs)   (the server)     document
```

A `Router` holds route definitions — method, path, schemas, permissions, metadata — and nothing else. That single decision is what makes four things possible:

- **`angus routes` prints the URL table without booting a server**, because the routes exist before any server does.
- **The OpenAPI document is generated, not scraped.** It reads the same definitions the server will mount, so it cannot drift from the running API.
- **MCP tools are generated from the same list**, which is why an agent sees exactly the endpoints a human reads about.
- **You can mount one view set into an Elysia app you already own**, because compiling to Elysia is a method call, not a framework takeover.

If Angus had built directly onto an Elysia instance, all four would require a running server and a scraping step.

---

## Two entry points

Angus is deliberately usable at two levels, and neither is the "real" one.

### Piecemeal — Angus inside your Elysia app

```ts
const app = new Elysia()
  .get('/health', () => ({ status: 'ok' }))
  .use(modelViewSet({ model: Product, serializer: ProductSerializer }).toElysia({ prefix: '/products' }))
  .listen(3000)
```

You own the app, the lifecycle, and the deployment. Angus contributes routes. Nothing about settings, apps, or the CLI is required. The ORM works with no Elysia involved at all — it backs workers and scripts equally well.

### Conventional — Angus owns the project

```ts
export default defineSettings({
  apps: [blog, admin.app()],
  database: { dialect: 'postgres', url: process.env.DATABASE_URL! },
  prefix: '/api',
  authenticate,
})
```

`createApp(settings)` assembles the whole thing: opens the database, mounts each app under its prefix, installs error translation, and serves OpenAPI and MCP. This is what `angus runserver` uses.

The second is built entirely out of the first. There is no privileged path.

---

## Request flow

A request through the conventional setup, showing which layer handles what:

```text
  Request
     │
  ┌──┴───────────────────────────────────────┐
  │ Elysia   route match                     │
  │          schema validation (TypeBox)     │
  │          context construction            │
  └──┬───────────────────────────────────────┘
     │
  ┌──┴───────────────────────────────────────┐
  │ Angus    authenticate() -> context.user  │
  │          permission checks               │
  │          view / viewset handler          │
  │            └─ QuerySet -> Drizzle -> DB  │
  │          serializer.toRepresentation()   │
  └──┬───────────────────────────────────────┘
     │
  ┌──┴───────────────────────────────────────┐
  │ Elysia   response schema validation      │
  │          encoding                        │
  └──┬───────────────────────────────────────┘
     │
  Response
```

Errors thrown anywhere in the Angus band are translated once, at the edge: `APIError` subclasses carry their own status, `DoesNotExist` from the ORM becomes a 404, and a serializer `ValidationError` becomes a 400. A handler never builds an error body by hand.

---

## Why the surfaces cannot drift

The admin, OpenAPI and MCP are not three integrations. They are three readers of two data structures.

```text
   FieldSpec                        RouteDefinition
   (per field)                      (per route)
       │                                  │
  ┌────┼────┬─────────┐          ┌────────┼────────┐
  │    │    │         │          │        │        │
Drizzle  TypeBox   Admin      Elysia   OpenAPI    MCP
column   schema    widget     route    operation  tool
```

`FieldSpec` is a description, not a column: it names the kind, nullability, constraints and relation target, and stays free of Drizzle, Elysia and TypeBox imports. Four consumers read it independently. Adding a field type means teaching those four consumers one new case — it does not mean touching four subsystems that each hold their own copy of the schema.

The same is true one level up. `RouteDefinition` carries method, path, schemas, permissions and metadata; the Elysia compiler, the OpenAPI generator and the MCP tool builder each read it without knowing about each other.

This is the property the project exists to have. **A change that would desynchronise the surfaces is not expressible**, because there is only one place to make it.

---

## Planned: application services

The current vocabulary — `Model → Serializer → ViewSet` — covers CRUD and stops there. Operations that aren't CRUD (`publishPost`, `refundInvoice`, `transferOwnership`) currently have nowhere to live except a route handler, which means re-implementing them for the admin, for an agent, and for a queue.

The planned fourth primitive is an **application service**: a declaration in the same style as a model, which every surface reads.

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

Structurally this is the same move the framework already makes one level down: a service declares its input schema, output schema, permissions and transaction boundary, and the surfaces become readers rather than re-implementations. It is also the natural home for the audit log and for agent confirmation on destructive operations, both of which would otherwise be duplicated per surface.

Tracked in [ROADMAP.md](ROADMAP.md) under P2.

---

## Security model

Authorization lives on the route, and every interface reaches the application through a route.

```text
        REST client        Admin browser        MCP agent
             │                   │                  │
             └───────────────────┼──────────────────┘
                                 │
                          route + permissions
                                 │
                            handler / ORM
```

MCP tools execute by dispatching a real `Request` back through the same Elysia app rather than calling handlers directly. That indirection is deliberate: it means validation, permissions, serialization and error mapping all apply, and there is no second code path that could drift out of agreement with the first. An agent has exactly the authority the HTTP API grants, and credentials on the MCP request are forwarded to the underlying call.

The admin fails closed rather than open: with no configured permissions it serves in development and refuses in production.

---

## Dependencies, and what is deliberately not owned

| Concern | Owner | Why |
| --- | --- | --- |
| SQL generation, dialects | Drizzle | Solved, with sharp edges. Angus owns the API above it. |
| Migration diffing | drizzle-kit | Reimplementing a diff engine buys nothing. Angus generates the schema module and hands over. |
| Schema language | TypeBox | It is what Elysia validates with, so sharing it means one schema, not two. |
| HTTP, routing, lifecycle | Elysia | The whole premise. |
| Password hashing | Bun | `Bun.password` is argon2id; a dependency would be worse. |
| Trace collection and export | OpenTelemetry SDK | Angus emits spans through `@opentelemetry/api` when it is installed, and is a no-op when it is not. The HTTP root span belongs to the standard instrumentation — Elysia's hooks observe a request but cannot wrap one, and a root span has to wrap. |

Angus adds two runtime dependencies of its own: `drizzle-orm` and `elysia`.

Escape hatches are part of the contract, not an admission of failure:

- `getConnection().db` — the raw Drizzle handle
- `router().toElysia()` — the raw Elysia instance
- `$where` — raw SQL inside a typed filter
- `serializer.read` — the raw TypeBox schema

---

## Module map

```text
src/
  tracing.ts    OpenTelemetry spans — a leaf, imported by anything
  db/           models, fields, QuerySets, lookups, Drizzle bridge, connection
  serializers/  FieldSpec -> TypeBox, representation and validation
  routing/      Router, views, ViewSets, permissions
  http/         error types, pagination strategies
  admin/        registry, HTML rendering, widgets and form parsing
  openapi/      document generation, reference page
  mcp/          tool generation, JSON-RPC dispatch, HTTP and stdio transports
  core/         apps, settings, project bootstrap, config loading
  cli/          the angus command
```

The dependency direction is strictly downward: `core` may import `routing`, `routing` may import `db`, and `db` imports nothing from Angus except the top-level leaves (`tracing.ts`, `html.ts`), which import nothing themselves. Tracing has to be a leaf for exactly this reason — the query layer reports spans, and putting the tracer under `core` would have inverted the direction the rest of the architecture depends on. `admin`, `openapi` and `mcp` are readers — they depend on `db` and `routing` and are depended on by nothing except `core`.

---

## Constraints this architecture accepts

Being explicit about the costs:

- **Bun only.** `bun:sqlite` and `Bun.SQL` are used directly. A Node compatibility layer would cost the performance advantage and double the test matrix.
- **SQLite and Postgres only — settled, not pending.** Every write goes through
  `RETURNING` so `create()` and `update()` hand back the row the database
  actually stored, defaults and triggers included. Drizzle's MySQL driver has no
  `RETURNING`, so supporting MySQL would mean a second write path that issues a
  follow-up `SELECT` — which is not equivalent: it is a second round trip, it is
  not atomic with the write, and under concurrent updates it can return someone
  else's version of the row. Two write paths with different consistency
  guarantees is a worse thing to own than one missing dialect.
- **Models register globally at definition time.** This is what lets migrations and the CLI find them without a manifest, at the cost of a module-level registry.
- **One connection in a module slot.** `Product.objects` needs no handle threaded through every call — the same trade Django makes with `settings.DATABASES`. `setConnection()` exists for tests.

Both of the last two are the only real "magic" in the framework, and both are load-bearing rather than decorative.
