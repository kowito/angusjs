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
bun add angusjs drizzle-orm elysia
bun add -d drizzle-kit
```

```bash
angus startproject myapi
cd myapi && bun install
angus startapp blog       # models, serializers, urls, admin
angus makemigrations      # models -> SQL
angus migrate             # SQL -> database
angus runserver           # API, /docs, /admin, /mcp
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

## The pieces

### Models and QuerySets

`defineModel` is a function rather than a class, because that is what lets the row type be *inferred* instead of declared twice.

```ts
type ProductRow = typeof Product.$row   // { id: number; name: string; ... }

await Product.objects.filter({ status: 'active', price__gte: '10.00' })
  .exclude({ name__icontains: 'sample' })
  .orderBy('-createdAt')
  .limit(10)

await Product.objects.get({ id: 3 })              // throws DoesNotExist
await Product.objects.filter({ supplier__country: 'GB' })   // traverses the relation
await Product.objects.selectRelated('supplier')   // joins; product.supplier.name
await Supplier.objects.prefetch({ products: Product })  // one extra query, not one per row
```

`selectRelated` joins the many-to-one direction. `prefetch` covers the other, where a join would multiply the parent row and break `limit` — so 50 suppliers with their products is **two queries, not fifty-one**. The related model is named explicitly, which keeps the result typed and keeps the extra query visible at the call site rather than hidden behind an attribute access.

Many-to-many is a helper over a join model you own, never a hidden table:

```ts
const ArticleTag = defineModel('articleTag', {
  fields: { article: f.foreignKey(() => Article), tag: f.foreignKey(() => Tag) },
  meta: { uniqueTogether: [['article', 'tag']] },
})

const tags = manyToMany({ from: Article, to: Tag, through: ArticleTag })

await tags.add(article.id, [1, 2])     // re-adding is a no-op, not a constraint error
await tags.set(article.id, [2, 3])     // one transaction; a failure changes nothing
await tags.forMany([1, 2, 3])          // Map<articleId, TagRow[]>, two queries
```

The "extra column on the join" moment (`addedAt`, `role`, `quantity`) arrives in almost every project. Because the join is an ordinary model, adding one is a normal field — not a migration away from a hidden table.

Lookups are typed: `price__gte` only accepts the field's type, `name__in` only an array, and a misspelled field is a compile error.

```text
exact  iexact  ne  in  notIn  isnull  contains  icontains  startswith
istartswith  endswith  iendswith  gt  gte  lt  lte  range
```

An `id` primary key is added when you don't declare one; table names are pluralised snake_case; foreign keys store `<attr>_id` and are indexed automatically.

### Serializers

A serializer decides what crosses the wire and produces a real TypeBox schema, so Elysia validates and documents it.

```ts
const ProductSerializer = serializer(Product, {
  readOnly: ['id', 'createdAt'],
  nested: { supplier: SupplierSerializer },   // embed the relation in responses
  computed: {
    inStock: { schema: t.Boolean(), get: (p) => p.quantity > 0 },
  },
})
```

### Views and view sets

```ts
modelViewSet({
  model: Product,
  serializer: ProductSerializer,
  queryset: (ctx) => Product.objects.filter({ owner: ctx.user.id }),  // scopes every action
  actionPermissions: { create: [isAuthenticated] },
  filterFields: ['status'],
  searchFields: ['name'],
  orderingFields: ['createdAt', 'price'],
})
```

Generates `GET /`, `POST /`, `GET /:id`, `PUT /:id`, `PATCH /:id`, `DELETE /:id`, with filtering, search, ordering and pagination. The `queryset` option scopes reads *and* writes, so a row outside it 404s rather than leaking.

For anything a view set doesn't cover, `view()` bundles a handler with its schema and permissions:

```ts
const publish = view({
  params: t.Object({ id: t.Numeric() }),
  response: ProductSerializer.read,
  permissions: [isStaff],
  async handler({ params }) {
    const [row] = await Product.objects.filter({ id: params.id }).update({ status: 'active' })
    if (!row) throw new NotFound()
    return ProductSerializer.toRepresentation(row)
  },
})
```

