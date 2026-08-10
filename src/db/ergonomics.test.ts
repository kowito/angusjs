import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { f } from './fields.ts'
import { alive, deleted, restore, softDelete, softRemove, timestamps } from './mixins.ts'
import { defineModel } from './model.ts'
import { decodeCursor, encodeCursor } from './queryset.ts'
import { countQueries, testDatabase, type TestDatabase } from '../testing/index.ts'

const Ticket = defineModel('ergTicket', {
  fields: {
    ...timestamps(),
    ...softDelete(),
    title: f.char({ maxLength: 60 }),
    status: f.char({ choices: ['open', 'closed'], default: 'open' }),
    points: f.integer({ default: 0 }),
  },
  meta: { tableName: 'erg_tickets', ordering: ['id'] },
})

let db: TestDatabase

beforeAll(async () => {
  db = await testDatabase({ models: [Ticket] })
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  await Ticket.objects.bulkCreate([
    { title: 'A', status: 'open', points: 3 },
    { title: 'B', status: 'open', points: 5 },
    { title: 'C', status: 'closed', points: 8 },
    { title: 'D', status: 'closed', points: 1 },
  ])
})

describe('mixins', () => {
  test('timestamps are added and maintained', async () => {
    const ticket = await Ticket.objects.create({ title: 'E' })
    expect(ticket.createdAt).toBeInstanceOf(Date)
    expect(ticket.updatedAt).toBeInstanceOf(Date)

    const [updated] = await Ticket.objects.filter({ id: ticket.id }).update({ points: 2 })
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(ticket.updatedAt.getTime())
    // createdAt is autoNowAdd, so an update must not move it.
    expect(updated!.createdAt.getTime()).toBe(ticket.createdAt.getTime())
  })

  test('a mixin is a plain object, so the fields are visible on the model', () => {
    expect(Object.keys(Ticket.fields)).toContain('createdAt')
    expect(Object.keys(Ticket.fields)).toContain('deletedAt')
  })
})

describe('soft delete', () => {
  test('softRemove marks rather than removes', async () => {
    expect(await softRemove(Ticket.objects.filter({ status: 'closed' }))).toBe(2)

    // Still in the table; just not `alive`.
    expect(await Ticket.objects.count()).toBe(4)
    expect(await alive(Ticket).count()).toBe(2)
    expect(await deleted(Ticket).count()).toBe(2)
  })

  test('delete() is still a real delete — the mixin does not reinterpret it', async () => {
    // Silently making delete() soft would mean a developer reading the call
    // could not tell what it does.
    await Ticket.objects.filter({ title: 'A' }).delete()
    expect(await Ticket.objects.count()).toBe(3)
  })

  test('restore brings rows back', async () => {
    await softRemove(Ticket.objects.filter({ title: 'A' }))
    expect(await alive(Ticket).count()).toBe(3)

    expect(await restore(deleted(Ticket))).toBe(1)
    expect(await alive(Ticket).count()).toBe(4)
  })

  test('softRemove skips rows already marked', async () => {
    await softRemove(Ticket.objects.filter({ title: 'A' }))
    expect(await softRemove(Ticket.objects.filter({ title: 'A' }))).toBe(0)
  })

  test('a model without the mixin says so instead of failing obscurely', () => {
    const Plain = defineModel('ergPlain', { fields: { name: f.char({ maxLength: 10 }) } })
    expect(() => alive(Plain)).toThrow(/has no `deletedAt` field/)
  })
})

describe('groupBy', () => {
  test('aggregates per group', async () => {
    const rows = await Ticket.objects.orderBy('status').groupBy('status', {
      total: 'count:id',
      points: 'sum:points',
    })

    expect(rows).toEqual([
      { status: 'closed', total: 2, points: 9 },
      { status: 'open', total: 2, points: 8 },
    ])
  })

  test('respects the queryset filter', async () => {
    // Only B (5, open) and C (8, closed) qualify.
    const rows = await Ticket.objects.filter({ points__gte: 5 }).orderBy('status').groupBy('status', {
      total: 'count:id',
    })
    expect(rows.map((row) => [row.status, row.total])).toEqual([
      ['closed', 1],
      ['open', 1],
    ])
  })

  test('aggregates come back as numbers, not driver strings', async () => {
    const [row] = await Ticket.objects.groupBy('status', { average: 'avg:points' })
    expect(typeof row!.average).toBe('number')
  })

  test('groups by several columns', async () => {
    const rows = await Ticket.objects.groupBy(['status', 'points'], { total: 'count:id' })
    expect(rows.length).toBe(4)
  })

  test('aggregate() still collapses to one row', async () => {
    const totals = await Ticket.objects.aggregate({ total: 'sum:points' })
    expect(totals.total).toBe(17)
  })
})

describe('cursor pagination', () => {
  test('walks forward without repeating or skipping', async () => {
    const first = await Ticket.objects.page({ size: 2 })
    expect(first.results.map((row) => row.title)).toEqual(['A', 'B'])
    expect(first.hasMore).toBe(true)

    const second = await Ticket.objects.page({ size: 2, after: first.nextCursor })
    expect(second.results.map((row) => row.title)).toEqual(['C', 'D'])
    expect(second.hasMore).toBe(false)
    expect(second.nextCursor).toBeNull()
  })

  test('is unaffected by rows inserted before the cursor', async () => {
    // The failure offset pagination has: insert earlier rows between pages and
    // the reader sees something twice.
    const first = await Ticket.objects.page({ size: 2 })
    await Ticket.objects.create({ title: 'inserted' })

    const second = await Ticket.objects.page({ size: 2, after: first.nextCursor })
    const seen = [...first.results, ...second.results].map((row) => row.title)
    expect(new Set(seen).size).toBe(seen.length)
  })

  test('pages descending', async () => {
    const page = await Ticket.objects.page({ size: 2, descending: true })
    expect(page.results.map((row) => row.title)).toEqual(['D', 'C'])
  })

  test('costs one query per page, with no count', async () => {
    // The extra row is what answers "is there more?" without a second query.
    const { count } = await countQueries(() => Ticket.objects.page({ size: 2 }))
    expect(count).toBe(1)
  })

  test('an invalid cursor is rejected clearly', async () => {
    expect(Ticket.objects.page({ after: 'not-a-cursor' })).rejects.toThrow(/not valid/)
  })

  test('cursors round-trip values and dates', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42)
    expect(decodeCursor(encodeCursor('abc'))).toBe('abc')
    const now = new Date('2026-08-11T10:00:00.000Z')
    expect((decodeCursor(encodeCursor(now)) as Date).toISOString()).toBe(now.toISOString())
  })
})

describe('escape hatch', () => {
  test('query() exposes the Drizzle builder and this model table', async () => {
    const { db: handle, table } = Ticket.objects.query()
    expect(table[Ticket.columns.title!]).toBeDefined()

    const rows = await handle.select({ title: table[Ticket.columns.title!] }).from(table)
    expect(rows).toHaveLength(4)
  })
})
