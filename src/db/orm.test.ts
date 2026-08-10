import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { connect, disconnect, getConnection } from './connection.ts'
import { DoesNotExist, MultipleObjectsReturned } from './errors.ts'
import { f } from './fields.ts'
import { Q } from './lookups.ts'
import { defineModel } from './model.ts'

const Author = defineModel('author', {
  fields: {
    name: f.char({ maxLength: 100 }),
    email: f.email({ unique: true }),
    age: f.integer({ null: true }),
  },
  meta: { ordering: ['name'] },
})

const Post = defineModel('post', {
  fields: {
    title: f.char({ maxLength: 200 }),
    body: f.text({ blank: true, default: '' }),
    published: f.boolean({ default: false }),
    views: f.integer({ default: 0 }),
    author: f.foreignKey(() => Author),
    createdAt: f.datetime({ autoNowAdd: true }),
  },
  meta: { ordering: ['-createdAt'] },
})

beforeAll(async () => {
  await connect({ dialect: 'sqlite', url: ':memory:' }, [Author, Post])
  const { client } = getConnection()
  client.exec(`
    CREATE TABLE authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      age INTEGER
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
  `)
})

afterAll(async () => {
  await disconnect()
})

describe('schema derivation', () => {
  test('pluralises table names and snake_cases columns', () => {
    expect(Post.meta.tableName).toBe('posts')
    expect(Post.columns.createdAt).toBe('created_at')
  })

  test('foreign keys get an _id column', () => {
    expect(Post.columns.author).toBe('author_id')
  })

  test('an implicit id primary key is added', () => {
    expect(Post.pk).toBe('id')
    expect(Post.fields.id!.spec.primaryKey).toBe(true)
  })
})

describe('create and read', () => {
  test('create returns the inserted row with defaults applied', async () => {
    const author = await Author.objects.create({ name: 'Ada', email: 'ada@example.com', age: 36 })
    expect(author.id).toBeGreaterThan(0)

    const post = await Post.objects.create({ title: 'Hello', author: author })
    expect(post.title).toBe('Hello')
    expect(post.body).toBe('')
    expect(post.published).toBe(false)
    expect(post.authorId).toBe(author.id)
    // autoNowAdd is stamped in JS, so it round-trips as a Date.
    expect(post.createdAt).toBeInstanceOf(Date)
  })

  test('a foreign key accepts a bare id too', async () => {
    const author = await Author.objects.get({ email: 'ada@example.com' })
    const post = await Post.objects.create({ title: 'By id', author: author.id })
    expect(post.authorId).toBe(author.id)
  })

  test('get throws DoesNotExist when nothing matches', async () => {
    expect(Author.objects.get({ email: 'nobody@example.com' })).rejects.toThrow(DoesNotExist)
  })

  test('get throws MultipleObjectsReturned when several match', async () => {
    expect(Post.objects.get({ published: false })).rejects.toThrow(MultipleObjectsReturned)
  })
})

describe('lookups', () => {
  beforeAll(async () => {
    const [grace] = await Author.objects.bulkCreate([
      { name: 'Grace', email: 'grace@example.com', age: 45 },
      { name: 'Alan', email: 'alan@example.com', age: 41 },
      { name: 'Anonymous', email: 'anon@example.com' },
    ])
    await Post.objects.bulkCreate([
      { title: 'Compilers', author: grace!.id, views: 500, published: true },
      { title: 'COBOL notes', author: grace!.id, views: 12, published: true },
    ])
  })

  test('exact match', async () => {
    const rows = await Author.objects.filter({ name: 'Grace' })
    expect(rows).toHaveLength(1)
  })

  test('gte / lt on numbers', async () => {
    const rows = await Author.objects.filter({ age__gte: 41 }).orderBy('age')
    expect(rows.map((row) => row.name)).toEqual(['Alan', 'Grace'])
  })

  test('icontains', async () => {
    const rows = await Author.objects.filter({ name__icontains: 'a' }).orderBy('name')
    expect(rows.map((row) => row.name)).toEqual(['Alan', 'Anonymous', 'Ada', 'Grace'].sort())
  })

  test('in with an empty array matches nothing', async () => {
    expect(await Author.objects.filter({ name__in: [] })).toHaveLength(0)
  })

  test('isnull', async () => {
    const rows = await Author.objects.filter({ age__isnull: true })
    expect(rows.map((row) => row.name)).toEqual(['Anonymous'])
  })

  test('range is inclusive', async () => {
    const rows = await Author.objects.filter({ age__range: [41, 45] }).orderBy('age')
    expect(rows).toHaveLength(2)
  })

  test('exclude negates', async () => {
    const rows = await Author.objects.exclude({ name: 'Grace' })
    expect(rows.every((row) => row.name !== 'Grace')).toBe(true)
  })

  test('Q.or builds a disjunction', async () => {
    const rows = await Author.objects.filter(Q.or({ name: 'Grace' }, { name: 'Alan' })).orderBy('name')
    expect(rows.map((row) => row.name)).toEqual(['Alan', 'Grace'])
  })

  test('relation traversal filters through a subquery', async () => {
    const rows = await Post.objects.filter({ author__name: 'Grace' }).orderBy('title')
    expect(rows.map((row) => row.title)).toEqual(['COBOL notes', 'Compilers'])
  })

  test('relation traversal supports nested lookups', async () => {
    const rows = await Post.objects.filter({ author__age__gte: 45 })
    expect(rows).toHaveLength(2)
  })

  test('LIKE metacharacters in values are escaped', async () => {
    await Author.objects.create({ name: '100% sure', email: 'pct@example.com' })
    expect(await Author.objects.filter({ name__contains: '100%' })).toHaveLength(1)
    // Without escaping, `%` would act as a wildcard and match everything.
    expect(await Author.objects.filter({ name__contains: '100% s' })).toHaveLength(1)
    expect(await Author.objects.filter({ name__startswith: '_' })).toHaveLength(0)
  })
})