### Application services

`Model → Serializer → ViewSet` covers CRUD and stops. A service declares an operation that isn't CRUD, once, and every surface reads that declaration.

```ts
export const approveInvoice = service({
  name: 'approve-invoice',
  input: t.Object({ invoiceId: t.Numeric() }),
  output: InvoiceSerializer.read,
  permissions: [isStaff],
  transactional: true,               // default
  async handler({ input, actor }) { /* ... */ },
})

router().post('/invoices/:invoiceId/approve', fromService(approveInvoice, {
  params: t.Object({ invoiceId: t.Numeric() }),
}))
```

Mounting is the only adapter needed: OpenAPI and MCP already read the route table, so the service becomes a documented endpoint *and* an agent tool with no second registration. It's also `angus run approve-invoice --invoiceId 3`.

### Typed client

```bash
angus client --out ../web/src/api.ts
```

```ts
import { createClient, ApiError } from './api'

const api = createClient({ baseUrl: 'https://api.example.com' })

const posts = await api.postList({ query: { search: 'bun', pageSize: 10 } })
const post = await api.postDetail({ params: { id: 3 } })
await api.postPartialUpdate({ params: { id: 3 }, body: { title: 'Renamed' } })
```

Generated from the same route definitions as the OpenAPI document, so the client cannot describe an endpoint the server doesn't have. The file is **self-contained** — its own types, error class and fetch wrapper, importing nothing — because a frontend shouldn't have to install the backend framework to call it.

Failures throw `ApiError` carrying the error contract: `status`, a stable `code`, `detail`, and field-level `errors`.

> `baseUrl` is the origin alone. Generated paths already include your project prefix, so passing `https://host/api` would produce `/api/api/...`.

