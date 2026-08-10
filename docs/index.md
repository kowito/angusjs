---
title: Angus
section: Start here
order: 1
---

# Angus

**The application framework for Elysia.**

[Elysia](https://elysiajs.com) is an excellent HTTP framework. It handles routing, validation, the request lifecycle and plugins, and it is fast. What it deliberately does not decide is everything above that line: how your domain is modelled, how it reaches the database, who is allowed to do what, and what happens on day two.

Angus supplies that layer. It does not wrap Elysia, replace its router, or intercept its lifecycle — it produces Elysia primitives and hands them over.

```ts
const Post = defineModel('post', {
  fields: {
    title: f.char({ maxLength: 200 }),
    slug: f.slug({ unique: true }),
    status: f.char({ choices: ['draft', 'published'], default: 'draft' }),
    publishedAt: f.datetime({ null: true }),
  },
})

const PostSerializer = serializer(Post, { readOnly: ['id'] })

router().include('/posts', modelViewSet({ model: Post, serializer: PostSerializer }))
```

That gives you six REST endpoints, request and response validation, an OpenAPI document, an admin interface, and MCP tools an agent can call — from one declaration.

## The idea underneath

> One field declaration should be able to drive every application surface derived from that field.

A field says what it is: its kind, whether it can be null, its constraints, what it relates to. Four things read that description independently — the database schema, the validation schemas, the admin widgets, the agent tools. None of them holds its own copy.

The consequence is the property the project exists to have: **a change that would put those surfaces out of step is not expressible**, because there is only one place to make it.

## Where to start

- [Getting started](getting-started.md) — an empty directory to a running API.
- [Architecture](architecture.md) — what belongs to Elysia and what belongs to Angus.
- [Models](models.md) and [Queries](queries.md) — the ORM.
- [Agents](agents.md) — MCP, which is part of what Angus is rather than an add-on.

## What it is not

Angus is not a competitor to Elysia, and it is not a backend-as-a-service. You own the application, the database, and the deployment. It is also not required all-or-nothing: a view set mounts into an Elysia app you already have, and the ORM works with no HTTP involved at all.

```ts
new Elysia()
  .get('/health', () => ({ status: 'ok' }))
  .use(modelViewSet({ model: Post, serializer: PostSerializer }).toElysia({ prefix: '/posts' }))
  .listen(3000)
```

## Requirements

Bun 1.2 or newer. SQLite or Postgres. That is the whole list — Angus adds two runtime dependencies of its own, `drizzle-orm` and `elysia`.
