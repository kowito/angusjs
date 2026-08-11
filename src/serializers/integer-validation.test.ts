/**
 * Integer fields must reject fractional input at the write boundary, on every
 * dialect, with a message that says so. Integer-ness is an explicit constraint
 * (multipleOf: 1) rather than a property of the coercing type, so it does not
 * depend on Elysia internals that could change between versions.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { serializer } from './index.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { errorTranslation } from '../core/errors.ts'
import { clientFor, testDatabase, type TestDatabase } from '../testing/index.ts'

const Item = defineModel('ivItem', {
  fields: { qty: f.integer(), price: f.integer({ min: 0, max: 1000 }) },
  meta: { tableName: 'iv_items' },
})

let db: TestDatabase
let client: ReturnType<typeof clientFor>
beforeAll(async () => {
  db = await testDatabase({ models: [Item] })
  const app: any = new Elysia()
    .use(errorTranslation({ debug: false }))
    .use(modelViewSet({ model: Item, serializer: serializer(Item, { readOnly: ['id'] }) }).toElysia({ prefix: '/items' }))
  client = clientFor(app)
})
afterAll(async () => { await db.close() })

describe('integer write validation', () => {
  test('a whole number is accepted and stored exactly', async () => {
    const body = (await client.post('/items', { qty: 7, price: 10 })).expect(201)
    expect(body.qty).toBe(7)
  })

  test('a coerced string integer is still accepted', async () => {
    expect((await client.post('/items', { qty: '4', price: 0 })).status).toBe(201)
  })

  test('a fractional number is rejected with a clear message', async () => {
    const res = await client.post('/items', { qty: 2.5, price: 10 })
    expect(res.status).toBe(422)
    expect((res.body as any).errors.qty).toContain('must be a whole number')
  })

  test('a fractional string is rejected too', async () => {
    expect((await client.post('/items', { qty: '4.9', price: 10 })).status).toBe(422)
  })

  test('a bound is still enforced alongside integer-ness', async () => {
    expect((await client.post('/items', { qty: 1, price: 5000 })).status).toBe(422)
  })
})
