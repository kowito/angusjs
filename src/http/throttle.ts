/**
 * Rate limiting.
 *
 * The store is an interface with an in-memory default, because the default is
 * wrong for the deployment most people end up with: an in-process counter is
 * per-instance, so three replicas mean three times the limit. That is fine for
 * one process and a documented lie for more than one — `angus check --deploy`
 * says so rather than letting it be discovered in an incident.
 *
 * The algorithm is a fixed window. It admits a burst at a window boundary
 * (up to 2× the limit across two adjacent windows); a sliding log would be
 * exact but keeps every timestamp. For protecting a login endpoint and holding
 * back runaway clients, the fixed window is the right trade.
 */

import { Elysia } from 'elysia'
import { Throttled } from './errors.ts'

export interface ThrottleDecision {
  allowed: boolean
  /** Requests still available in the current window. */
  remaining: number
  /** Seconds until the window resets. */
  resetSeconds: number
  limit: number
}

export interface ThrottleStore {
  /** Records a hit and reports whether it is allowed. */
  hit(key: string, limit: number, windowSeconds: number): Promise<ThrottleDecision> | ThrottleDecision
  /** Clears a key — used after a successful login, so failures don't accrue. */
  reset(key: string): Promise<void> | void
}

interface Counter {
  count: number
  expiresAt: number
}

/**
 * Per-process counters. Correct for a single instance; see the note above for
 * why that matters when you scale out.
 */
export class MemoryThrottleStore implements ThrottleStore {
  private readonly counters = new Map<string, Counter>()
  private lastSweep = 0

  hit(key: string, limit: number, windowSeconds: number): ThrottleDecision {
    const now = Date.now()
    this.sweep(now)

    const existing = this.counters.get(key)
    if (!existing || existing.expiresAt <= now) {
      const expiresAt = now + windowSeconds * 1000
      this.counters.set(key, { count: 1, expiresAt })
      return { allowed: true, remaining: limit - 1, resetSeconds: windowSeconds, limit }
    }

    existing.count++
    const resetSeconds = Math.max(1, Math.ceil((existing.expiresAt - now) / 1000))

    return {
      allowed: existing.count <= limit,
      remaining: Math.max(0, limit - existing.count),
      resetSeconds,
      limit,
    }
  }

  reset(key: string): void {
    this.counters.delete(key)
  }

  /** Drops expired counters so the map can't grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 30_000) return
    this.lastSweep = now
    for (const [key, counter] of this.counters) {
      if (counter.expiresAt <= now) this.counters.delete(key)
    }
  }

  get size(): number {
    return this.counters.size
  }
}

export interface ThrottleRule {
  /** Path prefix or pattern the rule applies to. */
  path: string | RegExp
  /** Restrict to particular methods. Defaults to all. */
  methods?: readonly string[]
  limit: number
  windowSeconds: number
  /** Distinguishes this rule's counters from others'. Defaults to the path. */
  scope?: string
}

export interface ThrottleOptions {
  /** Requests allowed per window, per key, when no rule matches. */
  limit?: number
  windowSeconds?: number
  /** Tighter limits for particular paths — a login endpoint, say. */
  rules?: readonly ThrottleRule[]
  store?: ThrottleStore
  /**
   * Identifies the caller. Defaults to the authenticated user, falling back to
   * the client IP — so one signed-in user behind a shared NAT isn't limited by
   * their neighbours.
   */
  keyBy?: (context: Record<string, any>) => string
  /** Paths never limited: health checks, mostly. */
  exempt?: readonly (string | RegExp)[]
}

/** Trusts proxy headers only for the client IP, never for identity. */
function clientAddress(context: Record<string, any>): string {
  const request = context.request as Request
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return (
    request.headers.get('x-real-ip') ??
    context.server?.requestIP?.(request)?.address ??
    'unknown'
  )
}

function defaultKey(context: Record<string, any>): string {
  const user = context.user as { id?: unknown } | undefined
  return user?.id !== undefined ? `user:${String(user.id)}` : `ip:${clientAddress(context)}`
}

function matches(path: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? path === pattern || path.startsWith(pattern) : pattern.test(path)
}

/**
 * Applies rate limits.
 *
 * ```ts
 * throttle({
 *   limit: 300, windowSeconds: 60,
 *   rules: [{ path: '/api/auth/login', limit: 5, windowSeconds: 300 }],
 * })
 * ```
 */
export function throttle(options: ThrottleOptions = {}): Elysia<any, any> {
  const store = options.store ?? new MemoryThrottleStore()
  const limit = options.limit ?? 300
  const windowSeconds = options.windowSeconds ?? 60
  const rules = options.rules ?? []
  const exempt = options.exempt ?? []
  const keyBy = options.keyBy ?? defaultKey

  return new Elysia({ name: 'angus:throttle' })
    // `resolve` rather than `onRequest`: the key can then use the authenticated
    // user, which is only known after the identity hook has run.
    .resolve({ as: 'global' }, async (context: Record<string, any>) => {
      const request = context.request as Request
      const path = new URL(request.url).pathname

      if (exempt.some((pattern) => matches(path, pattern))) return {}

      const rule = rules.find(
        (candidate) =>
          matches(path, candidate.path) &&
          (!candidate.methods || candidate.methods.includes(request.method)),
      )

      const effectiveLimit = rule?.limit ?? limit
      const effectiveWindow = rule?.windowSeconds ?? windowSeconds
      const scope = rule ? (rule.scope ?? String(rule.path)) : 'default'

      const decision = await store.hit(`${scope}|${keyBy(context)}`, effectiveLimit, effectiveWindow)

      const headers = context.set.headers as Record<string, string>
      headers['x-ratelimit-limit'] = String(decision.limit)
      headers['x-ratelimit-remaining'] = String(decision.remaining)
      headers['x-ratelimit-reset'] = String(decision.resetSeconds)

      if (!decision.allowed) {
        headers['retry-after'] = String(decision.resetSeconds)
        throw new Throttled(decision.resetSeconds)
      }

      return {}
    }) as unknown as Elysia<any, any>
}

/** Sensible defaults for a public API with a login endpoint. */
export function defaultThrottleRules(prefix = '/api', authPrefix = '/auth'): ThrottleRule[] {
  return [
    // Brute-forcing a password is the attack rate limiting exists for.
    { path: `${prefix}${authPrefix}/login`, methods: ['POST'], limit: 5, windowSeconds: 300, scope: 'auth:login' },
    { path: `${prefix}${authPrefix}/register`, methods: ['POST'], limit: 5, windowSeconds: 3600, scope: 'auth:register' },
    { path: `${prefix}${authPrefix}/password-reset`, methods: ['POST'], limit: 5, windowSeconds: 3600, scope: 'auth:reset' },
    { path: '/admin/login', methods: ['POST'], limit: 10, windowSeconds: 300, scope: 'admin:login' },
  ]
}
