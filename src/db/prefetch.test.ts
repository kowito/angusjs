import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { f } from './fields.ts'
import { defineModel } from './model.ts'
import { countQueries, testDatabase, type TestDatabase } from '../testing/index.ts'

const Shop = defineModel('pfShop', {
  fields: { name: f.char({ maxLength: 60 }) },
  meta: { tableName: 'pf_shops', ordering: ['name'] },
})

const Item = defineModel('pfItem', {
  fields: {
    name: f.char({ maxLength: 60 }),
    price: f.integer({ default: 0 }),
    active: f.boolean({ default: true }),
    shop: f.foreignKey(() => Shop),
  },
  meta: { tableName: 'pf_items', ordering: ['name'] },
})

/** Two foreign keys to the same model, to exercise the ambiguity error. */
const Transfer = defineModel('pfTransfer', {
  fields: {
    from: f.foreignKey(() => Shop),
    to: f.foreignKey(() => Shop),
    amount: f.integer({ default: 0 }),
  },
  meta: { tableName: 'pf_transfers' },
})

let db: TestDatabase

beforeAll(async () => {
  db = await testDatabase({ models: [Shop, Item, Transfer] })
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  const [main, side] = await Shop.objects.bulkCreate([{ name: 'Main' }, { name: 'Side' }])
  await Item.objects.bulkCreate([
    { name: 'Anvil', price: 100, shop: main!.id },
    { name: 'Bolt', price: 5, shop: main!.id, active: false },
    { name: 'Crate', price: 50, shop: side!.id },
  ])
})

describe('prefetch', () => {
  test('attaches a reverse relation as an array', async () => {
    const shops = await Shop.objects.prefetch({ items: Item })

    expect(shops.map((shop) => shop.name)).toEqual(['Main', 'Side'])
    expect(shops[0]!.items.map((item) => item.name)).toEqual(['Anvil', 'Bolt'])
    expect(shops[1]!.items.map((item) => item.name)).toEqual(['Crate'])
  })

  test('costs one query per relation, not one per row', async () => {
    // The whole point of prefetch: 2 queries for any number of shops.
    const { count } = await countQueries(() => Shop.objects.prefetch({ items: Item }))
    expect(count).toBe(2)
  })

  test('the query count does not grow with the number of rows', async () => {
    await Shop.objects.bulkCreate(Array.from({ length: 20 }, (_, index) => ({ name: `Shop ${index}` })))
    const { count } = await countQueries(() => Shop.objects.prefetch({ items: Item }))
    expect(count).toBe(2)
  })

  test('a parent with no children gets an empty array, never undefined', async () => {
    await Shop.objects.create({ name: 'Empty' })
    const shops = await Shop.objects.prefetch({ items: Item })
    const empty = shops.find((shop) => shop.name === 'Empty')!
    expect(empty.items).toEqual([])
  })

  test('an empty parent set does no extra work and still resolves', async () => {
    const shops = await Shop.objects.filter({ name: 'Nonexistent' }).prefetch({ items: Item })
    expect(shops).toEqual([])
  })

  test('the related queryset can be narrowed', async () => {
    const shops = await Shop.objects.prefetch({
      items: { model: Item, queryset: (base) => base.filter({ active: true } as never) },
    })
    expect(shops[0]!.items.map((item) => item.name)).toEqual(['Anvil'])
  })

  test('each group can be ordered independently of the parent', async () => {
    const shops = await Shop.objects.prefetch({ items: { model: Item, orderBy: ['-price'] } })
    expect(shops[0]!.items.map((item) => item.price)).toEqual([100, 5])
  })

  test('several relations are prefetched together', async () => {
    const shops = await Shop.objects.prefetch({
      items: Item,
      sent: { model: Transfer, via: 'from' },
    })
    expect(shops[0]!.items).toHaveLength(2)
    expect(shops[0]!.sent).toEqual([])
  })

  test('it composes with filtering, ordering and slicing', async () => {
    const shops = await Shop.objects.filter({ name: 'Main' }).orderBy('-name').limit(1).prefetch({ items: Item })
    expect(shops).toHaveLength(1)
    expect(shops[0]!.items).toHaveLength(2)
  })
})

describe('resolution errors', () => {
  test('an ambiguous relation must be disambiguated rather than guessed', async () => {
    // Transfer has both `from` and `to` pointing at Shop. Picking one silently
    // would produce quietly wrong data.
    expect(() => Shop.objects.prefetch({ transfers: Transfer })).toThrow(/2 foreign keys pointing at/)
  })

  test('the error names the option that fixes it', () => {
    try {
      Shop.objects.prefetch({ transfers: Transfer })
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain("via: 'from'")
    }
  })

  test('an unrelated model is rejected', () => {
    expect(() => Item.objects.prefetch({ nope: Shop })).toThrow(/no foreign key pointing at/)
  })

  test('an explicit via that is not a foreign key is rejected', () => {
    expect(() => Shop.objects.prefetch({ items: { model: Item, via: 'name' } })).toThrow(/not a foreign key/)
  })
})

describe('composition with selectRelated', () => {
  test('both directions can be loaded at once', async () => {
    // selectRelated joins the many-to-one side; prefetch batches the other.
    const items = await Item.objects.selectRelated('shop')
    expect(items[0]!.shop.name).toBeString()

    const shops = await Shop.objects.prefetch({ items: Item })
    expect(shops[0]!.items[0]!.name).toBeString()
  })
})
