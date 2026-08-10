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

Spans cover services and queries. Angus does not open a span for the HTTP request itself: Elysia's hooks observe a request but cannot wrap one, and a root span has to wrap — the standard OTel HTTP instrumentation does that properly, and these spans attach beneath it.

## Databases

SQLite and Postgres. MySQL is not supported, and that is settled rather than pending: every write uses `RETURNING` so `create` and `update` return the row as stored. Drizzle's MySQL driver has none, and the follow-up `SELECT` that would replace it is a second round trip that is not atomic with the write — under concurrent updates it can return someone else's version of the row. Two write paths with different consistency guarantees is a worse thing to own than one missing dialect.

## Testing

```ts
const db = await testDatabase({ models: [Post] })
await db.reset()

const { count } = await countQueries(() => loadDashboard())
expect(count).toBeLessThan(5)
```

`countQueries` is how an N+1 assertion becomes a test rather than a code review comment.
