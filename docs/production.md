---
title: Production
section: Running it
order: 1
---

# Production

## Configuration

```ts
export default defineSettings({
  apps: [...],
  database: { dialect: 'postgres', url: env.DATABASE_URL },
  security: { cors: { origin: ['https://app.example.com'] } },
  throttle: { limit: 100, windowSeconds: 60 },
  cache: { backend: 'memory' },
  email: { transport: 'smtp', url: env.SMTP_URL },
  storage: { backend: 's3', bucket: env.S3_BUCKET },
  tracing: {},
})
```

`angus/env` validates configuration at boot rather than at first request. A missing `DATABASE_URL` should stop a deploy, not surface as a 500 an hour later.

## What is on by default

Security headers, CSRF protection, structured request logging with request IDs, graceful shutdown, and `/health` and `/ready` endpoints. Each is a default rather than an opt-in because the opt-in version is the one nobody remembers.

CORS is off until configured, since a default origin list would be a guess.

Security headers and CORS are applied on `onRequest`, which means error responses carry them too — Elysia drops header mutations made later in the lifecycle.

## Checks before deploying

```bash
bun run angus check
bun run angus migrate --check    # fails if migrations are pending
```

`check` looks for the things that are invisible until they are not: an admin with no permissions in production, a missing secret, models that never made it into an app.

## Background jobs

```ts
export const sendDigest = job('send-digest', async ({ userId }) => { ... })

await enqueue(sendDigest, { userId: 3 })
await schedule(sendDigest, { userId: 3 }, { cron: '0 8 * * *' })
```

```bash
bun run angus worker
```

Database-backed, with retries, backoff, a dead-letter queue and cron scheduling. Delivery is at-least-once, so handlers need to be idempotent — a guarantee stated plainly rather than implied, because the alternative is discovering it from a duplicate charge.

## Caching

```ts
const posts = await cache.getOrSet('posts:latest', 60, () => Post.objects.limit(10))
invalidateCacheOnWrite(Post)
```

Concurrent callers for a cold key share one computation rather than stampeding the database.

## Storage

```ts
avatar: f.image({ null: true, uploadTo: 'avatars' })
```

Local, S3 or R2, with signed URLs. Keys are sanitised so path traversal is not expressible rather than merely rejected.

## Observability

Structured JSON logs with a request ID on every line, and the trace ID when one is recording.

```ts
tracing: {}   // needs @opentelemetry/api and an SDK
```

Spans cover the request, the services it called, and the queries those caused. The root span comes from Elysia's `.wrap()`, which is a higher-order function over the composed handler rather than a lifecycle hook, so it encloses the whole request.

Request spans are named by route pattern rather than URL. `/posts/1` and `/posts/2` being two operations would make grouping by span name useless exactly when it is needed — so the span opens named by path (routing has not happened yet) and is renamed once it has.

## Databases

SQLite and Postgres. MySQL is not supported, and that is settled rather than pending: every write uses `RETURNING` so `create` and `update` return the row as stored. Drizzle's MySQL driver has none, and the follow-up `SELECT` that would replace it is a second round trip that is not atomic with the write — under concurrent updates it can return someone else's version of the row. Two write paths with different consistency guarantees is a worse thing to own than one missing dialect.

## Testing

An in-memory database and a client that drives the app through `app.handle()` —
real routing, real validation, no port and no network.

```ts
const db = await testDatabase({ models: [Post] })
const client = clientFor(app)          // or testClient(settings)

const post = (await client.post('/posts', { title: 'Hello' })).expect(201)
expect(post.title).toBe('Hello')
```

`.expect(status)` returns the body when the status matches and throws otherwise —
and the throw is where the time is saved. On a mismatch it prints the response
body, and on a **404 it tells you what the app actually serves**:

```text
Expected status 200 for GET /postz, got 404.
GET /postz did not match any route. This app serves: DELETE /posts/:id;
GET /posts; GET /posts/:id; PATCH /posts/:id; POST /posts; PUT /posts/:id.
```

It recognises the mistakes that actually happen: a POST to a read-only route
(*"/posts accepts GET, POST"*), a path off by a trailing slash, and a path that
dropped the API prefix. A bare `NOT_FOUND` makes you guess; this does not.

`client.routes()` lists what the app serves, and `db.reset()` clears every row
between tests.

```ts
const { count } = await countQueries(() => loadDashboard())
expect(count).toBeLessThan(5)
```

`countQueries` is how an N+1 assertion becomes a test rather than a code review comment.

> Drive the app through the client, not a hand-built `new Request()`. A single-
> character host like `http://x/path` misparses and returns 404 for reasons that
> have nothing to do with your code — the client uses a safe origin so that trap
> never comes up.
