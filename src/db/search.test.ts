/**
 * Postgres has a text search engine; SQLite, through this path, has LIKE.
 * The API is the same on both — the alternative is every caller branching on
 * dialect — and what differs is quality. These run on SQLite, so they pin the
 * fallback's behaviour, which is the half most likely to be wrong.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { f } from './fields.ts'
import { defineModel } from './model.ts'
import { searchCapability, searchTerms } from './search.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

const Article = defineModel('searchArticle', {
  fields: {
    title: f.char({ maxLength: 120 }),
    body: f.text({ blank: true, default: '' }),
    published: f.boolean({ default: true }),
  },
  meta: { tableName: 'search_articles', ordering: ['id'] },
})

let db: TestDatabase

beforeAll(async () => {
  db = await testDatabase({ models: [Article] })
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  await Article.objects.bulkCreate([
    { title: 'Coastal erosion in Devon', body: 'Cliffs are retreating along the coast.' },
    { title: 'Erosion control', body: 'Techniques for coastal defence and erosion management.' },
    { title: 'Devon cream teas', body: 'Nothing to do with cliffs.' },
    { title: 'Unrelated', body: 'A note about nothing at all.', published: false },
  ])
})

const titles = async (queryset: any) => (await queryset.execute()).map((row: any) => row.title)

describe('finding', () => {
  test('matches on any of the searched fields', async () => {
    const found = await titles(Article.objects.search('cliffs', ['title', 'body']))
    expect(found).toContain('Coastal erosion in Devon')
    expect(found).toContain('Devon cream teas')
  })

  test('every term must appear, so adding a word narrows', async () => {
    // Only the Devon piece carries both terms; "Erosion control" has no Devon.
    const one = await titles(Article.objects.search('erosion', ['title', 'body']))
    const two = await titles(Article.objects.search('erosion devon', ['title', 'body']))

    expect(one).toHaveLength(2)
    expect(two).toEqual(['Coastal erosion in Devon'])
  })

  test('a quoted phrase is kept whole', () => {
    expect(searchTerms('"cream teas" devon')).toEqual(['cream teas', 'devon'])
  })

  test('matching ignores case', async () => {
    expect(await titles(Article.objects.search('EROSION', ['title']))).toHaveLength(2)
  })

  test('a field left empty does not exclude the row', async () => {
    // The bug coalesce exists to prevent: a null column makes the whole
    // concatenation null, silently dropping every row with a blank field.
    await Article.objects.create({ title: 'Sparse', body: '' })
    expect(await titles(Article.objects.search('sparse', ['title', 'body']))).toContain('Sparse')
  })
})

describe('composing', () => {
  test('search combines with filters rather than replacing them', async () => {
    const found = await titles(
      Article.objects.filter({ published: true }).search('nothing', ['title', 'body']),
    )

    expect(found).toContain('Devon cream teas')
    expect(found).not.toContain('Unrelated')
  })

  test('an empty query is not a search', async () => {
    // A cleared search box must not look like a result set with no matches.
    expect(await titles(Article.objects.search('   ', ['title']))).toHaveLength(4)
  })

  test('searching no fields changes nothing', async () => {
    expect(await titles(Article.objects.search('erosion', []))).toHaveLength(4)
  })

  test('counting a search counts the matches', async () => {
    expect(await Article.objects.search('erosion', ['title', 'body']).count()).toBe(2)
  })
})

describe('ranking', () => {
  test('a row matching more fields comes first', async () => {
    // "Erosion control" has the term in both title and body; the Devon piece
    // has it only in the title.
    const found = await titles(Article.objects.search('erosion', ['title', 'body']))
    expect(found[0]).toBe('Erosion control')
  })

  test('rank: false leaves the queryset ordering alone', async () => {
    const found = await titles(
      Article.objects.orderBy('-title').search('erosion', ['title', 'body'], { rank: false }),
    )
    expect(found).toEqual(['Erosion control', 'Coastal erosion in Devon'])
  })

  test('explicit ordering breaks ties beneath relevance', async () => {
    const found = await titles(Article.objects.orderBy('title').search('devon', ['title', 'body']))
    // Both match once, so the tie falls to title order.
    expect(found).toEqual(['Coastal erosion in Devon', 'Devon cream teas'])
  })
})

describe('safety', () => {
  test('a wildcard is matched literally rather than matching everything', async () => {
    await Article.objects.create({ title: '100% cotton', body: '' })

    // Unescaped, `%` in LIKE would match every row.
    expect(await titles(Article.objects.search('100%', ['title']))).toEqual(['100% cotton'])
  })

  test('an underscore is literal too', async () => {
    await Article.objects.create({ title: 'snake_case naming', body: '' })
    expect(await titles(Article.objects.search('snake_case', ['title']))).toEqual(['snake_case naming'])
  })

  test('a quote does not break the query', async () => {
    // The failure this prevents: on Postgres, `to_tsquery` throws on ordinary
    // typing, so a search box wired to it turns a stray quote into a 500.
    expect(await titles(Article.objects.search(`it's "fine`, ['title', 'body']))).toEqual([])
  })

  test('an unknown field is named rather than failing in SQL', () => {
    expect(() => Article.objects.search('x', ['nope' as never]).count()).toThrow(/no field "nope"/)
  })
})

describe('capability', () => {
  test('says plainly what each dialect provides', () => {
    expect(searchCapability('postgres').fullText).toBe(true)
    expect(searchCapability('sqlite').fullText).toBe(false)
    // Ranking exists on both, by different means.
    expect(searchCapability('sqlite').ranking).toBe(true)
  })
})
