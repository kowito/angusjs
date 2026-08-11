/**
 * `atomic()` on the single shared SQLite connection must not (a) crash when two
 * transactions overlap, nor (b) capture an unrelated concurrent query into an
 * open transaction. Both are silent-corruption bugs that only appear under real
 * concurrency, which sequential tests never exercised.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { f } from './fields.ts'
import { defineModel } from './model.ts'
import { atomic } from './transaction.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

const Row = defineModel('txcRow', { fields: { tag: f.char({ maxLength: 20 }) }, meta: { tableName: 'txc_rows' } })
let db: TestDatabase
beforeAll(async () => { db = await testDatabase({ models: [Row] }) })
afterAll(async () => { await db.close() })
beforeEach(async () => { await db.reset() })

const defer = () => { let resolve!: () => void; const promise = new Promise<void>((r) => (resolve = r)); return { promise, resolve } }

test('two overlapping atomic() blocks do not crash and both commit', async () => {
  // Without serialization the second BEGIN throws "cannot start a transaction
  // within a transaction".
  const a = atomic(async () => { await Row.objects.create({ tag: 'A' }); await Bun.sleep(20) })
  const b = atomic(async () => { await Bun.sleep(5); await Row.objects.create({ tag: 'B' }) })
  await Promise.all([a, b])
  const tags = (await Row.objects.all()).map((r) => r.tag).sort()
  expect(tags).toEqual(['A', 'B'])
})

test('a non-atomic write concurrent with a transaction is serialized, not captured', async () => {
  const gate = defer()
  // A opens a transaction, writes, then waits (as if on an external API call).
  const a = atomic(async () => {
    await Row.objects.create({ tag: 'in-tx' })
    await gate.promise
    throw new Error('rollback A')
  }).catch(() => {})

  // An unrelated request writes while A holds the transaction. It must not be
  // awaited before A finishes — it blocks on the transaction gate until A
  // releases, which is the whole point: it runs *after* the transaction rather
  // than inside it, so A's rollback cannot discard it.
  await Bun.sleep(5)
  const independent = Row.objects.create({ tag: 'independent' })

  gate.resolve()
  await a
  await independent

  const tags = (await Row.objects.all()).map((r) => r.tag)
  expect(tags).toContain('independent') // ran after the rollback, so it survived
  expect(tags).not.toContain('in-tx') // rolled back
})

test('the gate does not deadlock queries issued inside the transaction', async () => {
  // Queries within the block hold the lock, so they must skip the gate rather
  // than wait on themselves.
  const result = await atomic(async () => {
    await Row.objects.create({ tag: 'x' })
    return Row.objects.count() // a read inside the same transaction
  })
  expect(result).toBe(1)
})
