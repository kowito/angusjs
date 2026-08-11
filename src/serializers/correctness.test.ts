/**
 * Two serializer correctness fixes: a `date` field must round-trip the calendar
 * date regardless of timezone, and a required (non-blank) string must reject the
 * empty string.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { serializer } from './index.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { errorTranslation } from '../core/errors.ts'
import { clientFor, testDatabase, type TestDatabase } from '../testing/index.ts'

const Post = defineModel('scPost', {
  fields: { title: f.char({ maxLength: 40 }), note: f.text({ blank: true, default: '' }), publishOn: f.date() },
  meta: { tableName: 'sc_posts' },
})
let db: TestDatabase
let client: ReturnType<typeof clientFor>
beforeAll(async () => {
  db = await testDatabase({ models: [Post] })
  const app: any = new Elysia().use(errorTranslation({ debug: false })).use(modelViewSet({ model: Post, serializer: serializer(Post, { readOnly: ['id'] }) }).toElysia({ prefix: '/posts' }))
  client = clientFor(app)
})
afterAll(async () => { await db.close() })
beforeEach(async () => { await db.reset() })

describe('date round-trip', () => {
  test('a date comes back as the day it was set, whatever the timezone', async () => {
    const s = serializer(Post, { readOnly: ['id'] })
    const row = await Post.objects.create({ title: 'x', publishOn: new Date(2024, 0, 15) })
    const rep = (await s.toRepresentation(row)) as any
    expect(rep.publishOn).toBe('2024-01-15')
  })
})

describe('blank enforcement', () => {
  test('a required string rejects the empty string', async () => {
    const res = await client.post('/posts', { title: '', publishOn: '2024-01-15' })
    expect(res.status).toBe(422)
    expect((res.body as any).errors.title).toBeDefined()
  })

  test('a blank-allowed field still accepts the empty string', async () => {
    const res = await client.post('/posts', { title: 'ok', note: '', publishOn: '2024-01-15' })
    expect(res.status).toBe(201)
  })
})
