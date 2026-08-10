import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { f } from './fields.ts'
import { manyToMany } from './manyToMany.ts'
import { defineModel } from './model.ts'
import { countQueries, testDatabase, type TestDatabase } from '../testing/index.ts'

const Article = defineModel('m2mArticle', {
  fields: { title: f.char({ maxLength: 60 }) },
  meta: { tableName: 'm2m_articles', ordering: ['title'] },
})

const Tag = defineModel('m2mTag', {
  fields: { label: f.char({ maxLength: 40, unique: true }) },
  meta: { tableName: 'm2m_tags', ordering: ['label'] },
})

/**
 * The join is an ordinary model, which is what makes `addedBy` possible without
 * a migration to a "through model" later.
 */
const ArticleTag = defineModel('m2mArticleTag', {
  fields: {
    article: f.foreignKey(() => Article),
    tag: f.foreignKey(() => Tag),
    addedBy: f.char({ maxLength: 40, blank: true, default: '' }),
  },
  meta: { tableName: 'm2m_article_tags', uniqueTogether: [['article', 'tag']] },
})

const Follow = defineModel('m2mFollow', {
  fields: {
    follower: f.foreignKey(() => Article),
    following: f.foreignKey(() => Article),
  },
  meta: { tableName: 'm2m_follows' },
})

const tags = manyToMany({ from: Article, to: Tag, through: ArticleTag })

let db: TestDatabase
let articleId: number
let otherId: number
let tagIds: number[]

beforeAll(async () => {
  db = await testDatabase({ models: [Article, Tag, ArticleTag, Follow] })
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  const [first, second] = await Article.objects.bulkCreate([{ title: 'First' }, { title: 'Second' }])
  articleId = first!.id
  otherId = second!.id
  const created = await Tag.objects.bulkCreate([{ label: 'bun' }, { label: 'elysia' }, { label: 'orm' }])
  tagIds = created.map((tag) => tag.id)
})

describe('reading', () => {
  test('of() returns the related rows', async () => {
    await tags.add(articleId, [tagIds[0]!, tagIds[1]!])
    const related = await tags.of(articleId)
    expect(related.map((tag) => tag.label).sort()).toEqual(['bun', 'elysia'])
  })

  test('an owner with no links gets an empty array', async () => {
    expect(await tags.of(articleId)).toEqual([])
  })

  test('forMany groups by owner in a fixed number of queries', async () => {
    await tags.add(articleId, [tagIds[0]!, tagIds[1]!])
    await tags.add(otherId, [tagIds[2]!])

    const { result, count } = await countQueries(() => tags.forMany([articleId, otherId]))

    expect(result.get(articleId)!.map((tag) => tag.label).sort()).toEqual(['bun', 'elysia'])
    expect(result.get(otherId)!.map((tag) => tag.label)).toEqual(['orm'])
    // Two queries regardless of how many owners: the join rows, then the tags.
    expect(count).toBe(2)
  })

  test('forMany includes owners with no links, as empty arrays', async () => {
    const grouped = await tags.forMany([articleId, otherId])
    expect(grouped.get(articleId)).toEqual([])
    expect(grouped.get(otherId)).toEqual([])
  })

  test('links() exposes the join rows, so extra columns are reachable', async () => {
    await tags.add(articleId, [tagIds[0]!], { addedBy: 'ada' })
    const links = await tags.links(articleId)
    expect(links).toHaveLength(1)
    expect(links[0]!.addedBy).toBe('ada')
  })

  test('has() reports a single link', async () => {
    await tags.add(articleId, [tagIds[0]!])
    expect(await tags.has(articleId, tagIds[0]!)).toBe(true)
    expect(await tags.has(articleId, tagIds[1]!)).toBe(false)
  })
})

