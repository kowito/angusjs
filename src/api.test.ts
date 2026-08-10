/**
 * End-to-end tests: real models, a real Elysia app, real HTTP requests through
 * `app.handle()`. No network, no server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Elysia } from 'elysia'
import { defineApp } from './core/app.ts'
import { createApp } from './core/project.ts'
import { connect, disconnect, getConnection } from './db/connection.ts'
import { f } from './db/fields.ts'
import { defineModel } from './db/model.ts'
import { NotFound } from './http/errors.ts'
import { pageNumberPagination } from './http/pagination.ts'
import { modelViewSet } from './routing/viewset.ts'
import { router, type Context } from './routing/router.ts'
import { view } from './routing/view.ts'
import { serializer } from './serializers/index.ts'
import { t } from 'elysia'

const Shop = defineModel('shop', {
  fields: {
    name: f.char({ maxLength: 100 }),
    country: f.char({ maxLength: 2, default: 'GB' }),
  },
  meta: { ordering: ['name'] },
})

const Product = defineModel('product', {
  fields: {
    name: f.char({ maxLength: 120 }),
    sku: f.slug({ unique: true, maxLength: 60 }),
    price: f.integer({ min: 0 }),
    status: f.char({ choices: ['draft', 'live'], default: 'draft' }),
    shop: f.foreignKey(() => Shop),
    secret: f.char({ maxLength: 50, default: 'hidden' }),
    createdAt: f.datetime({ autoNowAdd: true }),
  },
  meta: { ordering: ['-createdAt'] },
})

const ShopSummary = serializer(Shop, { fields: ['id', 'name'] })

const ProductSerializer = serializer(Product, {
  exclude: ['secret'],
  readOnly: ['id', 'createdAt'],
  nested: { shop: ShopSummary },
  computed: {
    priceLabel: { schema: t.String(), get: (product) => `£${(product.price / 100).toFixed(2)}` },
  },
})

/** Only requests carrying the magic header count as authenticated. */
const authenticate = (context: Context) =>
  context.request.headers.get('x-user') ? { id: 1, name: 'tester' } : null

const isAuthed = (context: Record<string, any>) => Boolean(context.user)

const whoami = view({
  response: t.Object({ name: t.String() }),
  permissions: [isAuthed],
  handler: ({ user }) => ({ name: (user as { name: string }).name }),
})

const boom = view({
  handler: () => {
    throw new NotFound('Deliberately missing.')
  },
})

const catalog = defineApp({
  name: 'catalog',
  prefix: '/',
  models: { Shop, Product },
  urls: router()
    .get('/whoami', whoami)
    .get('/boom', boom)
    .include('/shops', modelViewSet({ model: Shop, serializer: ShopSummary, pagination: false }))
    .include(
      '/products',
      modelViewSet({
        model: Product,
        serializer: ProductSerializer,
        filterFields: ['status', 'shop', 'price'],
        searchFields: ['name', 'sku'],
        orderingFields: ['price', 'name'],
        pagination: pageNumberPagination({ pageSize: 2 }),
        actionPermissions: { create: [isAuthed], destroy: [isAuthed] },
      }),
    ),
})

let app: Elysia<any, any>

const request = async (path: string, init: RequestInit = {}) => {
  const response = await app.handle(new Request(`http://test${path}`, init))
  const text = await response.text()
  return {
    status: response.status,
    body: text === '' ? null : (JSON.parse(text) as any),
  }
}

const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

beforeAll(async () => {
  await connect({ dialect: 'sqlite', url: ':memory:' }, [Shop, Product])
  getConnection().client.exec(`
    CREATE TABLE shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'GB'
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE,
      price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      secret TEXT NOT NULL DEFAULT 'hidden',
      created_at INTEGER NOT NULL
    );
  `)

  app = await createApp(
    { apps: [catalog], prefix: '/api', authenticate, openapi: false, debug: false },
    { connectDatabase: false },
  )
})

afterAll(async () => {
  await disconnect()
})

