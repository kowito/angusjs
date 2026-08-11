/**
 * The canonical edit flow — GET a record, change a field, PUT it back — must
 * work. A foreign key reads as `<attr>Id` and writes as `<attr>`, and that
 * asymmetry used to 422 the echoed body because `author` was missing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { serializer } from './index.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { errorTranslation } from '../core/errors.ts'
import { clientFor, testDatabase, type TestDatabase } from '../testing/index.ts'

const Author = defineModel('rtAuthor', { fields: { name: f.char({ maxLength: 20 }) }, meta: { tableName: 'rt_authors' } })
const Post = defineModel('rtPost', {
  fields: { title: f.char({ maxLength: 40 }), author: f.foreignKey(() => Author), editor: f.foreignKey(() => Author, { null: true }) },
  meta: { tableName: 'rt_posts' },
})

let db: TestDatabase
let client: ReturnType<typeof clientFor>
let authorId: number
beforeAll(async () => {
  db = await testDatabase({ models: [Author, Post] })
  const app: any = new Elysia().use(errorTranslation({ debug: true })).use(modelViewSet({ model: Post, serializer: serializer(Post, { readOnly: ['id'] }) }).toElysia({ prefix: '/posts' }))
  client = clientFor(app)
})
afterAll(async () => { await db.close() })
beforeEach(async () => { await db.reset(); authorId = (await Author.objects.create({ name: 'Ada' })).id })

test('a response body PUTs back unchanged', async () => {
  const created = (await client.post('/posts', { title: 'X', author: authorId })).expect(201)
  expect(created.authorId).toBe(authorId)
  // The echo — exactly what a form does after loading a record.
  const updated = (await client.put('/posts/1', created)).expect(200)
  expect(updated.authorId).toBe(authorId)
})

test('the documented `author` write key still works', async () => {
  expect((await client.post('/posts', { title: 'Y', author: authorId })).status).toBe(201)
})

test('a required FK is still required when neither key is present', async () => {
  const res = await client.post('/posts', { title: 'Z' })
  // 400 from the serializer's own required check (the FK is schema-optional so
  // either key satisfies it); a client error either way, naming the field.
  expect([400, 422]).toContain(res.status)
  expect((res.body as any).errors.author).toBeDefined()
})

test('PATCH with the echoed authorId updates the relation', async () => {
  await client.post('/posts', { title: 'X', author: authorId })
  const other = await Author.objects.create({ name: 'Grace' })
  const patched = (await client.patch('/posts/1', { authorId: other.id })).expect(200)
  expect(patched.authorId).toBe(other.id)
})

test('an explicit author wins over a stale authorId in the same body', async () => {
  await client.post('/posts', { title: 'X', author: authorId })
  const other = await Author.objects.create({ name: 'Grace' })
  await client.patch('/posts/1', { author: other.id, authorId: 9999 })
  expect((await Post.objects.get({ id: 1 })).authorId).toBe(other.id)
})
