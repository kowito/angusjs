import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { connect, disconnect, getConnection } from './connection.ts'
import { F } from './expressions.ts'
import { f } from './fields.ts'
import { defineModel } from './model.ts'
import { atomic, inTransaction, rollbackAfter } from './transaction.ts'

const Account = defineModel('account', {
  fields: {
    owner: f.char({ maxLength: 60 }),
    balance: f.integer({ default: 0 }),
  },
  meta: { ordering: ['owner'] },
})

beforeAll(async () => {
  await connect({ dialect: 'sqlite', url: ':memory:' }, [Account])
  getConnection().client.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0
    );
  `)
})

afterAll(async () => {
  await disconnect()
})

beforeEach(async () => {
  getConnection().client.exec("DELETE FROM accounts; DELETE FROM sqlite_sequence WHERE name = 'accounts';")
  await Account.objects.bulkCreate([
    { owner: 'ada', balance: 100 },
    { owner: 'grace', balance: 50 },
  ])
})

describe('atomic', () => {
  test('commits when the block resolves', async () => {
    await atomic(async () => {
      await Account.objects.create({ owner: 'kay', balance: 10 })
    })
    expect(await Account.objects.filter({ owner: 'kay' }).exists()).toBe(true)
  })

  test('rolls back when the block throws', async () => {
    // Regression: Drizzle's bun-sqlite driver is synchronous and does NOT roll
    // back when its transaction callback is async — it commits before the
    // awaited work finishes. `atomic()` issues the statements itself for
    // exactly this reason, so this test is the guard on that decision.
    await expect(
      atomic(async () => {
        await Account.objects.create({ owner: 'ghost', balance: 999 })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await Account.objects.filter({ owner: 'ghost' }).exists()).toBe(false)
  })

  test('rolls back writes made across several calls', async () => {
    await expect(
      atomic(async () => {
        await Account.objects.filter({ owner: 'ada' }).update({ balance: 0 })
        await Account.objects.filter({ owner: 'grace' }).update({ balance: 0 })
        throw new Error('abort')
      }),
    ).rejects.toThrow()

    const balances = (await Account.objects.orderBy('owner')).map((row) => row.balance)
    expect(balances).toEqual([100, 50])
  })

  test('returns the block value', async () => {
    const created = await atomic(async () => Account.objects.create({ owner: 'kay', balance: 7 }))
    expect(created.owner).toBe('kay')
  })

  test('reports whether a transaction is open', async () => {
    expect(inTransaction()).toBe(false)
    await atomic(async () => {
      expect(inTransaction()).toBe(true)
    })
    expect(inTransaction()).toBe(false)
  })

  test('a nested block is a savepoint: inner failure need not lose outer work', async () => {
    await atomic(async () => {
      await Account.objects.create({ owner: 'outer', balance: 1 })

      try {
        await atomic(async () => {
          await Account.objects.create({ owner: 'inner', balance: 2 })
          throw new Error('inner fails')
        })
      } catch {
        // Swallowed on purpose: the outer transaction should survive.
      }
    })

    expect(await Account.objects.filter({ owner: 'outer' }).exists()).toBe(true)
    expect(await Account.objects.filter({ owner: 'inner' }).exists()).toBe(false)
  })

  test('a nested failure that propagates rolls back everything', async () => {
    await expect(
      atomic(async () => {
        await Account.objects.create({ owner: 'outer', balance: 1 })
        await atomic(async () => {
          await Account.objects.create({ owner: 'inner', balance: 2 })
          throw new Error('propagates')
        })
      }),
    ).rejects.toThrow()

    expect(await Account.objects.filter({ owner__in: ['outer', 'inner'] })).toHaveLength(0)
  })

  test('rollbackAfter discards the work but returns the value', async () => {
    const value = await rollbackAfter(async () => {
      await Account.objects.create({ owner: 'temp', balance: 1 })
      return 'computed'
    })

    expect(value).toBe('computed')
    expect(await Account.objects.filter({ owner: 'temp' }).exists()).toBe(false)
  })
})

describe('F expressions', () => {
  test('increments using the column value, not a value read into JS', async () => {
    await Account.objects.filter({ owner: 'ada' }).update({ balance: F('balance').add(10) })
    expect((await Account.objects.get({ owner: 'ada' })).balance).toBe(110)
  })

  test('concurrent increments do not lose updates', async () => {
    // The read-modify-write this replaces loses increments: both callers read
    // 100 and both write 101. With F() the database serialises the arithmetic.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        Account.objects.filter({ owner: 'ada' }).update({ balance: F('balance').add(1) }),
      ),
    )
    expect((await Account.objects.get({ owner: 'ada' })).balance).toBe(120)
  })

  test('supports subtraction, multiplication and chaining', async () => {
    await Account.objects.filter({ owner: 'grace' }).update({ balance: F('balance').sub(20) })
    expect((await Account.objects.get({ owner: 'grace' })).balance).toBe(30)

    await Account.objects.filter({ owner: 'grace' }).update({ balance: F('balance').mul(2) })
    expect((await Account.objects.get({ owner: 'grace' })).balance).toBe(60)

    // Parenthesised left to right: (balance + 10) * 2
    await Account.objects.filter({ owner: 'grace' }).update({ balance: F('balance').add(10).mul(2) })
    expect((await Account.objects.get({ owner: 'grace' })).balance).toBe(140)
  })

  test('references another column', async () => {
    await Account.objects.filter({ owner: 'ada' }).update({ balance: F('id').add(1000) })
    const ada = await Account.objects.get({ owner: 'ada' })
    expect(ada.balance).toBe(ada.id + 1000)
  })

  test('compares two columns in a filter', async () => {
    // ada gets id 1 and balance 0, so balance < id holds only for her.
    await Account.objects.filter({ owner: 'ada' }).update({ balance: 0 })
    const rows = await Account.objects.filter({ balance__lt: F('id') }).orderBy('owner')
    expect(rows.map((row) => row.owner)).toEqual(['ada'])
  })

  test('an unknown field is reported clearly', async () => {
    expect(Account.objects.filter({ owner: 'ada' }).update({ balance: F('nope').add(1) })).rejects.toThrow(
      /has no field "nope"/,
    )
  })

  test('works inside a transaction and rolls back with it', async () => {
    await expect(
      atomic(async () => {
        await Account.objects.filter({ owner: 'ada' }).update({ balance: F('balance').add(500) })
        throw new Error('nope')
      }),
    ).rejects.toThrow()
    expect((await Account.objects.get({ owner: 'ada' })).balance).toBe(100)
  })
})
