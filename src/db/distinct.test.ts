/**
 * `distinct()` was storing a flag that nothing read, so it silently returned
 * duplicates. It must actually de-duplicate, on both execute() and count().
 */

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { f } from './fields.ts'
import { defineModel } from './model.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

const Event = defineModel('dsEvent', {
  fields: { category: f.char({ maxLength: 20 }), city: f.char({ maxLength: 20 }) },
  meta: { tableName: 'ds_events' },
})
let db: TestDatabase
beforeAll(async () => { db = await testDatabase({ models: [Event] }) })
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.reset()
  await Event.objects.bulkCreate([
    { category: 'talk', city: 'London' },
    { category: 'talk', city: 'London' },
    { category: 'talk', city: 'Paris' },
    { category: 'workshop', city: 'Paris' },
  ])
})

test('distinct() on selected columns removes duplicate rows', async () => {
  const rows = await Event.objects.values('category', 'city').distinct().orderBy('category', 'city')
  expect(rows).toEqual([
    { category: 'talk', city: 'London' },
    { category: 'talk', city: 'Paris' },
    { category: 'workshop', city: 'Paris' },
  ])
})

test('count() on a distinct queryset counts distinct rows', async () => {
  expect(await Event.objects.values('category').distinct().count()).toBe(2) // talk, workshop
  expect(await Event.objects.values('category', 'city').distinct().count()).toBe(3)
})

test('without distinct, duplicates and the full count remain', async () => {
  expect(await Event.objects.count()).toBe(4)
  expect(await Event.objects.values('category').distinct().count()).not.toBe(4)
})
