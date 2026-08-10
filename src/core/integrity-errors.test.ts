/**
 * Constraint violations come from the submitted data, so they belong to the
 * caller. Reporting them as 500 both misleads whoever sent the request and
 * buries genuine server faults in the noise.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { classifyIntegrityError, constraintField } from '../db/errors.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { router } from '../routing/router.ts'
import { serializer } from '../serializers/index.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'
import { errorTranslation } from './errors.ts'
import { Elysia } from 'elysia'

const Author = defineModel('intAuthor', {
  fields: { name: f.char({ maxLength: 60, unique: true }) },
  meta: { tableName: 'int_authors' },
})

const Book = defineModel('intBook', {
  fields: {
    title: f.char({ maxLength: 60 }),
    author: f.foreignKey(() => Author),
  },
  meta: { tableName: 'int_books' },
})

const BookSerializer = serializer(Book, { readOnly: ['id'] })
const AuthorSerializer = serializer(Author, { readOnly: ['id'] })

let db: TestDatabase
let app: Elysia

beforeAll(async () => {
  db = await testDatabase({ models: [Author, Book] })
  app = new Elysia()
    .use(errorTranslation({ debug: false }))
    .use(modelViewSet({ model: Book, serializer: BookSerializer }).toElysia({ prefix: '/books' }))
    .use(modelViewSet({ model: Author, serializer: AuthorSerializer }).toElysia({ prefix: '/authors' }))
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
})

const post = (path: string, body: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('classification', () => {
  test('recognises SQLite constraint messages', () => {
    expect(classifyIntegrityError(new Error('UNIQUE constraint failed: int_authors.name'))).toBe('unique')
    expect(classifyIntegrityError(new Error('FOREIGN KEY constraint failed'))).toBe('foreign-key')
    expect(classifyIntegrityError(new Error('NOT NULL constraint failed: int_books.title'))).toBe('not-null')
  })

  test('recognises Postgres constraint messages', () => {
    expect(
      classifyIntegrityError(new Error('duplicate key value violates unique constraint "authors_name_key"')),
    ).toBe('unique')
    expect(classifyIntegrityError(new Error('insert or update violates foreign key constraint "fk"'))).toBe(
      'foreign-key',
    )
    expect(classifyIntegrityError(new Error('null value in column "title" violates not-null constraint'))).toBe(
      'not-null',
    )
  })

  test('leaves an ordinary error alone, so real 500s stay 500s', () => {
    expect(classifyIntegrityError(new Error('Cannot read property x of undefined'))).toBeNull()
    expect(classifyIntegrityError(undefined)).toBeNull()
  })

  test('names the offending column when the driver does', () => {
    expect(constraintField(new Error('UNIQUE constraint failed: int_authors.name'))).toBe('name')
    expect(constraintField(new Error('null value in column "title" violates not-null'))).toBe('title')
  })
})

describe('over HTTP', () => {
  test('a duplicate is 409, not 500', async () => {
    await post('/authors', { name: 'Ursula' })
    const response = await post('/authors', { name: 'Ursula' })

    expect(response.status).toBe(409)
    const body = (await response.json()) as any
    expect(body.code).toBe('conflict')
    // Named per-field so a form can put the message next to the input.
    expect(body.errors?.name).toBeDefined()
  })

  test('a reference to a row that does not exist is 400, not 500', async () => {
    const response = await post('/books', { title: 'A Wizard of Earthsea', author: 9999 })

    expect(response.status).toBe(400)
    expect(((await response.json()) as any).detail).toMatch(/related record/i)
  })

  test('the message describes the problem rather than leaking SQL', async () => {
    await post('/authors', { name: 'Ursula' })
    const body = (await (await post('/authors', { name: 'Ursula' })).json()) as any

    expect(body.detail).not.toMatch(/constraint|SQL|int_authors/i)
    expect(body.stack).toBeUndefined()
  })

  test('a valid write is unaffected', async () => {
    const author = await Author.objects.create({ name: 'Ursula' })
    const response = await post('/books', { title: 'The Dispossessed', author: author.id })
    expect(response.status).toBe(201)
  })
})
