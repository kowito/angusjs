/**
 * The database connection.
 *
 * Held in a module-level slot so `Post.objects.filter(...)` works without
 * threading a handle through every call — the same trade Django makes with
 * `settings.DATABASES`. Tests can swap it out with `setConnection`.
 */

import { registeredModels, type AnyModel } from './model.ts'
import { buildTables, type Dialect, type TableMap } from './schema.ts'

export interface DatabaseConfig {
  /**
   * SQLite or Postgres.
   *
   * MySQL is deliberately unsupported: every write uses `RETURNING` so
   * `create()` and `update()` give back the row as stored. Drizzle's MySQL
   * driver has none, and the follow-up `SELECT` that would replace it is a
   * second round trip that is not atomic with the write — under concurrent
   * updates it can return another transaction's version of the row.
   */
  dialect: Dialect
  /**
   * SQLite: a file path or `:memory:`.
   * Postgres: a `postgres://` URL.
   */
  url: string
  /** Echo every statement to stdout. */
  logging?: boolean
  /** SQLite only — write-ahead logging, on by default for file databases. */
  wal?: boolean
  /** Postgres only — maximum pool size. */
  max?: number
}

export interface Connection {
  readonly db: any
  readonly dialect: Dialect
  readonly config: DatabaseConfig
  readonly tables: TableMap
  /** The raw driver handle, for the rare thing Drizzle can't express. */
  readonly client: any
  table(model: AnyModel): Record<string, any>
  close(): Promise<void>
}

let active: Connection | undefined

/**
 * Opens a connection and builds the Drizzle schema for every registered model.
 *
 * Import your models before calling this — a model that hasn't been imported
 * isn't registered, and so has no table.
 */
export async function connect(config: DatabaseConfig, models: AnyModel[] = registeredModels()): Promise<Connection> {
  const tables = buildTables(models, config.dialect)
  const { db, client } = await createDriver(config, tables)

  const byModel = new WeakMap<AnyModel, Record<string, any>>()
  for (const model of models) byModel.set(model, tables[model.meta.tableName]!)

  const connection: Connection = {
    db,
    client,
    config,
    dialect: config.dialect,
    tables,
    table(model) {
      const table = byModel.get(model) ?? tables[model.meta.tableName]
      if (!table) {
        throw new Error(
          `Model "${model.name}" has no table on the active connection. ` +
            `It was probably imported after connect() ran — make sure your app's models are ` +
            `imported from its module before the database is opened.`,
        )
      }
      return table
    },
    async close() {
      if (active === connection) active = undefined
      await client?.close?.()
      await client?.end?.()
    },
  }

  active = connection
  return connection
}

async function createDriver(config: DatabaseConfig, tables: TableMap): Promise<{ db: any; client: any }> {
  const logger = config.logging ?? false

  if (config.dialect === 'sqlite') {
    const { Database } = await import('bun:sqlite')
    const client = new Database(config.url)
    client.exec('PRAGMA foreign_keys = ON')
    if (config.wal !== false && config.url !== ':memory:') client.exec('PRAGMA journal_mode = WAL')
    const { drizzle } = await import('drizzle-orm/bun-sqlite')
    return { db: drizzle(client, { schema: tables, logger }), client }
  }

  const { SQL } = await import('bun')
  const client = new SQL({ url: config.url, max: config.max })
  const { drizzle } = await import('drizzle-orm/bun-sql')
  return { db: drizzle(client, { schema: tables, logger }), client }
}

/** The active connection, or a clear error explaining how to open one. */
export function getConnection(): Connection {
  if (!active) {
    throw new Error(
      'No database connection. Call connect({ dialect, url }) during startup, or set ' +
        '`database` in your angus.config.ts so `angus runserver` opens it for you.',
    )
  }
  return active
}

export function hasConnection(): boolean {
  return active !== undefined
}

/** Replaces the active connection. Mainly for tests. */
export function setConnection(connection: Connection | undefined): void {
  active = connection
}

export async function disconnect(): Promise<void> {
  await active?.close()
  active = undefined
}
