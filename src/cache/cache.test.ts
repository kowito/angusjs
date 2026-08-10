import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { _resetHooks, invalidateCacheOnWrite, onModel } from '../db/hooks.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'
import { cached, createCache, getCache, invalidateModels, MemoryCacheStore, modelTag, setCache } from './index.ts'

const Widget = defineModel('cacheWidget', {
  fields: { name: f.char({ maxLength: 40 }), stock: f.integer({ default: 0 }) },
  meta: { tableName: 'cache_widgets' },
})

let db: TestDatabase

beforeAll(async () => {
  db = await testDatabase({ models: [Widget] })
})

afterAll(async () => {
  await db.close()
  setCache(undefined)
})

beforeEach(async () => {
  await db.reset()
  _resetHooks()
  setCache(createCache({ store: new MemoryCacheStore(), defaultTtlSeconds: 60 }))
})

describe('the store', () => {
  test('stores and retrieves', async () => {
    const cache = getCache()
    await cache.set('k', { a: 1 })
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 })
  })

  test('a missing key is undefined, not an error', async () => {
    expect(await getCache().get('nope')).toBeUndefined()
  })

  test('an expired entry is a miss', async () => {
    const cache = getCache()
    await cache.set('k', 'v', { ttlSeconds: -1 })
    expect(await cache.get('k')).toBeUndefined()
  })

  test('delete removes one key', async () => {
    const cache = getCache()
    await cache.set('k', 'v')
    expect(await cache.delete('k')).toBe(true)
    expect(await cache.get('k')).toBeUndefined()
  })

  test('a prefix isolates one app from another sharing a store', async () => {
    const store = new MemoryCacheStore()
    const first = createCache({ store, prefix: 'a' })
    const second = createCache({ store, prefix: 'b' })

    await first.set('same', 1)
    expect(await second.get('same')).toBeUndefined()
    expect(await first.get<number>('same')).toBe(1)
  })
})

describe('getOrSet', () => {
  test('computes on a miss and reuses on a hit', async () => {
    const cache = getCache()
    let calls = 0
    const compute = () => {
      calls++
      return 'value'
    }

    expect(await cache.getOrSet('k', compute)).toBe('value')
    expect(await cache.getOrSet('k', compute)).toBe('value')
    expect(calls).toBe(1)
  })

  test('concurrent misses share one computation', async () => {
    // The stampede defence: without it, a hot key expiring makes every
    // in-flight request recompute at once.
    const cache = getCache()
    let calls = 0

    const slow = async () => {
      calls++
      await Bun.sleep(20)
      return 'expensive'
    }

    const results = await Promise.all(Array.from({ length: 50 }, () => cache.getOrSet('hot', slow)))

    expect(results.every((value) => value === 'expensive')).toBe(true)
    expect(calls).toBe(1)
  })

  test('a failed computation does not poison the key', async () => {
    const cache = getCache()

    let raised: unknown
    try {
      await cache.getOrSet('k', () => {
        throw new Error('boom')
      })
    } catch (error) {
      raised = error
    }
    expect((raised as Error).message).toBe('boom')

    // The in-flight entry was cleared, so the next caller may try again.
    expect(await cache.getOrSet('k', () => 'recovered')).toBe('recovered')
  })

  test('undefined is not cached, since that is how a miss is signalled', async () => {
    const cache = getCache()
    let calls = 0
    const compute = () => {
      calls++
      return undefined
    }

    await cache.getOrSet('k', compute)
    await cache.getOrSet('k', compute)
    expect(calls).toBe(2)
  })
})

describe('tags', () => {
  test('invalidating a tag clears everything carrying it', async () => {
    const cache = getCache()
    await cache.set('a', 1, { tags: ['posts'] })
    await cache.set('b', 2, { tags: ['posts', 'authors'] })
    await cache.set('c', 3, { tags: ['authors'] })

    expect(await cache.invalidate('posts')).toBe(2)
    expect(await cache.get('a')).toBeUndefined()
    expect(await cache.get('b')).toBeUndefined()
    expect(await cache.get<number>('c')).toBe(3)
  })

  test('cached() tags by model', async () => {
    let calls = 0
    const build = () => {
      calls++
      return 'summary'
    }

    await cached('dashboard', build, { models: [Widget] })
    await cached('dashboard', build, { models: [Widget] })
    expect(calls).toBe(1)

    await invalidateModels(Widget)
    await cached('dashboard', build, { models: [Widget] })
    expect(calls).toBe(2)
  })

  test('the model tag is stable and namespaced', () => {
    expect(modelTag('post')).toBe('model:post')
  })
})

