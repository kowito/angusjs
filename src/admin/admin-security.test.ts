/**
 * The admin exposes every model, so it must fail closed. The bug this replaces
 * treated "NODE_ENV is not exactly 'production'" as permission to serve every
 * row anonymously — so an unset or misspelled variable on a public deploy left
 * the whole database open.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { createApp } from '../core/project.ts'
import { adminSite } from './site.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

const Secret = defineModel('admSecret', { fields: { value: f.char({ maxLength: 20 }) }, meta: { tableName: 'adm_secrets' } })
let db: TestDatabase
beforeAll(async () => { db = await testDatabase({ models: [Secret] }) })
afterAll(async () => { await db.close() })

const serve = async (site: ReturnType<typeof adminSite>, path: string) => {
  site.register(Secret)
  const app = await createApp({ apps: [site.app(path.replace('/', '') + '-app')], openapi: false }, { connectDatabase: false })
  return app.handle(new Request(`http://test${path}`))
}

describe('fail closed', () => {
  test('no permissions and no opt-in: refuses, regardless of NODE_ENV', async () => {
    for (const env of [undefined, 'production', 'prod', 'staging', 'development', '']) {
      const previous = Bun.env.NODE_ENV
      if (env === undefined) delete (Bun.env as any).NODE_ENV
      else Bun.env.NODE_ENV = env
      const res = await serve(adminSite({ path: `/a-${env ?? 'unset'}` }), `/a-${env ?? 'unset'}`)
      expect(res.status).toBe(403)
      if (previous === undefined) delete (Bun.env as any).NODE_ENV
      else Bun.env.NODE_ENV = previous
    }
  })

  test('the explicit insecure opt-in serves', async () => {
    const res = await serve(adminSite({ path: '/open', insecureAllowUnauthenticated: true }), '/open')
    expect(res.status).toBe(200)
  })

  test('the insecure opt-in serves even in production (so a deploy of it is genuinely dangerous, and check --deploy flags it)', async () => {
    const previous = Bun.env.NODE_ENV
    Bun.env.NODE_ENV = 'production'
    const res = await serve(adminSite({ path: '/openprod', insecureAllowUnauthenticated: true }), '/openprod')
    expect(res.status).toBe(200)
    if (previous === undefined) delete (Bun.env as any).NODE_ENV
    else Bun.env.NODE_ENV = previous
  })
})
