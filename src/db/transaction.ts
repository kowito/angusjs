/**
 * Transactions.
 *
 * `atomic()` makes every query inside it — including ones several call frames
 * deep, inside a service or a model hook — run on the same transaction, without
 * threading a handle through every signature. That ambient scoping is what lets
 * `Post.objects.create()` participate in a transaction it knows nothing about.
 *
 * The two dialects need genuinely different implementations:
 *
 * - **Postgres** uses the driver's own `transaction()`, because the connection
 *   is pooled: issuing `BEGIN` as a bare statement could reserve one connection
 *   and run the following queries on another.
 *
 * - **SQLite** issues `BEGIN` / `COMMIT` / `ROLLBACK` directly, because
 *   Drizzle's `bun-sqlite` driver is synchronous and **does not roll back when
 *   the callback is async** — it commits before the awaited work finishes. That
 *   silent non-rollback is worse than having no transactions at all, so this
 *   path deliberately does not use it. A single SQLite connection means there is
 *   no pool to worry about.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { getConnection, type Connection } from './connection.ts'

interface TransactionScope {
  /** The handle queries must run on: a Drizzle tx for Postgres, the db for SQLite. */
  db: any
  /** 0 for the outermost transaction; deeper values become savepoints. */
  depth: number
}

const scope = new AsyncLocalStorage<TransactionScope>()

/**
 * The handle a query should use right now — the ambient transaction if one is
 * open, otherwise the connection's own.
 */
export function activeDb(connection: Connection): any {
  return scope.getStore()?.db ?? connection.db
}

/** True when the caller is inside an `atomic()` block. */
export function inTransaction(): boolean {
  return scope.getStore() !== undefined
}

/**
 * On SQLite, transactions live on the single shared connection, so a
 * transaction opened by one request is physically open for every other. Two
 * guarantees make that safe:
 *
 *   1. Only one `atomic()` block runs at a time (the mutex below), so a second
 *      overlapping transaction never issues a nested `BEGIN` — which SQLite
 *      rejects outright — and two transactions can never interleave writes.
 *   2. A query issued *outside* any transaction waits while one is open, so it
 *      cannot be swept into a transaction it knows nothing about and discarded
 *      when that transaction rolls back.
 *
 * `held` maps a connection to the promise that resolves when its current
 * transaction finishes; absent means none is open.
 */
const held = new WeakMap<Connection, Promise<void>>()

/**
 * Awaited by every non-transactional query before it touches SQLite, so it runs
 * only when no transaction is open. A no-op on Postgres (pooled connections
 * isolate transactions already) and for the transaction's own queries, which
 * must not wait on the lock they hold.
 */
export async function transactionGate(connection: Connection): Promise<void> {
  if (connection.dialect !== 'sqlite' || inTransaction()) return
  const current = held.get(connection)
  if (current) await current
}

/**
 * Waits for any in-progress transaction on this connection, then claims the
 * lock. The check-and-set is synchronous, so two callers cannot both see it
 * free; waiters wake in FIFO order and re-check.
 */
async function acquireTransaction(connection: Connection): Promise<() => void> {
  let current: Promise<void> | undefined
  while ((current = held.get(connection))) await current

  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = () => {
      held.delete(connection)
      resolve()
    }
  })
  held.set(connection, done)
  return release
}

export interface AtomicOptions {
  connection?: Connection
}

/**
 * Runs `fn` in a transaction, committing when it resolves and rolling back if it
 * throws. Nested calls become savepoints, so an inner failure can be caught
 * without discarding the outer transaction.
 *
 * ```ts
 * await atomic(async () => {
 *   const order = await Order.objects.create({ ... })
 *   await Stock.objects.filter({ id: order.stockId }).update({ count: F('count').sub(1) })
 * })
 * ```
 */
export async function atomic<T>(fn: () => Promise<T> | T, options: AtomicOptions = {}): Promise<T> {
  const connection = options.connection ?? getConnection()
  return connection.dialect === 'sqlite' ? sqliteAtomic(connection, fn) : postgresAtomic(connection, fn)
}

async function sqliteAtomic<T>(connection: Connection, fn: () => Promise<T> | T): Promise<T> {
  const parent = scope.getStore()

  // A nested block is a savepoint inside the parent's transaction. The parent
  // already holds the lock, so it neither acquires it again nor issues `BEGIN`.
  if (parent) {
    const depth = parent.depth + 1
    const savepoint = `angus_sp_${depth}`
    const client = connection.client
    client.exec(`SAVEPOINT ${savepoint}`)
    try {
      const result = await scope.run({ db: connection.db, depth }, async () => fn())
      client.exec(`RELEASE ${savepoint}`)
      return result
    } catch (error) {
      client.exec(`ROLLBACK TO ${savepoint}`)
      client.exec(`RELEASE ${savepoint}`)
      throw error
    }
  }

  // Outermost block: take the connection's transaction lock for its whole
  // duration, so no other transaction overlaps and no stray query is captured.
  const release = await acquireTransaction(connection)
  const client = connection.client
  client.exec('BEGIN')
  try {
    const result = await scope.run({ db: connection.db, depth: 0 }, async () => fn())
    client.exec('COMMIT')
    return result
  } catch (error) {
    client.exec('ROLLBACK')
    throw error
  } finally {
    release()
  }
}

async function postgresAtomic<T>(connection: Connection, fn: () => Promise<T> | T): Promise<T> {
  const parent = scope.getStore()
  const runner = parent?.db ?? connection.db
  const depth = parent ? parent.depth + 1 : 0

  // Drizzle turns a nested `transaction()` into a savepoint for us.
  return runner.transaction(async (tx: any) => scope.run({ db: tx, depth }, async () => fn()))
}

/**
 * Marks the current transaction for rollback by throwing. Useful when the work
 * succeeded but should not be kept — a dry run, or a test case.
 */
export class Rollback extends Error {
  constructor(message = 'Transaction rolled back deliberately.') {
    super(message)
    this.name = 'Rollback'
  }
}

/**
 * Runs `fn` in a transaction that is always rolled back. The value `fn` returns
 * is still passed through, which is what makes it useful for tests.
 */
export async function rollbackAfter<T>(fn: () => Promise<T> | T, options: AtomicOptions = {}): Promise<T> {
  let captured: T
  try {
    await atomic(async () => {
      captured = await fn()
      throw new Rollback()
    }, options)
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  return captured!
}
