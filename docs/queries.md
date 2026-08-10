---
title: Queries
section: Building
order: 2
---

# Queries

`Model.objects` returns a QuerySet: lazy, immutable, and typed against the model's fields.

```ts
const posts = await Post.objects
  .filter({ status: 'published', views__gte: 100 })
  .exclude({ author: 3 })
  .orderBy('-publishedAt')
  .limit(20)
```

Nothing runs until you await it, so a queryset can be built up across several functions without anyone paying for the intermediate steps.

## Lookups

Suffix a field name with a lookup:

| Lookup | Meaning |
| --- | --- |
| `__exact`, `__iexact` | Equality, case-insensitively |
| `__ne` | Not equal |
| `__gt`, `__gte`, `__lt`, `__lte` | Comparison |
| `__in`, `__notIn` | Membership |
| `__contains`, `__icontains` | Substring |
| `__startswith`, `__endswith` | And their `i` variants |
| `__isnull` | `true` or `false` |
| `__range` | Between two values, inclusive |

The keys are typed. `views__gte` type-checks against a numeric field and does not exist on a boolean one.

## Q objects

```ts
import { Q } from 'angusjs/db'

Post.objects.filter(Q.or({ status: 'published' }, { author: currentUser.id }))
Post.objects.filter(Q.not({ status: 'archived' }))
```

## Reading

```ts
await Post.objects.get({ slug })          // throws DoesNotExist / MultipleObjectsReturned
await Post.objects.getOrNull({ slug })    // null instead
await Post.objects.first()
await Post.objects.exists()
await Post.objects.count()
await Post.objects.values('id', 'title')
```

`DoesNotExist` becomes a 404 at the HTTP edge, so a view can let it propagate rather than checking for null and building an error body by hand.

## Writing

```ts
const post = await Post.objects.create({ title: 'Hello', slug: 'hello' })
await Post.objects.bulkCreate([{ ... }, { ... }])

const [updated] = await Post.objects.filter({ id: 1 }).update({ views: F('views').add(1) })
await Post.objects.filter({ status: 'draft' }).delete()
```

Every write uses `RETURNING`, so `create` and `update` hand back the row as the database actually stored it — defaults and triggers included, without a second query.

`F` expressions compute in the database, which is what makes a counter increment safe under concurrency: `F('views').add(1)` is one statement, whereas reading then writing is a lost update waiting to happen.

## Relations

```ts
// One query, joined.
await Post.objects.selectRelated('author')

// Two queries, no N+1.
await Post.objects.prefetch({ comments: Comment.objects.filter({ approved: true }) })
```

`selectRelated` is for foreign keys and joins. `prefetch` is for the other direction and issues one extra query for the whole set — visible at the call site rather than hidden inside a lazy attribute that fires per row.

## Aggregation

```ts
await Post.objects.aggregate({ total: 'count:id', views: 'sum:views' })

await Post.objects.groupBy('status', {
  total: 'count:id',
  views: 'avg:views',
})
```

Aggregates come back as numbers, not driver strings.

## Pagination

```ts
const page = await Post.objects.page({ size: 20 })
const next = await Post.objects.page({ size: 20, after: page.nextCursor })
```

Cursor pagination costs one query per page and no count. It is also correct under insertion: with offsets, a row inserted before your cursor makes the reader see something twice.

## Search

```ts
await Post.objects.search('coastal erosion', ['title', 'body'])
```

Full text on Postgres — stemming, stop words, quoted phrases, `-` exclusion, relevance ranking. Substring matching on SQLite, ranked by how many fields matched. See [Search](search.md).

## Transactions

```ts
await atomic(async () => {
  const order = await Order.objects.create({ ... })
  await Payment.objects.create({ order: order.id, ... })
})
```

Nested calls become savepoints. The connection is ambient inside the block, so nothing has to be threaded through.

## The escape hatch

```ts
const { db, table } = Post.objects.query()
await db.select().from(table).where(...)

Post.objects.filter({ $where: sql`lower(title) = ${term}` })
```

Past a point developers would rather write SQL than learn a query language as expressive as SQL. Both hatches are part of the contract, not an admission of failure.