describe('writing', () => {
  test('add() creates links and reports the count', async () => {
    expect(await tags.add(articleId, [tagIds[0]!, tagIds[1]!])).toBe(2)
    expect(await tags.of(articleId)).toHaveLength(2)
  })

  test('adding an existing link is a no-op, not a uniqueness violation', async () => {
    await tags.add(articleId, [tagIds[0]!])
    // Re-adding is what a form resubmission does; it must not blow up.
    expect(await tags.add(articleId, [tagIds[0]!, tagIds[1]!])).toBe(1)
    expect(await tags.of(articleId)).toHaveLength(2)
  })

  test('add() deduplicates within one call', async () => {
    expect(await tags.add(articleId, [tagIds[0]!, tagIds[0]!])).toBe(1)
  })

  test('add() with no targets does nothing', async () => {
    expect(await tags.add(articleId, [])).toBe(0)
  })

  test('remove() drops only the named links', async () => {
    await tags.add(articleId, tagIds)
    expect(await tags.remove(articleId, [tagIds[0]!])).toBe(1)
    expect((await tags.of(articleId)).map((tag) => tag.label).sort()).toEqual(['elysia', 'orm'])
  })

  test('clear() removes every link for one owner only', async () => {
    await tags.add(articleId, tagIds)
    await tags.add(otherId, [tagIds[0]!])

    expect(await tags.clear(articleId)).toBe(3)
    expect(await tags.of(articleId)).toEqual([])
    expect(await tags.of(otherId)).toHaveLength(1)
  })

  test('set() makes the collection exactly what was asked for', async () => {
    await tags.add(articleId, [tagIds[0]!, tagIds[1]!])
    await tags.set(articleId, [tagIds[1]!, tagIds[2]!])

    expect((await tags.of(articleId)).map((tag) => tag.label).sort()).toEqual(['elysia', 'orm'])
  })

  test('set([]) clears', async () => {
    await tags.add(articleId, tagIds)
    await tags.set(articleId, [])
    expect(await tags.of(articleId)).toEqual([])
  })

  test('set() leaves untouched links alone, preserving their extra columns', async () => {
    await tags.add(articleId, [tagIds[0]!], { addedBy: 'ada' })
    await tags.set(articleId, [tagIds[0]!, tagIds[1]!])

    const links = await tags.links(articleId)
    const kept = links.find((link) => link.tagId === tagIds[0])!
    // It was not removed and re-added, so `addedBy` survived.
    expect(kept.addedBy).toBe('ada')
  })

  test('a failing set() leaves the previous collection intact', async () => {
    await tags.add(articleId, [tagIds[0]!])
    // 99999 does not exist, so the insert violates the foreign key.
    expect(tags.set(articleId, [tagIds[1]!, 99999])).rejects.toThrow()

    // The transaction rolled back: the original link is still there.
    expect((await tags.of(articleId)).map((tag) => tag.label)).toEqual(['bun'])
  })

  test('extra columns are written on the join row', async () => {
    await tags.add(articleId, [tagIds[0]!], { addedBy: 'grace' })
    expect((await tags.links(articleId))[0]!.addedBy).toBe('grace')
  })
})

describe('configuration', () => {
  test('the foreign keys are inferred when unambiguous', () => {
    expect(tags.fromField).toBe('article')
    expect(tags.toField).toBe('tag')
  })

  test('a self-referential relation must name both ends', () => {
    // Both resolve to the same column otherwise, which would silently produce
    // a relation that follows itself.
    expect(() => manyToMany({ from: Article, to: Article, through: Follow })).toThrow(
      /2 foreign keys pointing at|needs explicit/,
    )
  })

  test('naming both ends makes a self-referential relation work', async () => {
    const follows = manyToMany({
      from: Article,
      to: Article,
      through: Follow,
      fromField: 'follower',
      toField: 'following',
    })

    await follows.add(articleId, [otherId])
    expect((await follows.of(articleId)).map((row) => row.title)).toEqual(['Second'])
    expect(await follows.of(otherId)).toEqual([])
  })

  test('an unrelated through model is rejected', () => {
    expect(() => manyToMany({ from: Tag, to: Tag, through: Follow })).toThrow(/no foreign key pointing at/)
  })

  test('an explicit field that is not a foreign key is rejected', () => {
    expect(() =>
      manyToMany({ from: Article, to: Tag, through: ArticleTag, fromField: 'addedBy' }),
    ).toThrow(/not a foreign key/)
  })
})
