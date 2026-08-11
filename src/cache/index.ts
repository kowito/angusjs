/**
 * Caching.
 *
 * Two things make a cache dangerous rather than useful, and both are handled
 * here rather than left to the caller:
 *
 * **Stampede.** When a hot key expires, every concurrent request misses at once
 * and they all recompute it. `getOrSet` shares one in-flight computation per
 * key, so a thousand simultaneous misses do the work once.
 *
 * **Stale keys after a write.** A cache nobody invalidates is a cache that
 * serves yesterday's data. `tags` group related entries so one `invalidate()`
 * clears everything derived from a model, and `cached()` on a model wires that
 * to its writes.
 *
 * The store is an interface with an in-memory default. As with rate limiting,
 * the in-memory one is per-process — three replicas keep three caches, which is
 * correct but wasteful, and `angus check --deploy` says so.
 */

export interface CacheEntry<T = unknown> {
  value: T
  expiresAt: number
  tags: readonly string[]
}

export interface CacheStore {
  readonly name: string
  get<T>(key: string): Promise<T | undefined> | T | undefined
  set<T>(key: string, value: T, ttlSeconds: number, tags?: readonly string[]): Promise<void> | void
  delete(key: string): Promise<boolean> | boolean
  /** Removes every entry carrying any of these tags. Returns how many went. */
  invalidateTags(tags: readonly string[]): Promise<number> | number
  clear(): Promise<void> | void
}

/**
 * Per-process entries with lazy expiry and a bounded size.
 *
 * The bound is what makes it safe to point a response cache at untrusted query
 * strings. Expiry alone is not enough: a crawler requesting `?page=1`, `?page=2`,
 * … or randomised parameters creates a distinct entry every time, and within a
 * single TTL window that is unbounded growth to OOM. Past `maxEntries` the
 * least-recently-used entry is evicted.
 */
export class MemoryCacheStore implements CacheStore {
  readonly name = 'memory'
  private readonly entries = new Map<string, CacheEntry>()
  /** tag -> keys, so invalidation is a lookup rather than a scan. */
  private readonly byTag = new Map<string, Set<string>>()
  private lastSweep = 0
  private readonly maxEntries: number

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 10_000)
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined

    if (entry.expiresAt <= Date.now()) {
      this.forget(key)
      return undefined
    }

    // Move to the end so it is evicted last — a Map keeps insertion order, so
    // the oldest live key is always the first one out.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value as T
  }

  set<T>(key: string, value: T, ttlSeconds: number, tags: readonly string[] = []): void {
    this.sweep()
    this.forget(key)

    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000, tags })
    for (const tag of tags) {
      const keys = this.byTag.get(tag) ?? new Set<string>()
      keys.add(key)
      this.byTag.set(tag, keys)
    }

    // Evict the least-recently-used entries until back within the cap.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.forget(oldest)
    }
  }

  delete(key: string): boolean {
    return this.forget(key)
  }

  invalidateTags(tags: readonly string[]): number {
    let removed = 0
    for (const tag of tags) {
      for (const key of this.byTag.get(tag) ?? []) {
        if (this.forget(key)) removed++
      }
      this.byTag.delete(tag)
    }
    return removed
  }

  clear(): void {
    this.entries.clear()
    this.byTag.clear()
  }

  get size(): number {
    return this.entries.size
  }

  private forget(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false

    for (const tag of entry.tags) {
      const keys = this.byTag.get(tag)
      keys?.delete(key)
      if (keys && keys.size === 0) this.byTag.delete(tag)
    }

    return this.entries.delete(key)
  }

  /** Expiry is lazy, so a periodic sweep stops abandoned keys accumulating. */
  private sweep(): void {
    const now = Date.now()
    if (now - this.lastSweep < 60_000) return
    this.lastSweep = now
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.forget(key)
    }
  }
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

export interface CacheSettings {
  store?: CacheStore
  /** Seconds an entry lives when none is given. Defaults to 300. */
  defaultTtlSeconds?: number
  /** Prefix on every key — useful when several apps share a store. */
  prefix?: string
  /** Cap on the in-memory store's entries before LRU eviction. Defaults to 10,000. */
  maxEntries?: number
}

export interface SetOptions {
  ttlSeconds?: number
  tags?: readonly string[]
}

export interface Cache {
  readonly store: CacheStore
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, options?: SetOptions): Promise<void>
  delete(key: string): Promise<boolean>
  /**
   * Returns the cached value, computing and storing it on a miss.
   * Concurrent misses for the same key share one computation.
   */
  getOrSet<T>(key: string, compute: () => Promise<T> | T, options?: SetOptions): Promise<T>
  invalidate(...tags: string[]): Promise<number>
  clear(): Promise<void>
}

