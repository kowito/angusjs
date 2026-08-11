/**
 * The readiness probe must go red when the database is actually unreachable —
 * the failure that shipped was a probe that reported healthy without ever
 * running a query, so a broken SQLite file stayed in the load-balancer pool.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { clientFor, testDatabase } from '../testing/index.ts'
import { getConnection, setConnection, type Connection } from '../db/connection.ts'
import { health } from './observability.ts'

const app = health()

afterEach(() => setConnection(undefined))

describe('readiness', () => {
  test('reports ready when the database answers', async () => {
    const db = await testDatabase({ models: [] })
    const res = await clientFor(app).get('/readyz')
    expect(res.status).toBe(200)
    expect(res.body.checks.database).toBe(true)
    await db.close()
  })

  test('reports NOT ready when a sqlite query throws (locked/corrupt)', async () => {
    // The exact regression: the old probe returned true here because it never
    // ran the query at all.
    const broken = {
      dialect: 'sqlite',
      client: {
        query: () => ({
          get: () => {
            throw new Error('database is locked')
          },
        }),
      },
      db: {},
      config: { dialect: 'sqlite', url: ':memory:' },
      tables: {},
      table: () => ({}),
      async close() {},
    } as unknown as Connection
    setConnection(broken)

    const res = await clientFor(app).get('/readyz')
    expect(res.status).toBe(503)
    expect(res.body.checks.database).toBe(false)
  })

  test('reports NOT ready when there is no connection at all', async () => {
    setConnection(undefined)
    const res = await clientFor(app).get('/readyz')
    expect(res.status).toBe(503)
    expect(res.body.checks.database).toBe(false)
  })
})
