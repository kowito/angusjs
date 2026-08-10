/**
 * An agent that can only call tools learns the domain by trying things, which
 * on a write endpoint means learning by causing failures. Resources let it read
 * the shape first — from the same declarations the server enforces.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { router } from '../routing/router.ts'
import { isAuthenticated } from '../routing/router.ts'
import { serializer } from '../serializers/index.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'
import { buildResources, readResource, toResourceDefinition, type Resource } from './resources.ts'
import { dispatch, type DispatchContext, type Era } from './protocol.ts'

const MODERN: Era = { modern: true, version: '2026-07-28' }

const Author = defineModel('resAuthor', {
  fields: { name: f.char({ maxLength: 60, unique: true }) },
  meta: { tableName: 'res_authors' },
})

const Book = defineModel('resBook', {
  fields: {
    title: f.char({ maxLength: 120 }),
    status: f.char({ choices: ['draft', 'published'], default: 'draft' }),
    notes: f.text({ null: true }),
    author: f.foreignKey(() => Author),
  },
  meta: { tableName: 'res_books', verboseName: 'book' },
})

const routes = router()
  .include('/books', modelViewSet({ model: Book, serializer: serializer(Book, { readOnly: ['id'] }) }))
  .include(
    '/authors',
    modelViewSet({
      model: Author,
      serializer: serializer(Author, { readOnly: ['id'] }),
      permissions: [isAuthenticated],
    }),
  )

let db: TestDatabase
let resources: Resource[]

beforeAll(async () => {
  db = await testDatabase({ models: [Author, Book] })
  resources = buildResources({
    models: [Author, Book],
    routes: routes.flatten(),
    openapi: () => ({ openapi: '3.1.0', info: { title: 'test', version: '1' } }),
  })
})

afterAll(async () => {
  await db.close()
})

const uris = () => resources.map((resource) => resource.uri)
const read = async (uri: string) => JSON.parse((await readResource(resources, uri)).text)

describe('what is offered', () => {
  test('a summary, one per model, the routes and the OpenAPI document', () => {
    expect(uris()).toEqual([
      'angus://models',
      'angus://models/resAuthor',
      'angus://models/resBook',
      'angus://openapi',
      'angus://routes',
    ])
  })

  test('the OpenAPI resource is dropped when the document is not served', () => {
    const without = buildResources({ models: [Book], routes: [] })
    expect(without.map((resource) => resource.uri)).not.toContain('angus://openapi')
  })

  test('extra resources are appended', () => {
    const withGlossary = buildResources({
      models: [],
      routes: [],
      extra: [
        { uri: 'angus://glossary', name: 'glossary', mimeType: 'text/plain', read: () => 'a book is a book' },
      ],
    })
    expect(withGlossary.map((resource) => resource.uri)).toContain('angus://glossary')
  })

  test('a definition carries no reader, since it has to be serialisable', () => {
    expect(toResourceDefinition(resources[0]!)).not.toHaveProperty('read')
    expect(toResourceDefinition(resources[0]!).uri).toBe('angus://models')
  })
})

describe('what a model resource says', () => {
  test('the field types and constraints a caller needs', async () => {
    const book = await read('angus://models/resBook')
    const byName = Object.fromEntries(book.fields.map((field: any) => [field.name, field]))

    expect(byName.title.kind).toBe('char')
    expect(byName.title.maxLength).toBe(120)
    expect(byName.status.choices).toEqual(['draft', 'published'])
    expect(byName.notes.nullable).toBe(true)
  })

  test('which fields must be supplied, and which the database fills in', async () => {
    const book = await read('angus://models/resBook')
    const byName = Object.fromEntries(book.fields.map((field: any) => [field.name, field]))

    // The distinction an agent gets wrong first: a defaulted field is not
    // required, and a nullable one is not either.
    expect(byName.title.required).toBe(true)
    expect(byName.status.required).toBe(false)
    expect(byName.notes.required).toBe(false)
  })

  test('a relation names the model to go and read next', async () => {
    const book = await read('angus://models/resBook')
    const author = book.fields.find((field: any) => field.name === 'author')

    expect(author.relatesTo).toBe('resAuthor')
  })

  test('the summary covers every model', async () => {
    const all = await read('angus://models')
    expect(all.map((model: any) => model.name)).toEqual(['resAuthor', 'resBook'])
  })
})

describe('what the route resource says', () => {
  test('the endpoints, and that some are guarded', async () => {
    const table = await read('angus://routes')
    const authorList = table.find((route: any) => route.path === '/authors' && route.method === 'GET')
    const bookList = table.find((route: any) => route.path === '/books' && route.method === 'GET')

    expect(authorList.guarded).toBe(true)
    expect(bookList.guarded).toBe(false)
  })

  test('it does not spell out how a route is guarded', async () => {
    // Knowing a route is protected is useful; knowing exactly how would be a
    // map of what to attack.
    const raw = (await readResource(resources, 'angus://routes')).text
    expect(raw).not.toMatch(/isAuthenticated|permission.*function/i)
  })
})

describe('reading', () => {
  test('content comes back with its type', async () => {
    const contents = await readResource(resources, 'angus://openapi')
    expect(contents.mimeType).toBe('application/json')
    expect(JSON.parse(contents.text).openapi).toBe('3.1.0')
  })

  test('an unknown URI says so rather than returning nothing', () => {
    expect(readResource(resources, 'angus://nope')).rejects.toThrow(/Unknown resource/)
  })

  test('content is produced per read, so it cannot go stale', async () => {
    let reads = 0
    const counted = buildResources({
      models: [],
      routes: [],
      extra: [{ uri: 'angus://count', name: 'count', mimeType: 'text/plain', read: () => String(++reads) }],
    })

    expect((await readResource(counted, 'angus://count')).text).toBe('1')
    expect((await readResource(counted, 'angus://count')).text).toBe('2')
  })
})

describe('over the protocol', () => {
  const context = (): DispatchContext => ({
    app: new Elysia(),
    tools: [],
    resources,
    identity: { name: 'test', version: '0' },
  })

  const call = (method: string, params?: Record<string, unknown>) =>
    dispatch(context(), { jsonrpc: '2.0', id: 1, method, params }, MODERN) as any

  test('resources/list returns them without their readers', async () => {
    const response = await call('resources/list')
    expect(response.result.resources).toHaveLength(resources.length)
    expect(response.result.resources[0]).not.toHaveProperty('read')
  })

  test('resources/read returns the contents', async () => {
    const response = await call('resources/read', { uri: 'angus://models/resBook' })
    expect(JSON.parse(response.result.contents[0].text).name).toBe('resBook')
  })

  test('an unknown URI is a protocol error, not an empty result', async () => {
    // Unlike a tool call there is no result for the model to learn from, so
    // failing quietly would leave it reasoning about nothing.
    const response = await call('resources/read', { uri: 'angus://nope' })
    expect(response.error.code).toBe(-32602)
  })

  test('the server advertises the capability', async () => {
    const response = await call('initialize')
    expect(response.result.capabilities.resources).toBeDefined()
    // Subscriptions would need a channel the stateless transport does not have.
    expect(response.result.capabilities.resources.subscribe).toBe(false)
  })
})
