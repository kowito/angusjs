/**
 * A transient failure in the poll loop — a dropped connection, "database is
 * locked", a failover — must not terminate the worker. Before the error
 * boundary, the first such throw rejected the loop promise and the worker
 * silently stopped claiming jobs while the process stayed healthy.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { getConnection, setConnection, type Connection } from '../db/connection.ts'
import { t } from 'elysia'
import { enqueue, job, jobModels, startWorker, _resetJobRegistry } from './index.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

const Widget = defineModel('wrWidget', { fields: { name: f.char({ maxLength: 20 }) }, meta: { tableName: 'wr_widgets' } })
let db: TestDatabase
let realConnection: Connection

const makeWidget = job({
  name: 'wr-make',
  input: t.Object({ name: t.String() }),
  handler: async ({ input }) => { await Widget.objects.create({ name: input.name }) },
})

beforeAll(async () => { db = await testDatabase({ models: [Widget, ...Object.values(jobModels)] }); realConnection = getConnection() })
afterAll(async () => { await db.close() })
beforeEach(async () => { await db.reset(); setConnection(realConnection) })
afterEach(() => { setConnection(realConnection); _resetJobRegistry() })

test('the worker survives a poll failure and recovers', async () => {
  const errors: unknown[] = []

  // Break the connection so the first claimJob throws.
  setConnection(undefined)

  const worker = startWorker({ pollIntervalMs: 5, onError: (e) => errors.push(e) })

  // Let it poll and fail a few times without dying.
  await Bun.sleep(30)
  expect(errors.length).toBeGreaterThan(0)

  // Restore the connection and enqueue work; the still-running worker picks it up.
  setConnection(realConnection)
  await enqueue(makeWidget, { name: 'recovered' })
  await Bun.sleep(60)

  await worker.stop()
  expect(await Widget.objects.filter({ name: 'recovered' }).exists()).toBe(true)
})
