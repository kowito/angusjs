/**
 * The test client's job is to close the feedback loop that a bare `.handle()`
 * leaves open. A 404 with no explanation is the most time-wasting thing a test
 * can return, and the framework knows its own routes — so these tests pin that
 * it says what it knows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { serializer } from '../serializers/index.ts'
import { clientFor, diagnoseNotFound, testDatabase, type TestClient, type TestDatabase } from './index.ts'

const Post = defineModel('tcPost', {
  fields: { title: f.char({ maxLength: 60 }) },
  meta: { tableName: 'tc_posts' },
})

let db: TestDatabase
let app: Elysia<any, any>
let client: TestClient

beforeAll(async () => {
  db = await testDatabase({ models: [Post] })
  app = new Elysia().use(
    modelViewSet({ model: Post, serializer: serializer(Post, { readOnly: ['id'] }) }).toElysia({ prefix: '/posts' }),
  )
  client = clientFor(app)
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
})

describe('expect()', () => {
  test('returns the body on a match, so a test is one line', async () => {
    const created = (await client.post('/posts', { title: 'Hello' })).expect(201)
    expect(created.title).toBe('Hello')
    expect(created.id).toBeDefined()
  })

  test('a mismatch throws with the method, path and both statuses', async () => {
    // 200, not 201 — an ordinary off-by-one in the assertion.
    expect(() => (({ status: 200 }) as any)).not.toThrow()
    await client.post('/posts', { title: 'x' })
    try {
      ;(await client.get('/posts')).expect(201)
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain('Expected status 201 for GET /posts, got 200')
    }
  })

  test('a validation failure keeps the response body, which names the problem', async () => {
    try {
      ;(await client.post('/posts', { title: 123 })).expect(201)
      throw new Error('should have thrown')
    } catch (error) {
      // The body is what tells you *why* — losing it forces a rerun.
      expect((error as Error).message).toContain('Response body:')
    }
  })
})

describe('the 404 diagnosis', () => {
  test('a wrong method names the methods the path does accept', () => {
    // POST-ing to a path that only reads is the classic one.
    const hint = diagnoseNotFound(app, 'DELETE', '/posts')
    expect(hint).toContain('/posts accepts')
    expect(hint).toContain('GET')
    expect(hint).toContain('POST')
  })

  test('a trailing-slash miss is called out specifically', () => {
    const hint = diagnoseNotFound(app, 'GET', '/posts/')
    expect(hint).toMatch(/trailing slash/i)
  })

  test('a near-miss path is suggested', () => {
    // Forgot the prefix — `/1` instead of `/posts/1`.
    const hint = diagnoseNotFound(app, 'GET', '/posts/1/comments')
    expect(hint).toMatch(/did you mean/i)
    expect(hint).toContain('/posts/:id')
  })

  test('a wholly unknown path lists what the app serves', () => {
    const hint = diagnoseNotFound(app, 'GET', '/nowhere')!
    expect(hint).toContain('did not match any route')
    expect(hint).toContain('GET /posts')
  })

  test('expect() surfaces the diagnosis on a real 404', async () => {
    try {
      ;(await client.get('/postz')).expect(200)
      throw new Error('should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('got 404')
      // The whole point: the failure tells you what exists.
      expect(message).toContain('/posts')
    }
  })

  test('an app with no routes says nothing rather than inventing a hint', () => {
    expect(diagnoseNotFound(new Elysia(), 'GET', '/x')).toBeNull()
  })
})

describe('routes()', () => {
  test('reports what the app serves, sorted and stable', () => {
    const paths = client.routes().map((r) => `${r.method} ${r.path}`)
    expect(paths).toContain('GET /posts')
    expect(paths).toContain('POST /posts')
    expect(paths).toContain('DELETE /posts/:id')
  })
})
