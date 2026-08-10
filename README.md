# angusjs

A batteries-included API framework for [Bun](https://bun.sh) — Django's ergonomics on top of [ElysiaJS](https://elysiajs.com).

Django's good ideas (pluggable apps, a real ORM, migrations, serializers, view sets, an auto-generated admin, a management CLI) without Django's magic, plus the two things a modern API needs: an OpenAPI document and an MCP server, both generated from the routes you already wrote. Everything is a plain function or object, everything is statically typed, and the schemas your models produce are the same schemas Elysia validates and documents with.

```ts
// apps/blog/models.ts
import { defineModel, f } from 'angusjs/db'

export const Post = defineModel('post', {
  fields: {
    title: f.char({ maxLength: 200 }),
    slug: f.slug({ unique: true }),
    body: f.text({ blank: true, default: '' }),
    status: f.char({ choices: ['draft', 'published'], default: 'draft' }),
    author: f.foreignKey(() => Author),
    createdAt: f.datetime({ autoNowAdd: true }),
  },
  meta: { ordering: ['-createdAt'] },
})
```

```ts
// apps/blog/urls.ts
import { modelViewSet, router } from 'angusjs/routing'

export default router().include(
  '/posts',
  modelViewSet({
    model: Post,
    serializer: PostSerializer,
    filterFields: ['status', 'author'],
    searchFields: ['title', 'body'],
    orderingFields: ['createdAt', 'title'],
  }),
)
```

That's six REST endpoints, validated request and response bodies, filtering, search, ordering, pagination, an OpenAPI 3.1 document at `/openapi.json`, and six MCP tools at `/mcp`. Register the model with the admin and you also get a CRUD interface at `/admin`.

---

## Install

Requires Bun 1.2+. There is no Node build — the ORM uses `bun:sqlite` and `Bun.SQL`.

```bash
bun add angusjs drizzle-orm elysia
bun add -d drizzle-kit @elysiajs/openapi
```

## Getting started

```bash
angus startproject myapi
cd myapi && bun install
angus startapp blog          # scaffolds models, serializers, urls, app
# register the app in angus.config.ts
angus makemigrations         # models -> SQL
angus migrate                # SQL -> database
angus runserver              # http://localhost:8000, docs at /docs
```

A complete worked example lives in [`examples/blog`](examples/blog).

---

## The pieces

### Models

`defineModel` is a function, not a class, because that's what lets the row type be *inferred* rather than declared twice.

```ts
const Post = defineModel('post', {
  fields: { title: f.char({ maxLength: 200 }), views: f.integer({ default: 0 }) },
  meta: { ordering: ['-createdAt'], indexes: [{ fields: ['status', 'createdAt'] }] },
})

type PostRow = typeof Post.$row // { id: number; title: string; views: number }
```

- An `id` primary key is added when you don't declare one.
- Table names are pluralised snake_case (`post` → `posts`); column names are snake_case.
- Foreign keys store `<attr>_id` and are indexed automatically.
- Nullable fields widen the row type to `| null`; fields with defaults become optional on insert.

Field types: `char` `text` `email` `slug` `url` `uuid` `integer` `smallInteger` `bigInteger` `float` `decimal` `boolean` `date` `datetime` `time` `json` `foreignKey` `oneToOne` `auto` `bigAuto`.

### QuerySets

Lazy, immutable, and chainable. Nothing runs until you await it.

```ts
await Post.objects.filter({ status: 'published', views__gte: 100 })
  .exclude({ title__icontains: 'draft' })
  .orderBy('-createdAt')
  .limit(10)

await Post.objects.get({ slug: 'hello' })       // throws DoesNotExist
await Post.objects.getOrNull({ slug: 'hello' }) // returns null
await Post.objects.filter({ author__name: 'Grace' })   // traverses the relation
await Post.objects.selectRelated('author')             // joins, `post.author.name`
await Post.objects.aggregate({ total: 'sum:views' })
const [post, created] = await Post.objects.getOrCreate({ slug: 'x' }, { title: 'X' })
```

Lookups are typed. `views__gte` only accepts a number, `title__in` only a `string[]`, and a misspelled field is a compile error:

```
exact  iexact  ne  in  notIn  isnull  contains  icontains  startswith
istartswith  endswith  iendswith  gt  gte  lt  lte  range
```

`Q` builds anything that isn't a plain AND:

```ts
import { Q } from 'angusjs/db'
await Post.objects.filter(Q.or({ status: 'published' }, { author: user.id }))
```

`values()` narrows the awaited type, not just the SQL:

```ts
const rows = await Post.objects.values('id', 'title') // { id: number; title: string }[]
```

### Serializers

A serializer decides what crosses the wire and produces a real TypeBox schema, so Elysia validates and documents it.

```ts
const PostSerializer = serializer(Post, {
  exclude: ['internalNotes'],
  readOnly: ['id', 'views', 'createdAt'],
  nested: { author: AuthorSerializer },     // embed the relation in responses
  computed: {
    excerpt: { schema: t.String(), get: (post) => post.body.slice(0, 140) },
  },
})
```

- Responses expose relations as `authorId`, plus a nested `author` object when configured.
- Requests take `author: <id>` — or the whole object, so a response body can be `PATCH`ed straight back.
- `readOnly` fields are ignored on input rather than rejected.
- Dates go out as ISO strings and come in as coerced `Date`s.

### Views

```ts
const postBySlug = view({
  params: t.Object({ slug: t.String() }),
  response: PostSerializer.read,
  permissions: [isAuthenticated],
  async handler({ params }) {
    const post = await Post.objects.getOrNull({ slug: params.slug })
    if (!post) throw new NotFound()
    return PostSerializer.toRepresentation(post)
  },
})

router().get('/posts/by-slug/:slug', postBySlug)
```

Throwing is the error-handling story: `NotFound`, `BadRequest`, `PermissionDenied`, `Conflict`, `Throttled`, or any `APIError`. `DoesNotExist` from the ORM becomes a 404 on its own.

### View sets

```ts
modelViewSet({
  model: Post,
  serializer: PostSerializer,
  queryset: (ctx) => Post.objects.filter({ author: ctx.user.id }), // scopes every action
  actions: ['list', 'retrieve', 'create'],          // omit the rest
  actionPermissions: { create: [isAuthenticated] },
  filterFields: ['status'],
  searchFields: ['title', 'body'],
  orderingFields: ['createdAt'],
  pagination: pageNumberPagination({ pageSize: 50 }),
  hooks: {
    beforeCreate: (data, ctx) => ({ ...data, author: ctx.user.id }),
  },
})
```

Generates `GET /`, `POST /`, `GET /:id`, `PUT /:id`, `PATCH /:id`, `DELETE /:id`. The `queryset` option scopes retrieval *and* writes, so a row outside it 404s rather than leaking.

Query parameters on list endpoints: `?status=draft`, `?views__gte=10`, `?search=foo`, `?ordering=-createdAt`, `?page=2&pageSize=50`. Anything not in `filterFields`/`orderingFields` is ignored, so clients can't filter on columns you didn't expose.

### OpenAPI

The spec is generated from the router, not scraped from a running server — so `angus openapi` works without binding a port, and the document can never drift from the routes.

```bash
angus openapi                      # to stdout
angus openapi --out openapi.json   # to a file
```

Served automatically at `/openapi.json`, with a self-contained reference page at `/docs`. No CDN script and no build step, so it works offline and under a strict CSP; point Scalar, Redoc or Swagger UI at `/openapi.json` if you want "try it out".

Targets OpenAPI **3.1**, which uses JSON Schema 2020-12 natively — exactly what TypeBox emits, so schemas pass through untranslated. Serializer schemas become named components (`Post`, `PostInput`, `PostPatch`) and are `$ref`'d rather than inlined; give a second serializer for the same model a `name` so it lands as `AuthorSummary` rather than colliding.

```ts
openapi: {
  title: 'My API',
  version: '1.0.0',
  path: '/docs',
  specPath: '/openapi.json',
  servers: [{ url: 'https://api.example.com' }],
}
```

One subtlety worth knowing: Elysia's `t.Integer` is a *coercing* type that serialises to `anyOf: [string, integer]` so `"3"` from a query string is accepted. That is right for input and wrong for output — a client generated from it would type the field `string | number` — so response schemas are built with plain TypeBox and request schemas keep the coercion.

### MCP

The API is exposed to agents over the [Model Context Protocol](https://modelcontextprotocol.io), with one tool per route, generated from the same definitions that produce the OpenAPI document.

```bash
angus mcp --list   # inventory the tools
angus mcp          # serve over stdio, for agent runners
```

Also served over Streamable HTTP at `/mcp` whenever the server runs. To register the stdio server with an agent runner:

```json
{ "mcpServers": { "myapi": { "command": "angus", "args": ["mcp"], "cwd": "/path/to/project" } } }
```

Each tool takes path and query parameters at the top level and the request body under `body` — nesting the body avoids a field silently colliding with a query parameter of the same name. Input schemas are closed (`additionalProperties: false`) so an invented argument fails loudly, and response schemas become `outputSchema`, so results come back as `structuredContent` and not just text.

An API error (404, 422) is reported as a **tool** error with `isError: true` and the field-level messages, so the model can adapt. Only unknown tools and malformed requests are protocol errors.

```ts
mcp: {
  path: '/mcp',
  readOnly: true,                 // expose GET routes only
  exclude: ['post-destroy'],      // or include: [...]
  instructions: 'Prefer post-list before post-detail.',
  permissions: [isStaff],         // gate the endpoint itself
}
```

**Authority.** Tools are executed by dispatching a real request back through the same app, so validation, permissions, serialization and error mapping all apply — MCP is a second front door to the API, never a way around it. A protected endpoint stays protected: credentials on the MCP request are forwarded to the API call. Set `mcp: false` to remove the endpoint.

**Protocol.** Dual-era, because the spec changed shape in revision `2026-07-28`: sessions, the GET stream and the `initialize` handshake were replaced by per-request `_meta` negotiation plus a mandatory `server/discover`. angusjs answers both, advertising `2026-07-28`, `2025-11-25`, `2025-06-18` and `2025-03-26`, and picks the era from how the caller opens. As the transport requires, `Origin` is validated (DNS rebinding), header and body must agree about the protocol version and method, and GET/DELETE return 405.

### Admin

An auto-generated CRUD interface, derived from the same field specs the ORM and serializers use. Register a model and you get a listing with search, filters, sorting and pagination, plus add/change/delete forms.

```ts
// admin.ts — the project's site
import { adminSite } from 'angusjs/admin'
export default adminSite({ title: 'My admin', permissions: [isStaff] })

// apps/blog/admin.ts — each app registers its own models
import admin from '../../admin.ts'

admin.register(Post, {
  listDisplay: ['title', 'status', 'author', 'views', 'createdAt'],
  listFilter: ['status', 'author'],
  searchFields: ['title', 'body'],
  readonlyFields: ['views'],
  listPerPage: 25,
})
```

`apps/blog/app.ts` imports `./admin.ts` for its side effect, so installing the app registers its admin — the same shape as Django's `admin.py`. Add `admin.app()` to `settings.apps` and it mounts at `/admin`, outside the project's API prefix.

Widgets come from the field kind: choices become a `<select>`, booleans a checkbox, relations a dropdown of the target's rows, `text` a textarea, `datetime` a datetime picker. Foreign keys display the target's `name`/`title`/`slug` rather than a bare id.

Options: `listDisplay` `listFilter` `searchFields` `ordering` `readonlyFields` `fields` `exclude` `listPerPage` `group` `displayField` `canAdd` `canChange` `canDelete`.

**Access.** The admin exposes every row of every registered model, so it fails closed. With `permissions` configured, they gate every page. With none configured it serves in development and returns 403 in production — convenient on day one, never an open admin by accident. Write requests are additionally rejected when `Origin` or `Sec-Fetch-Site` shows a cross-site submission.

### Apps and settings

```ts
// apps/blog/app.ts
export default defineApp({ name: 'blog', prefix: '/', models: { Post, Author }, urls })

// angus.config.ts
export default defineSettings({
  apps: [blog, accounts],
  database: { dialect: 'sqlite', url: 'db.sqlite' },
  prefix: '/api',
  authenticate: async ({ request }) => resolveUser(request.headers.get('authorization')),
  middleware: [cors()],
  openapi: { title: 'My API', version: '1.0.0' },
})
```

`authenticate` populates `context.user` for every request; permissions read it. Listing a model in an app's `models` is what makes migrations see it.

---

## CLI

| Command | Description |
| --- | --- |
| `angus startproject <name>` | Scaffold a new project |
| `angus startapp <name>` | Scaffold an app inside the project |
| `angus runserver [--port] [--host]` | Development server |
| `angus makemigrations [--name]` | Generate migrations from your models |
| `angus migrate` | Apply pending migrations |
| `angus routes` | Print the URL table |
| `angus models` | Print every model and its columns |
| `angus openapi [--out]` | Print or write the OpenAPI document |
| `angus mcp [--list]` | Serve the API to agents over MCP (stdio) |
| `angus check` | Validate the project without starting it |
| `angus shell` | REPL with your models in scope |

## Migrations

angusjs doesn't implement a migration engine — [drizzle-kit](https://orm.drizzle.team/kit-docs/overview) already diffs a schema against its history and emits SQL. `makemigrations` generates `.angus/schema.ts` (Drizzle tables built from your models) and hands over. The SQL lands in `migrations/` for you to read before applying it.

`.angus/` is generated on every run and should not be committed or edited.

## Databases

SQLite and Postgres, both through Bun's built-in drivers.

```ts
database: { dialect: 'sqlite',   url: 'db.sqlite' }
database: { dialect: 'postgres', url: process.env.DATABASE_URL! }
```

MySQL isn't supported: Drizzle's MySQL driver has no `RETURNING`, which the write path depends on.

## Testing

`createApp` gives you the Elysia instance without binding a port:

```ts
const app = await createApp(settings, { connectDatabase: false })
const response = await app.handle(new Request('http://test/api/posts'))
```

## Design notes

**Why not a Model base class?** A class body can't produce the row type without decorators and a metaclass equivalent. `defineModel` infers `$row`, `$insert`, and `$update` from the field map, so the types follow the schema rather than being restated.

**Why Drizzle underneath?** SQL generation, dialect handling, and migration diffing are solved problems with sharp edges. angusjs owns the layer above: the Django-shaped API, the lookup language, the serializer bridge. `getConnection().db` is there when you need to drop down.

**Where the magic is.** Two places, both deliberate: models register themselves globally on definition (so migrations and the CLI can find them), and the connection lives in a module slot (so `Post.objects` needs no handle). Everything else is an ordinary value you can log.

## Status

Version 0.1 — usable and tested, but the API may still move. Not yet published to npm.

## Licence

MIT
