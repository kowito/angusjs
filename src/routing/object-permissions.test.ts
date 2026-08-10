/**
 * "Anyone signed in may read a post, but only its author may edit it."
 *
 * That sentence needs both a route permission and a rule about the row, and
 * neither can say it alone: a permission runs before anything is fetched, and a
 * queryset that hid other people's posts would hide them from readers too.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { errorTranslation } from '../core/errors.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { serializer } from '../serializers/index.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'
import { modelViewSet } from './viewset.ts'
import { isAuthenticated } from './router.ts'

const Post = defineModel('opPost', {
  fields: {
    title: f.char({ maxLength: 60 }),
    authorId: f.integer(),
  },
  meta: { tableName: 'op_posts' },
})

const PostSerializer = serializer(Post, { readOnly: ['id'] })

/**
 * Built by a function rather than annotated: `.resolve()` widens the instance
 * type, so any annotation you could write here would be a lie about what is
 * assigned to it.
 */
function buildApp() {
  return new Elysia()
    .use(errorTranslation({ debug: false }))
    .resolve(({ request }) => {
      const id = Number(request.headers.get('x-user') ?? 0)
      return { user: id ? { id } : null }
    })
    .use(
      modelViewSet({
        model: Post,
        serializer: PostSerializer,
        permissions: [isAuthenticated],
        // Reading is open to anyone signed in; changing it is not.
        objectPermissions: {
          update: (post, context) => post.authorId === (context.user as any)?.id,
          partialUpdate: (post, context) => post.authorId === (context.user as any)?.id,
          destroy: (post, context) => post.authorId === (context.user as any)?.id,
        },
      }).toElysia({ prefix: '/posts' }),
    )
}

let db: TestDatabase
let app: ReturnType<typeof buildApp>

/** The caller is whoever `x-user` names; 0 means anonymous. */
const asUser = (id: number): Record<string, string> => (id === 0 ? {} : { 'x-user': String(id) })

beforeAll(async () => {
  db = await testDatabase({ models: [Post] })
  app = buildApp()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  await Post.objects.bulkCreate([
    { title: 'By one', authorId: 1 },
    { title: 'By two', authorId: 2 },
  ])
})

const request = (method: string, path: string, user: number, body?: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...asUser(user) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )

describe('reads stay open', () => {
  test('a signed-in reader may retrieve someone else’s post', async () => {
    const response = await request('GET', '/posts/2', 1)
    expect(response.status).toBe(200)
  })

  test('the list is unaffected', async () => {
    const response = await request('GET', '/posts', 1)
    const body = (await response.json()) as any
    expect(body.results ?? body).toHaveLength(2)
  })
})

describe('writes are judged against the row', () => {
  test('the author may update their own post', async () => {
    const response = await request('PATCH', '/posts/1', 1, { title: 'Edited' })
    expect(response.status).toBe(200)
    expect((await Post.objects.get({ id: 1 })).title).toBe('Edited')
  })

  test('another user may not', async () => {
    const response = await request('PATCH', '/posts/1', 2, { title: 'Hijacked' })

    expect(response.status).toBe(403)
    expect((await Post.objects.get({ id: 1 })).title).toBe('By one')
  })

  test('PUT is checked too, not only PATCH', async () => {
    const response = await request('PUT', '/posts/1', 2, { title: 'Hijacked', authorId: 2 })
    expect(response.status).toBe(403)
  })

  test('delete is checked, and the row survives the refusal', async () => {
    const response = await request('DELETE', '/posts/1', 2)

    expect(response.status).toBe(403)
    expect(await Post.objects.filter({ id: 1 }).exists()).toBe(true)
  })

  test('the author may delete', async () => {
    expect((await request('DELETE', '/posts/1', 1)).status).toBe(204)
  })
})

describe('the check runs before anything is changed', () => {
  test('a refused update does not run hooks or touch the database', async () => {
    // The order that matters: load, judge, then act. Judging after the write
    // would be a rollback problem rather than a permission.
    const before = await Post.objects.get({ id: 1 })
    await request('PATCH', '/posts/1', 2, { title: 'Hijacked' })
    const after = await Post.objects.get({ id: 1 })

    expect(after.title).toBe(before.title)
  })
})

describe('a missing row still reads as missing', () => {
  test('404 rather than 403, since there is nothing to be forbidden from', async () => {
    expect((await request('PATCH', '/posts/999', 1, { title: 'x' })).status).toBe(404)
  })
})

describe('shapes of the option', () => {
  test('one function covers every detail action', async () => {
    const strict = new Elysia()
      .use(errorTranslation({ debug: false }))
      .resolve(({ request }) => ({ user: { id: Number(request.headers.get('x-user') ?? 0) } }))
      .use(
        modelViewSet({
          model: Post,
          serializer: PostSerializer,
          objectPermissions: (post, context) => post.authorId === (context.user as any)?.id,
        }).toElysia({ prefix: '/strict' }),
      )

    const mine = await strict.handle(new Request('http://localhost/strict/1', { headers: asUser(1) }))
    const theirs = await strict.handle(new Request('http://localhost/strict/2', { headers: asUser(1) }))

    // Applied to retrieve as well, which the per-action form left open.
    expect(mine.status).toBe(200)
    expect(theirs.status).toBe(403)
  })

  test('an async check can consult the database', async () => {
    const viaQuery = new Elysia()
      .use(errorTranslation({ debug: false }))
      .resolve(({ request }) => ({ user: { id: Number(request.headers.get('x-user') ?? 0) } }))
      .use(
        modelViewSet({
          model: Post,
          serializer: PostSerializer,
          objectPermissions: {
            // Object rules often depend on something the row does not carry.
            destroy: async (post) => (await Post.objects.filter({ authorId: post.authorId }).count()) > 1,
          },
        }).toElysia({ prefix: '/async' }),
      )

    // Author 1 has exactly one post, so the rule refuses.
    expect((await viaQuery.handle(new Request('http://localhost/async/1', { method: 'DELETE' }))).status).toBe(403)

    await Post.objects.create({ title: 'Another by one', authorId: 1 })
    expect((await viaQuery.handle(new Request('http://localhost/async/1', { method: 'DELETE' }))).status).toBe(204)
  })

  test('an anonymous caller is told to sign in rather than simply refused', async () => {
    const open = new Elysia()
      .use(errorTranslation({ debug: false }))
      .use(
        modelViewSet({
          model: Post,
          serializer: PostSerializer,
          objectPermissions: () => false,
        }).toElysia({ prefix: '/open' }),
      )

    // 401 is the more useful answer: signing in might actually help.
    expect((await open.handle(new Request('http://localhost/open/1'))).status).toBe(401)
  })
})