beforeEach(async () => {
  const { client } = getConnection()
  // AUTOINCREMENT keeps counting past a DELETE, so the sequence is reset too —
  // these tests address rows by id.
  client.exec(`
    DELETE FROM products;
    DELETE FROM shops;
    DELETE FROM sqlite_sequence WHERE name IN ('products', 'shops');
  `)
  await Shop.objects.create({ name: 'Main Street' })
  await Product.objects.bulkCreate([
    { name: 'Anvil', sku: 'anvil', price: 1000, status: 'live', shop: 1 },
    { name: 'Bolt', sku: 'bolt', price: 250, status: 'live', shop: 1 },
    { name: 'Crate', sku: 'crate', price: 500, status: 'draft', shop: 1 },
  ])
})

describe('list', () => {
  test('paginates with an envelope', async () => {
    const { status, body } = await request('/api/products')
    expect(status).toBe(200)
    expect(body.count).toBe(3)
    expect(body.results).toHaveLength(2)
    expect(body.next).toContain('page=2')
    expect(body.previous).toBeNull()
  })

  test('follows the next link', async () => {
    const { body } = await request('/api/products?page=2')
    expect(body.results).toHaveLength(1)
    expect(body.next).toBeNull()
    expect(body.previous).toContain('page=1')
  })

  test('filters on an exact field', async () => {
    const { body } = await request('/api/products?status=live')
    expect(body.count).toBe(2)
  })

  test('filters with a lookup suffix', async () => {
    const { body } = await request('/api/products?price__gte=500')
    expect(body.count).toBe(2)
  })

  test('ignores filters on fields that were not opted in', async () => {
    const { body } = await request('/api/products?sku=anvil')
    expect(body.count).toBe(3)
  })

  test('searches across the configured fields', async () => {
    const { body } = await request('/api/products?search=bolt')
    expect(body.count).toBe(1)
    expect(body.results[0].name).toBe('Bolt')
  })

  test('orders by an allowed field', async () => {
    const { body } = await request('/api/products?ordering=price&pageSize=10')
    expect(body.results.map((row: any) => row.price)).toEqual([250, 500, 1000])
  })

  test('ignores ordering on fields that were not opted in', async () => {
    const { body } = await request('/api/products?ordering=secret&pageSize=10')
    // Falls back to the model's default ordering rather than erroring.
    expect(body.results).toHaveLength(3)
  })

  test('pagination: false returns a bare array', async () => {
    const { body } = await request('/api/shops')
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
  })
})

