---
title: Models
section: Building
order: 1
---

# Models

A model is a description of a thing in your domain. It is read by four consumers — the database schema, the validation schemas, the admin widgets, the agent tools — and none of them keeps its own copy.

```ts
export const Post = defineModel('post', {
  fields: {
    title: f.char({ maxLength: 200 }),
    slug: f.slug({ unique: true }),
    body: f.text({ blank: true, default: '' }),
    author: f.foreignKey(() => User, { onDelete: 'cascade' }),
    views: f.integer({ default: 0 }),
    publishedAt: f.datetime({ null: true }),
  },
  meta: {
    ordering: ['-publishedAt'],
    uniqueTogether: [['author', 'slug']],
  },
})

type PostRow = typeof Post.$row
```

Row types are inferred. Nothing is generated, and there is no build step between changing a field and seeing the type change.

## Field types

| Field | Column | Notes |
| --- | --- | --- |
| `f.char({ maxLength })` | varchar | `maxLength` is required — it reaches validation and the admin too |
| `f.text()` | text | Unbounded |
| `f.slug()` | varchar | Validated as a slug |
| `f.email()` | varchar | Validated as an email address |
| `f.url()` | varchar | Validated as a URL |
| `f.uuid()` | uuid / text | |
| `f.integer()`, `f.bigInteger()`, `f.smallInteger()` | integer | `min` / `max` reach validation |
| `f.float()`, `f.decimal({ precision, scale })` | real / numeric | |
| `f.boolean()` | boolean | |
| `f.date()`, `f.datetime()` | date / timestamp | `autoNow`, `autoNowAdd` |
| `f.json<T>()` | jsonb / text | Typed by its parameter |
| `f.file()`, `f.image()` | varchar | See [Storage](production.md#storage) |
| `f.foreignKey(() => Model)` | integer + FK | `onDelete`, `relatedName` |
| `f.manyToMany(() => Model)` | join table | |

Common options across all of them: `null`, `blank`, `default`, `unique`, `index`, `choices`, `helpText`, `verboseName`.

`null` and `blank` are different questions, and conflating them is the usual source of confusion. `null` is about the database column. `blank` is about validation: whether a request may omit the value. A field can be `blank: true, null: false` — omit it and it takes its default.

## Relations

```ts
author: f.foreignKey(() => User, { onDelete: 'cascade' })
tags: f.manyToMany(() => Tag)
```

The target is a function so two models can reference each other without an import cycle.

Reading a foreign key gives you `authorId` on the row; writing takes `author`. That asymmetry is deliberate — the column holds an id, and the write accepts either an id or the object.

## Meta

```ts
meta: {
  tableName: 'blog_posts',      // defaults to a snake_case plural
  ordering: ['-publishedAt'],   // the default for every query
  uniqueTogether: [['author', 'slug']],
  verboseName: 'post',          // used by the admin and OpenAPI
  indexes: [['status', 'publishedAt']],
}
```

## Mixins

A mixin is a plain object of fields, so what it adds stays visible on the model.

```ts
import { timestamps, softDelete } from 'angusjs/db'

export const Ticket = defineModel('ticket', {
  fields: {
    ...timestamps(),   // createdAt, updatedAt
    ...softDelete(),   // deletedAt
    title: f.char({ maxLength: 120 }),
  },
})
```

Soft delete does **not** reinterpret `delete()`. Making a call named `delete` silently not delete would mean nobody reading the code could tell what it does. Use the explicit helpers:

```ts
await softRemove(Ticket.objects.filter({ status: 'closed' }))
await alive(Ticket).count()      // not soft-deleted
await deleted(Ticket).count()    // soft-deleted
await restore(deleted(Ticket))
```

## Hooks

```ts
onModel(Post, 'beforeCreate', ({ data }) => {
  data.slug ??= slugify(data.title)
})

onModel(Post, 'afterUpdate', ({ rows }) => {
  for (const row of rows) reindex(row)
})
```

Hooks fire for `bulkCreate`, `update` and `delete` as well as single writes. `beforeDelete` receives the rows about to go, which means it costs a read — so it only runs that read when something is actually listening.

`invalidateCacheOnWrite(Post)` and `broadcastOnWrite(Post, channel)` are built on this.

## Registration

Defining a model registers it globally, which is what lets migrations and the CLI find it without a manifest. That is one of exactly two pieces of magic in the framework, and it is load-bearing rather than decorative — the other is the connection living in a module slot.
