/**
 * afterDelete must receive the rows that went, even when no beforeDelete hook
 * exists. broadcastOnWrite registers only afterDelete, so reading the doomed
 * rows solely for beforeDelete meant every realtime delete event carried an
 * empty rows array and clients never removed the deleted records.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { f } from './fields.ts'
import { defineModel } from './model.ts'
import { onModel, _resetHooks } from './hooks.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

const Message = defineModel('adMessage', { fields: { body: f.char({ maxLength: 40 }) }, meta: { tableName: 'ad_messages' } })
let db: TestDatabase
beforeAll(async () => { db = await testDatabase({ models: [Message] }) })
afterAll(async () => { await db.close() })
beforeEach(async () => { await db.reset() })
afterEach(() => _resetHooks())

test('afterDelete receives the deleted rows with no beforeDelete registered', async () => {
  const seen: unknown[][] = []
  onModel(Message, 'afterDelete', ({ rows }) => { seen.push(rows ?? []) })

  await Message.objects.bulkCreate([{ body: 'a' }, { body: 'b' }, { body: 'c' }])
  const count = await Message.objects.filter({ body__in: ['a', 'b'] }).delete()

  expect(count).toBe(2)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.map((r: any) => r.body).sort()).toEqual(['a', 'b'])
})

test('with neither hook, no extra read is done and delete still works', async () => {
  await Message.objects.bulkCreate([{ body: 'x' }])
  expect(await Message.objects.all().delete()).toBe(1)
})

test('beforeDelete still sees the rows too', async () => {
  const seen: unknown[] = []
  onModel(Message, 'beforeDelete', ({ rows }) => { seen.push(...(rows ?? [])) })
  await Message.objects.create({ body: 'z' })
  await Message.objects.all().delete()
  expect(seen).toHaveLength(1)
})