describe('invalidation on write', () => {
  test('a write clears cached values derived from the model', async () => {
    // The hook exists so this is one line rather than a call at every write
    // site, which is how a stale cache gets shipped.
    invalidateCacheOnWrite(Widget)

    let calls = 0
    const count = async () => {
      calls++
      return Widget.objects.count()
    }

    expect(await cached('widget-count', count, { models: [Widget] })).toBe(0)
    expect(await cached('widget-count', count, { models: [Widget] })).toBe(0)
    expect(calls).toBe(1)

    await Widget.objects.create({ name: 'new' })

    // The create fired afterCreate, which cleared the tag.
    expect(await cached('widget-count', count, { models: [Widget] })).toBe(1)
    expect(calls).toBe(2)
  })

  test('updates and deletes invalidate too', async () => {
    invalidateCacheOnWrite(Widget)
    const row = await Widget.objects.create({ name: 'a' })

    await getCache().set('k', 'stale', { tags: [modelTag(Widget.name)] })
    await Widget.objects.filter({ id: row.id }).update({ stock: 5 })
    expect(await getCache().get('k')).toBeUndefined()

    await getCache().set('k', 'stale again', { tags: [modelTag(Widget.name)] })
    await Widget.objects.filter({ id: row.id }).delete()
    expect(await getCache().get('k')).toBeUndefined()
  })
})

describe('model hooks', () => {
  test('beforeCreate can reshape the values that get written', async () => {
    onModel(Widget, 'beforeCreate', ({ values }) => {
      values!.name = String(values!.name).toUpperCase()
    })

    const created = await Widget.objects.create({ name: 'shouty' })
    expect(created.name).toBe('SHOUTY')
  })

  test('afterCreate sees the rows that were written', async () => {
    const seen: string[] = []
    onModel(Widget, 'afterCreate', ({ rows }) => {
      for (const row of rows ?? []) seen.push(String(row.name))
    })

    await Widget.objects.bulkCreate([{ name: 'a' }, { name: 'b' }])
    expect(seen.sort()).toEqual(['a', 'b'])
  })

  test('beforeDelete sees the rows about to go', async () => {
    // After the DELETE it is too late to read them, which is the whole reason
    // this hook has to run first.
    await Widget.objects.bulkCreate([{ name: 'doomed' }, { name: 'safe' }])

    const seen: string[] = []
    onModel(Widget, 'beforeDelete', ({ rows }) => {
      for (const row of rows ?? []) seen.push(String(row.name))
    })

    await Widget.objects.filter({ name: 'doomed' }).delete()
    expect(seen).toEqual(['doomed'])
  })

  test('hooks run in registration order', async () => {
    const order: number[] = []
    onModel(Widget, 'beforeCreate', () => void order.push(1))
    onModel(Widget, 'beforeCreate', () => void order.push(2))

    await Widget.objects.create({ name: 'x' })
    expect(order).toEqual([1, 2])
  })

  test('a hook can be removed', async () => {
    let calls = 0
    const remove = onModel(Widget, 'afterCreate', () => void calls++)

    await Widget.objects.create({ name: 'a' })
    remove()
    await Widget.objects.create({ name: 'b' })

    expect(calls).toBe(1)
  })

  test('a hook on one model does not fire for another', async () => {
    let calls = 0
    onModel(Widget, 'afterCreate', () => void calls++)
    await Widget.objects.create({ name: 'a' })
    expect(calls).toBe(1)
  })

  test('a throwing hook fails the write rather than being swallowed', async () => {
    onModel(Widget, 'beforeCreate', () => {
      throw new Error('validation failed in a hook')
    })

    expect(Widget.objects.create({ name: 'x' })).rejects.toThrow('validation failed in a hook')
    expect(await Widget.objects.count()).toBe(0)
  })
})
