/**
 * The in-memory cache is bounded. Expiry alone lets a response cache keyed on
 * query strings grow without limit within a TTL window, so past the cap the
 * least-recently-used entry is evicted.
 */

import { describe, expect, test } from 'bun:test'
import { MemoryCacheStore } from './index.ts'

describe('bounded memory cache', () => {
  test('never exceeds maxEntries', () => {
    const store = new MemoryCacheStore({ maxEntries: 100 })
    for (let i = 0; i < 10_000; i++) store.set(`k${i}`, i, 60)
    expect(store.size).toBeLessThanOrEqual(100)
  })

  test('evicts the least-recently-used, keeps the touched', () => {
    const store = new MemoryCacheStore({ maxEntries: 3 })
    store.set('a', 1, 60)
    store.set('b', 2, 60)
    store.set('c', 3, 60)
    store.get('a') // touch a — now b is the least-recently-used
    store.set('d', 4, 60) // over cap -> evict b

    expect(store.get('a')).toBe(1)
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')).toBe(3)
    expect(store.get('d')).toBe(4)
  })

  test('eviction keeps the tag index consistent', () => {
    const store = new MemoryCacheStore({ maxEntries: 2 })
    store.set('a', 1, 60, ['t'])
    store.set('b', 2, 60, ['t'])
    store.set('c', 3, 60, ['t']) // evicts a
    // Invalidating the tag must not throw on the evicted key and clears the rest.
    expect(store.invalidateTags(['t'])).toBe(2)
    expect(store.get('b')).toBeUndefined()
  })
})
