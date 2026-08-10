---
title: Getting started
section: Start here
order: 2
---

# Getting started

From an empty directory to a running API with an admin interface.

## Create a project

```bash
bun create angusjs my-api   # or: bunx angusjs startproject my-api
cd my-api
bun install
```

That gives you a project with settings, a database configuration, and nothing else — no example app you have to delete first.

## Add an app

An *app* is a folder of related models, serializers, routes and admin registrations. Projects are made of apps the way a Django project is.

```bash
bun run angus startapp blog
```

```text
apps/blog/
  app.ts          the app definition, listing its models
  models.ts
  serializers.ts
  urls.ts
  admin.ts
```

Register it in `angus.config.ts`:

```ts
import blog from './apps/blog/app.ts'

export default defineSettings({
  apps: [blog, admin.app(), authApp()],
  database: { dialect: 'sqlite', url: 'db.sqlite' },
  prefix: '/api',
})
```

## Describe a model

```ts
// apps/blog/models.ts
import { defineModel, f } from 'angusjs/db'

export const Post = defineModel('post', {
  fields: {
    title: f.char({ maxLength: 200 }),
    slug: f.slug({ unique: true }),
    body: f.text({ blank: true, default: '' }),
    status: f.char({ choices: ['draft', 'published'], default: 'draft' }),
    publishedAt: f.datetime({ null: true }),
    createdAt: f.datetime({ autoNowAdd: true }),
  },
  meta: { ordering: ['-createdAt'] },
})
```

Add it to the app's `models` map in `app.ts` — that map is what migrations read, and a model missing from it gets no table.

## Migrate

```bash
bun run angus makemigrations
bun run angus migrate
```

`makemigrations` writes SQL you can read and commit. Angus generates the schema and hands the diffing to drizzle-kit rather than owning a diff engine.

## Expose it

```ts
// apps/blog/serializers.ts
export const PostSerializer = serializer(Post, { readOnly: ['id', 'createdAt'] })

// apps/blog/urls.ts
const routes = router()

routes.include(
  '/posts',
  modelViewSet({
    model: Post,
    serializer: PostSerializer,
    filterFields: ['status'],
    searchFields: ['title', 'body'],
    orderingFields: ['createdAt', 'title'],
  }),
)

export default routes
```

## Run it

```bash
bun run angus runserver
```

| Address | What is there |
| --- | --- |
| `/api/posts` | The six REST endpoints |
| `/docs` | API reference, generated from the routes |
| `/openapi.json` | The OpenAPI 3.1 document |
| `/admin` | The admin interface |
| `/mcp` | MCP endpoint for agents |

## Generate the next one

`startapp` creates an app; `generate` adds to one.

```bash
bun run angus generate crud blog Comment body:text approved:bool post:fk=Post
```

Model, serializer, view set and admin registration, appended to the files that already exist, with the imports managed and the model registered with its app.

## What to read next

- [Models](models.md) — field types, relations, meta options.
- [Queries](queries.md) — the QuerySet API.
- [Views](views.md) — view sets, permissions, pagination.
- [Auth](auth.md) — sessions, passwords, roles, social sign-in.