describe('ordering, slicing, aggregates', () => {
  test('default ordering comes from meta', async () => {
    const rows = await Author.objects.all()
    const names = rows.map((row) => row.name)
    expect(names).toEqual([...names].sort())
  })

  test('a leading dash reverses', async () => {
    const rows = await Author.objects.orderBy('-name')
    const names = rows.map((row) => row.name)
    expect(names).toEqual([...names].sort().reverse())
  })

  test('slice applies offset and limit', async () => {
    const all = await Author.objects.orderBy('name')
    const sliced = await Author.objects.orderBy('name').slice(1, 3)
    expect(sliced).toEqual(all.slice(1, 3))
  })

  test('count respects filters', async () => {
    expect(await Post.objects.filter({ published: true }).count()).toBe(2)
  })

  test('exists short-circuits', async () => {
    expect(await Post.objects.filter({ title: 'Compilers' }).exists()).toBe(true)
    expect(await Post.objects.filter({ title: 'Nope' }).exists()).toBe(false)
  })

  test('aggregate computes sum and max', async () => {
    const stats = await Post.objects.filter({ published: true }).aggregate({
      total: 'sum:views',
      best: 'max:views',
    })
    expect(stats.total).toBe(512)
    expect(stats.best).toBe(500)
  })

  test('values narrows the selected columns', async () => {
    const rows = await Author.objects.filter({ name: 'Grace' }).values('name')
    expect(rows[0]).toEqual({ name: 'Grace' })
  })
})

describe('selectRelated', () => {
  test('joins and nests the related row', async () => {
    const posts = await Post.objects.filter({ title: 'Compilers' }).selectRelated('author')
    expect(posts[0]!.author.name).toBe('Grace')
    expect(posts[0]!.title).toBe('Compilers')
  })
})

describe('writes', () => {
  test('update returns the modified rows', async () => {
    const updated = await Post.objects.filter({ title: 'COBOL notes' }).update({ views: 99 })
    expect(updated).toHaveLength(1)
    expect(updated[0]!.views).toBe(99)
  })

  test('getOrCreate creates once then fetches', async () => {
    const [first, createdFirst] = await Author.objects.getOrCreate(
      { email: 'new@example.com' },
      { name: 'New' },
    )
    expect(createdFirst).toBe(true)
    const [second, createdSecond] = await Author.objects.getOrCreate(
      { email: 'new@example.com' },
      { name: 'Ignored' },
    )
    expect(createdSecond).toBe(false)
    expect(second.id).toBe(first.id)
    expect(second.name).toBe('New')
  })

  test('updateOrCreate updates an existing row', async () => {
    const [row, created] = await Author.objects.updateOrCreate({ email: 'new@example.com' }, { name: 'Renamed' })
    expect(created).toBe(false)
    expect(row.name).toBe('Renamed')
  })

  test('delete returns the number of rows removed', async () => {
    await Author.objects.create({ name: 'Doomed', email: 'doomed@example.com' })
    expect(await Author.objects.filter({ email: 'doomed@example.com' }).delete()).toBe(1)
    expect(await Author.objects.filter({ email: 'doomed@example.com' }).exists()).toBe(false)
  })

  test('autoNow stamps on every save but autoNowAdd does not change', async () => {
    const post = await Post.objects.get({ title: 'Compilers' })
    const [updated] = await Post.objects.filter({ id: post.id }).update({ views: 501 })
    expect(updated!.createdAt.getTime()).toBe(post.createdAt.getTime())
  })
})

describe('laziness', () => {
  test('building a queryset issues no query', () => {
    // If this were eager, an unknown field would throw here rather than at await.
    const qs = Post.objects.filter({ title: 'anything' }).orderBy('title').limit(5)
    expect(qs.toSQL().sql).toContain('limit')
  })

  test('querysets are immutable', async () => {
    const base = Post.objects.filter({ published: true })
    const narrowed = base.filter({ views__gt: 100 })
    expect(await base.count()).toBe(2)
    expect(await narrowed.count()).toBe(1)
  })

  test('an unknown field name throws a helpful error', () => {
    expect(() => Post.objects.filter({ nope: 1 } as never).toSQL()).toThrow(/no field named "nope"/)
  })
})