export function createCache(settings: CacheSettings = {}): Cache {
  const store = settings.store ?? new MemoryCacheStore({ maxEntries: settings.maxEntries })
  const defaultTtl = settings.defaultTtlSeconds ?? 300
  const prefix = settings.prefix ?? ''

  const full = (key: string) => (prefix ? `${prefix}:${key}` : key)

  // One promise per key while a computation is in flight. This is the whole
  // stampede defence: the second caller awaits the first rather than starting
  // a second identical query.
  const inFlight = new Map<string, Promise<unknown>>()

  return {
    store,

    async get<T>(key: string) {
      return (await store.get<T>(full(key))) ?? undefined
    },

    async set<T>(key: string, value: T, options: SetOptions = {}) {
      await store.set(full(key), value, options.ttlSeconds ?? defaultTtl, options.tags)
    },

    async delete(key: string) {
      return store.delete(full(key))
    },

    async getOrSet<T>(key: string, compute: () => Promise<T> | T, options: SetOptions = {}) {
      const cacheKey = full(key)

      const hit = await store.get<T>(cacheKey)
      if (hit !== undefined) return hit

      const existing = inFlight.get(cacheKey)
      if (existing) return existing as Promise<T>

      const work = (async () => {
        const value = await compute()
        // `undefined` is how a miss is signalled, so caching it would make
        // every later read recompute anyway. Skip it rather than pretend.
        if (value !== undefined) {
          await store.set(cacheKey, value, options.ttlSeconds ?? defaultTtl, options.tags)
        }
        return value
      })()

      inFlight.set(cacheKey, work)

      // Cleanup is attached *after* the entry is registered, not in a `finally`
      // inside the body. A `compute` that throws synchronously rejects before
      // `inFlight.set` runs, so an inner `finally` would delete nothing and
      // leave the rejected promise cached forever — every later caller would
      // then re-throw the original error. `.finally()` is a microtask, so it
      // cannot outrun the line above.
      //
      // The `.catch` keeps the map's own reference from looking like an
      // unhandled rejection; the caller still receives the real promise.
      void work.finally(() => inFlight.delete(cacheKey)).catch(() => {})

      return work
    },

    async invalidate(...tags: string[]) {
      return store.invalidateTags(tags)
    },

    async clear() {
      inFlight.clear()
      await store.clear()
    },
  }
}

let active: Cache | undefined

export function getCache(): Cache {
  return (active ??= createCache())
}

export function setCache(cache: Cache | undefined): void {
  active = cache
}

/** The conventional tag for everything derived from a model. */
export function modelTag(modelName: string): string {
  return `model:${modelName}`
}

/**
 * Caches a computation and tags it with the models it reads, so writing to any
 * of them clears it.
 *
 * ```ts
 * const summary = await cached('dashboard', () => buildSummary(), {
 *   models: [Order, Customer],
 *   ttlSeconds: 60,
 * })
 * ```
 */
export async function cached<T>(
  key: string,
  compute: () => Promise<T> | T,
  options: { models?: { name: string }[]; ttlSeconds?: number; tags?: readonly string[] } = {},
): Promise<T> {
  const tags = [...(options.tags ?? []), ...(options.models ?? []).map((model) => modelTag(model.name))]
  return getCache().getOrSet(key, compute, { ttlSeconds: options.ttlSeconds, tags })
}

/** Clears everything derived from these models. Call it after a write. */
export async function invalidateModels(...models: { name: string }[]): Promise<number> {
  return getCache().invalidate(...models.map((model) => modelTag(model.name)))
}

// ---------------------------------------------------------------------------
// Response caching
// ---------------------------------------------------------------------------

import { Elysia } from 'elysia'

export interface ResponseCacheOptions {
  /** Paths to cache. A prefix or a pattern. */
  paths: readonly (string | RegExp)[]
  ttlSeconds?: number
  /**
   * Caches per signed-in user rather than skipping authenticated requests.
   *
   * Off by default, and that default matters: caching a personalised response
   * under a shared key and serving it to the next visitor is a data leak, not
   * a performance bug. With this off, an authenticated request bypasses the
   * cache entirely.
   */
  varyByUser?: boolean
  tags?: readonly string[]
}

interface CachedResponse {
  status: number
  headers: [string, string][]
  body: string
}

function pathMatches(path: string, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.some((pattern) =>
    typeof pattern === 'string' ? path === pattern || path.startsWith(pattern) : pattern.test(path),
  )
}

/**
 * Caches whole GET responses for the named paths.
 *
 * Only GET, and only 2xx: caching a redirect or an error is almost never what
 * anyone means, and caching a mutation is never right.
 */
export function cacheResponses(options: ResponseCacheOptions): Elysia<any, any> {
  const ttl = options.ttlSeconds ?? 60

  return new Elysia({ name: 'angus:response-cache' })
    .onRequest(async (context: Record<string, any>) => {
      const request = context.request as Request
      if (request.method !== 'GET') return

      const url = new URL(request.url)
      if (!pathMatches(url.pathname, options.paths)) return

      // No user is resolved this early, so an ambient credential means the
      // response may be personalised. Without varyByUser, skip rather than
      // risk serving one visitor's data to another.
      const credentialed = request.headers.get('authorization') ?? request.headers.get('cookie')
      if (credentialed && !options.varyByUser) return

      const key = `response:${credentialed && options.varyByUser ? hashCredential(credentialed) : 'anon'}:${url.pathname}${url.search}`
      const hit = await getCache().get<CachedResponse>(key)

      if (hit) {
        return new Response(hit.body, {
          status: hit.status,
          headers: [...hit.headers, ['x-cache', 'HIT']],
        })
      }

      context.store ??= {}
      ;(context.store as Record<string, unknown>).__cacheKey = key
    })
    .onAfterResponse({ as: 'global' }, async (context: Record<string, any>) => {
      const key = (context.store as Record<string, unknown> | undefined)?.__cacheKey as string | undefined
      const response = context.response as Response | undefined
      if (!key || !(response instanceof Response)) return

      const status = response.status
      if (status < 200 || status >= 300) return

      const body = await response.clone().text()
      await getCache().set<CachedResponse>(
        key,
        { status, headers: [...response.headers.entries()], body },
        { ttlSeconds: ttl, tags: options.tags },
      )
    }) as unknown as Elysia<any, any>
}

/** Keys a per-user cache entry without putting the credential in the key. */
function hashCredential(credential: string): string {
  return new Bun.CryptoHasher('sha256').update(credential).digest('hex').slice(0, 16)
}