**Why not [Eden](https://elysiajs.com/eden/overview.html)?** Eden imports the server's *type*, which needs the client to compile against the server's source — fine in a monorepo, impossible across repos. More decisively, Angus mounts routes as data (which is what makes `angus routes`, OpenAPI and MCP possible), and that erases the per-route types Eden reads.

### Transactions

```ts
await atomic(async () => {
  const order = await Order.objects.create({ ... })
  await Stock.objects.filter({ id: order.stockId }).update({ count: F('count').sub(1) })
})
```

Ambient, so a query several frames deep — inside a service, inside a model hook — joins the transaction without a handle being threaded through. Nested calls become savepoints.

`F()` refers to a column's own value, so `update({ views: F('views').add(1) })` becomes `SET views = views + 1` and concurrent increments don't lose each other.

### File storage

```ts
avatar: f.image({ maxBytes: 2 * 1024 * 1024, uploadTo: 'avatars' })
```

```ts
storage: { backend: s3Storage({ bucket: 'uploads', publicUrl: 'https://cdn.example.com' }) }
```

The column stores a **key**, not the bytes — so rows stay small, a CDN is possible, and moving from local disk to S3 is a configuration change rather than a migration. `f.file()` and `f.image()` are IR field kinds, so validation, the admin widget and the OpenAPI schema follow from the one declaration.

Uploads get their own endpoint rather than multipart on every write: a client uploads, receives a key, and sends the key in an ordinary JSON body. That keeps the OpenAPI document and the generated client free of multipart, and a large file never blocks a small write.

Backends: `localStorage()`, `s3Storage()` (S3, R2, MinIO — via Bun's built-in client, so no AWS SDK and real presigned URLs), and `memoryStorage()` for tests.

> Path traversal is handled by making it inexpressible rather than detectable: `safeKey()` strips every separator and dot-segment, and the local backend re-checks the resolved path against its root anyway.

### Background jobs

```ts
export const sendReceipt = job({
  name: 'send-receipt',
  input: t.Object({ orderId: t.Numeric() }),
  async handler({ input, attempt }) { /* ... */ },
})

await enqueue(sendReceipt, { orderId: order.id }, { delaySeconds: 30 })
schedule({ name: 'nightly-digest', job: sendDigest, every: '1d' })
```

```bash
angus worker --concurrency 4      # run jobs
angus worker --list --stats       # inspect
```

The queue is a table in your own database, not Redis. That buys the property that matters most: **enqueueing joins the caller's transaction**, so a job can't outlive the write that scheduled it — the race a separate broker cannot avoid. It also means one less service to run. The cost is throughput: polling a table suits emails, webhooks and thumbnails, not a firehose. `startWorker` and the storage are separable, so a Redis-backed queue can replace it later.

Retries use exponential backoff, a stalled worker's jobs are reclaimed when their lease expires, and `uniqueKey` stops a second copy being queued. Schedules derive a per-slot key, so running several workers still sends one digest.

> **Delivery is at-least-once.** A worker can succeed and die before recording it, so handlers must be idempotent. `uniqueKey` prevents duplicate *enqueues*, not duplicate *runs* — exactly-once needs a transactional consumer, which nothing here can honestly offer.

### Email

```ts
email: {
  backend: httpBackend({ apiKey: process.env.RESEND_API_KEY! }),
  from: 'Acme <no-reply@acme.com>',
}
```

Four backends, chosen for the two states a project is actually in. `consoleBackend()` prints to stderr — the default, because "the reset link never arrived" is a much worse first hour than a noisy terminal. `memoryBackend()` collects into an outbox so tests can assert without a mock. `httpBackend()` sends via a provider API (Resend by default, any other through `body`). `nullBackend()` accepts and discards.

```ts
const outbox = memoryBackend()
// ... trigger a password reset ...
expect(outbox.lastTo('ada@example.com')!.subject).toContain('Reset')
```

`redirectTo` diverts every message to one address, keeping the originals in `X-Original-To` — the safety catch for staging against a copy of production data. Password reset uses this automatically, so it works out of the box.

> **SMTP is not included.** A correct client means STARTTLS, several AUTH mechanisms, line folding and dot-stuffing, none of which could be verified here — and a client that drops mail silently is worse than an honest gap. `EmailBackend` is a single method, so adding one is small and local.

### Admin

Register a model and get a working CRUD interface at `/admin` — tables, search, filters, sorting, pagination, and add/change/delete forms, all derived from the same field specs.

```ts
admin.register(Product, {
  listDisplay: ['name', 'status', 'price', 'supplier'],
  listFilter: ['status', 'supplier'],
  searchFields: ['name'],
  readonlyFields: ['createdAt'],
})
```

Widgets come from the field kind: choices become a `<select>`, booleans a checkbox, relations a dropdown showing the target's name. Server-rendered HTML, no build step.

It fails closed. With `permissions` configured they gate every page; with none it serves in development and returns 403 in production — convenient on day one, never an open admin by accident. Writes reject cross-site submissions via `Origin` and `Sec-Fetch-Site`.

### OpenAPI

Generated from the router, not scraped from a running server, so it can never drift from the routes.

```bash
angus openapi --out openapi.json
```

Served at `/openapi.json` with a self-contained reference page at `/docs` — no CDN script, so it works offline and under a strict CSP. Targets OpenAPI 3.1, which uses JSON Schema 2020-12 natively, exactly what TypeBox emits. Serializer schemas become named components (`Product`, `ProductInput`, `ProductPatch`) and are `$ref`'d rather than inlined.

### AI-native

Angus treats an agent as another client of the same application.

```text
                    Application
                         │
              ┌──────────┴──────────┐
           REST API                MCP
              │                     │
            Human                 Agent
              └──────────┬──────────┘
                         │
                  Same validation
                  Same permissions
                  Same business logic
```

One tool per route, served over Streamable HTTP at `/mcp` and over stdio via `angus mcp`. Tools execute by dispatching a real request back through the app, so validation, permissions, serialization and error mapping all apply — **MCP is a second front door, never a way around the application's security model.** A permission-gated route stays gated.

```ts
mcp: {
  readOnly: true,             // expose GET routes only
  exclude: ['product-destroy'],
  permissions: [isStaff],     // gate the endpoint itself
}
```

The protocol layer is dual-era: revision `2026-07-28` replaced sessions and the `initialize` handshake with per-request negotiation plus `server/discover`, and most clients still speak the handshake, so Angus answers both.

### Permissions

Permissions are functions over the request context, applied per route, per action, or across a whole router.

```ts
const isOwner: Permission = (ctx) => ctx.user?.id === ctx.params.userId

router()
  .permissions(isAuthenticated)                 // whole router
  .get('/me', profile)
  .delete('/me', deleteAccount, { permissions: [isOwner] })
```

Identity comes from a single `authenticate` hook in settings, which populates `context.user` for every request:

```ts
authenticate: async ({ request }) => resolveUser(request.headers.get('authorization')),
```

The same rules protect REST endpoints, the admin, and MCP tools, because all three dispatch through the same routes.

Identity ships in the box (`angusjs/auth`): a `User` model, argon2id hashing via `Bun.password`, sessions and API tokens, password reset, and an admin login page.

```ts
import { adminAuthApp, authApp, authenticate, isStaff } from 'angusjs/auth'

export default defineSettings({
  apps: [authApp(), adminAuthApp(), admin.app(), blog],
  authenticate,
})
```

Bearer tokens and `HttpOnly` cookies resolve to the same identity, so an API client, a browser in the admin, and an agent over MCP are all checked by the same predicates. `hasScope()` lets a token be *narrower* than the user who issued it.

Social login (OIDC) is the remaining piece — see [ROADMAP.md](ROADMAP.md).

---

## Production

Security, observability and rate limiting are configured in one place and audited by one command.

```ts
export default defineSettings({
  apps: [...],
  security: {
    cors: { origin: ['https://app.example.com'], credentials: true },
    // headers and csrf are on by default
  },
  throttle: { store: redisStore },   // on automatically in production
  health: { version: process.env.GIT_SHA },
  server: { shutdownTimeoutMs: 10_000 },
})
```

**CSRF** applies to *ambient* credentials only. A cookie is ambient; an `Authorization` header is not, because an attacker's page cannot make the browser attach one. So cookie-authenticated writes must prove same-origin, and bearer-token clients are unaffected.

**Health probes are split on purpose.** `/healthz` (liveness) never touches the database — if it did, a database blip would fail every replica at once and the orchestrator would restart them all, turning a recoverable outage into a total one. `/readyz` (readiness) does check, so an instance that can't serve is pulled from the pool without being killed.

**Rate limiting defaults to production only.** Five login attempts per five minutes is right against credential stuffing and wrong while you're building the login form. It applies to matched routes, so it protects the endpoints you have; a flood of 404s is better absorbed at the edge than in application code.

**Graceful shutdown** drains in-flight requests before closing, so a rolling deploy doesn't return 502s for requests that were already in progress.

Every response carries an `x-request-id` — an inbound one is preserved, so a trace survives across services — and one structured log line per request.

### Typed configuration

```ts
export const env = defineEnv(t.Object({
  DATABASE_URL: t.String({ minLength: 1 }),
  SESSION_SECRET: t.String({ minLength: 32 }),
  PORT: t.Optional(t.Numeric({ default: 8000 })),
}))
```

Validated once at import, naming *every* problem at once, so a missing variable fails at boot rather than at the first request that needed it.

### The deployment audit

```bash
angus check --deploy      # exits non-zero on any error
angus migrate --check     # exits non-zero if migrations are unapplied
angus migrate --dry-run   # prints the SQL without running it
```

`check --deploy` reports what is safe in development and dangerous in production: debug mode leaking stack traces, an admin with no authentication, CSRF or throttling disabled, SQLite where the filesystem is ephemeral, an in-memory rate-limit store behind multiple replicas. Each finding has a stable id you can silence deliberately.

Both commands are configuration-only — no server, no database writes — so they belong in CI.

`angus startproject` also writes a `Dockerfile` (multi-stage, non-root, liveness healthcheck), a `.dockerignore` and a `.env.example`.

---

## CLI

| Command | Description |
| --- | --- |
| `angus startproject <name>` | Scaffold a new project |
| `angus startapp <name>` | Scaffold an app inside the project |
| `angus runserver` | Development server |
| `angus makemigrations` | Generate migrations from your models |
| `angus migrate [--check\|--dry-run]` | Apply migrations; verify or preview them |
| `angus routes` | Print the URL table |
| `angus models` | Print every model and its columns |
| `angus check [--deploy]` | Validate the project; `--deploy` audits production settings |
| `angus openapi [--out]` | Print or write the OpenAPI document |
| `angus client [--out]` | Generate a typed API client |
| `angus mcp [--list]` | Serve the API to agents over MCP |
| `angus run <service>` | Invoke an application service |
| `angus worker` | Run background jobs |
| `angus shell` | REPL with your models in scope |

---

## Databases and migrations

SQLite and Postgres, through Bun's built-in drivers.

```ts
database: { dialect: 'sqlite',   url: 'db.sqlite' }
database: { dialect: 'postgres', url: process.env.DATABASE_URL! }
```

Angus does not implement a migration engine — [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) already diffs a schema against its history and emits SQL. `makemigrations` generates `.angus/schema.ts` from your models and hands over, leaving reviewable SQL in `migrations/`.

MySQL isn't supported: Drizzle's MySQL driver has no `RETURNING`, which the write path depends on.

---

## Testing

`angusjs/testing` supplies a database that builds itself from your models, cases that roll back, and a client with no port:

```ts
import { factory, testClient, testDatabase, transactional } from 'angusjs/testing'

const db = await testDatabase({ models: [Product] })
const client = await testClient(settings, { basePath: '/api' })
const products = factory(Product, (n) => ({ name: `Product ${n}`, price: '9.99' }))

test('lists products', () => transactional(async () => {
  await products.createMany(3)
  const response = await client.get('/products')
  expect(response.body.count).toBe(3)
}))
```

---

## Design principles

**One source of truth.** Application contracts should not be restated across database schemas, validators, API docs, admin forms and agent tools.

**Elysia first.** Angus composes with Elysia instead of hiding it. Every router compiles to an Elysia instance you can mount yourself.

**Type-safe by default.** Types flow from the model through the stack without manual synchronisation. `defineModel` infers the row type rather than making you declare it twice.

**Explicit security.** Authorization, validation and scoping are enforced at the route, so every interface — REST, admin, MCP — inherits them rather than reimplementing them.

**Escape hatches.** Conventions without ownership. `getConnection().db` is the raw Drizzle handle, `router().toElysia()` is the raw Elysia instance, and `$where` takes raw SQL when the typed lookups aren't enough.

---

## Status

Under active development, pre-1.0. APIs may change.

**Shipped:** models, migrations, QuerySets with typed lookups, transactions and F-expressions, serializers, views and view sets, application services, identity and authorization, admin (with login), OpenAPI, MCP, testing utilities, an Elysia plugin surface, the production layer (CSRF, security headers, CORS, throttling, health probes, request ids, graceful shutdown, typed config, deployment audit), and the CLI. 359 tests, clean typecheck.

**Next:** reverse relations and `prefetchRelated`, many-to-many, typed client generation, then email, jobs and storage.

The goal it all serves: **make Elysia capable of carrying an entire production application without leaving the Elysia ecosystem.** The full plan, with priorities and rationale, is in [ROADMAP.md](ROADMAP.md).

---

## Philosophy

Angus is not trying to replace Elysia. It is an application layer built on top of it.

**Elysia provides the foundation. Angus provides the conventions. Your application owns the business logic.**

---

## Licence

MIT
