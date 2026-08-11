/**
 * A dynamic filter — one built from a query string or cast past the types —
 * fails at runtime, and the message is the only guidance the developer gets.
 * These pin that it points at the real mistake, not a plausible wrong one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { f } from './fields.ts'
import { defineModel } from './model.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

const Post = defineModel('leePost', {
  fields: { title: f.char({ maxLength: 40 }), views: f.integer({ default: 0 }), author: f.foreignKey(() => Author) },
  meta: { tableName: 'lee_posts' },
})
const Author = defineModel('leeAuthor', { fields: { name: f.char({ maxLength: 40 }) }, meta: { tableName: 'lee_authors' } })

let db: TestDatabase
beforeAll(async () => { db = await testDatabase({ models: [Post, Author] }) })
afterAll(async () => { await db.close() })

const message = async (filter: unknown) => {
  try {
    await Post.objects.filter(filter as never).execute()
    return 'NO ERROR'
  } catch (error) {
    return (error as Error).message
  }
}

describe('an unknown field', () => {
  test('suggests the field that was meant', async () => {
    const msg = await message({ titel: 'x' })
    expect(msg).toContain('has no field named "titel"')
    expect(msg).toContain('Did you mean "title"?')
    expect(msg).toContain('Available: id, title, views, author')
  })

  test('says nothing misleading when nothing is close', async () => {
    const msg = await message({ xyzzy: 'x' })
    expect(msg).toContain('has no field named "xyzzy"')
    expect(msg).not.toContain('Did you mean')
  })
})

describe('an invalid lookup on a scalar field', () => {
  test('is diagnosed as a bad lookup, not a failed relation traversal', async () => {
    // The bug this replaces: `views__biggerthan` used to be reported as "views
    // is not a relation", sending the developer to look for a foreign key.
    const msg = await message({ views__biggerthan: 5 })
    expect(msg).toContain('"biggerthan" is not a valid lookup on field "views"')
    expect(msg).not.toContain('is not a relation')
    expect(msg).toContain('Valid lookups:')
    expect(msg).toContain('gt, gte, lt, lte')
  })

  test('suggests the lookup that was meant', async () => {
    expect(await message({ views__gte_: 5 })).toContain('Did you mean "gte"?')
  })
})

describe('a real relation still traverses', () => {
  test('author__name is valid', async () => {
    expect(await message({ author__name: 'Ada' })).toBe('NO ERROR')
  })

  test('traversing through a scalar with more segments still explains itself', async () => {
    // Two-plus trailing segments on a scalar is a genuine traversal mistake.
    const msg = await message({ title__author__name: 'x' })
    expect(msg).toContain('is not a relation')
  })
})