describe('serialization', () => {
  test('excluded fields never appear', async () => {
    const { body } = await request('/api/products')
    expect(body.results[0]).not.toHaveProperty('secret')
  })

  test('computed fields appear', async () => {
    const { body } = await request('/api/products?search=anvil')
    expect(body.results[0].priceLabel).toBe('£10.00')
  })

  test('relations are embedded and the id is kept', async () => {
    const { body } = await request('/api/products?search=anvil')
    expect(body.results[0].shop).toEqual({ id: 1, name: 'Main Street' })
    expect(body.results[0].shopId).toBe(1)
  })

  test('dates come out as ISO strings', async () => {
    const { body } = await request('/api/products?search=anvil')
    expect(body.results[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('retrieve', () => {
  test('returns the object', async () => {
    const { status, body } = await request('/api/products/1')
    expect(status).toBe(200)
    expect(body.name).toBe('Anvil')
  })

  test('404s for a missing id', async () => {
    const { status, body } = await request('/api/products/999')
    expect(status).toBe(404)
    expect(body.error).toBe('NotFound')
  })

  test('422s when the id is not a number', async () => {
    const { status } = await request('/api/products/not-a-number')
    expect(status).toBe(422)
  })
})

describe('create', () => {
  const payload = { name: 'Drill', sku: 'drill', price: 3000, shop: 1 }

  test('requires authentication when the action demands it', async () => {
    const { status } = await request('/api/products', json('POST', payload))
    expect(status).toBe(401)
  })

  test('creates and returns 201 with the nested relation', async () => {
    const { status, body } = await request('/api/products', json('POST', payload, { 'x-user': '1' }))
    expect(status).toBe(201)
    expect(body.name).toBe('Drill')
    expect(body.shop).toEqual({ id: 1, name: 'Main Street' })
    expect(body.status).toBe('draft')
  })

  test('rejects a missing required field', async () => {
    const { status, body } = await request('/api/products', json('POST', { name: 'x' }, { 'x-user': '1' }))
    expect(status).toBe(422)
    expect(body.errors).toBeDefined()
  })

  test('rejects a value outside the allowed choices', async () => {
    const { status } = await request(
      '/api/products',
      json('POST', { ...payload, sku: 'other', status: 'bogus' }, { 'x-user': '1' }),
    )
    expect(status).toBe(422)
  })

  test('ignores read-only fields instead of failing', async () => {
    const { status, body } = await request(
      '/api/products',
      json('POST', { ...payload, sku: 'ro', id: 999 }, { 'x-user': '1' }),
    )
    expect(status).toBe(201)
    expect(body.id).not.toBe(999)
  })
})

describe('update', () => {
  test('PATCH changes only what it is given', async () => {
    const { status, body } = await request('/api/products/1', json('PATCH', { price: 1200 }))
    expect(status).toBe(200)
    expect(body.price).toBe(1200)
    expect(body.name).toBe('Anvil')
  })

  test('PUT requires the full payload', async () => {
    const { status } = await request('/api/products/1', json('PUT', { name: 'Only a name' }))
    expect(status).toBe(422)
  })

  test('PUT succeeds with every writable field', async () => {
    const { status, body } = await request(
      '/api/products/1',
      json('PUT', { name: 'Anvil II', sku: 'anvil-2', price: 1500, status: 'live', shop: 1 }),
    )
    expect(status).toBe(200)
    expect(body.name).toBe('Anvil II')
  })

  test('a response body can be echoed straight back as a PATCH', async () => {
    const { body: original } = await request('/api/products/1')
    const { status } = await request('/api/products/1', json('PATCH', original))
    expect(status).toBe(200)
  })
})

describe('destroy', () => {
  test('requires authentication', async () => {
    const { status } = await request('/api/products/1', { method: 'DELETE' })
    expect(status).toBe(401)
  })

  test('returns 204 and removes the row', async () => {
    const { status } = await request('/api/products/1', { method: 'DELETE', headers: { 'x-user': '1' } })
    expect(status).toBe(204)
    expect(await Product.objects.filter({ id: 1 }).exists()).toBe(false)
  })
})

describe('queryset scoping', () => {
  test('a viewset queryset hides rows from every action', async () => {
    const scoped = defineApp({
      name: 'scoped',
      prefix: '/',
      urls: router().include(
        '/live',
        modelViewSet({
          model: Product,
          serializer: ProductSerializer,
          queryset: () => Product.objects.filter({ status: 'live' }),
          pagination: false,
        }),
      ),
    })
    const scopedApp = await createApp({ apps: [scoped], openapi: false }, { connectDatabase: false })

    const list = await scopedApp.handle(new Request('http://test/live'))
    expect((await list.json()) as unknown[]).toHaveLength(2)

    // The draft product exists, but not within this viewset's queryset.
    const hidden = await scopedApp.handle(new Request('http://test/live/3'))
    expect(hidden.status).toBe(404)
  })
})

describe('views and errors', () => {
  test('a permission-protected view rejects anonymous callers', async () => {
    expect((await request('/api/whoami')).status).toBe(401)
  })

  test('and admits authenticated ones', async () => {
    const { status, body } = await request('/api/whoami', { headers: { 'x-user': '1' } })
    expect(status).toBe(200)
    expect(body.name).toBe('tester')
  })

  test('a thrown APIError becomes its status code', async () => {
    const { status, body } = await request('/api/boom')
    expect(status).toBe(404)
    expect(body.detail).toBe('Deliberately missing.')
  })

  test('an unmatched path 404s as JSON', async () => {
    const { status, body } = await request('/api/nothing-here')
    expect(status).toBe(404)
    expect(body.error).toBe('NotFound')
  })

  test('debug: false keeps stack traces out of 500s', async () => {
    const exploding = defineApp({
      name: 'exploding',
      prefix: '/',
      urls: router().get('/kaboom', () => {
        throw new Error('internal detail that should not leak')
      }),
    })
    const quiet = await createApp({ apps: [exploding], openapi: false, debug: false }, { connectDatabase: false })
    const response = await quiet.handle(new Request('http://test/kaboom'))
    const body = await response.json()
    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('internal detail')
  })
})
