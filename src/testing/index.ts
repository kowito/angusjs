/**
 * Testing utilities.
 *
 * A framework that derives five interfaces from one declaration needs its
 * contract tests to be cheap to write, or they don't get written. These are the
 * three things every Angus test needs: a database that resets, a client that
 * speaks HTTP without a port, and factories that fill in the fields the test
 * doesn't care about.
 */

import type { Elysia } from 'elysia'
import { createApp } from '../core/project.ts'
import type { Settings } from '../core/settings.ts'
import { connect, disconnect, getConnection, type Connection, type DatabaseConfig } from '../db/connection.ts'
import type { AnyModel, FieldMap, InsertOf, RowOf } from '../db/model.ts'
import { buildTables } from '../db/schema.ts'
import { atomic, Rollback } from '../db/transaction.ts'

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export interface TestDatabaseOptions {
  models: AnyModel[]
  /** Defaults to an in-memory SQLite database. */
  database?: DatabaseConfig
  /**
   * Extra SQL to run after the tables are created — seed data, or a view.
   */
  setup?: string
}

export interface TestDatabase {
  connection: Connection
  /** Deletes every row and resets auto-increment counters. */
  reset(): Promise<void>
  close(): Promise<void>
}

/**
 * Opens an isolated database and creates the tables for `models` directly from
 * their definitions — no migration files, so a test never depends on migration
 * state that has drifted.
 */
export async function testDatabase(options: TestDatabaseOptions): Promise<TestDatabase> {
  const config = options.database ?? { dialect: 'sqlite' as const, url: ':memory:' }
  const connection = await connect(config, options.models)

  await createTables(connection, options.models)
  if (options.setup) await runScript(connection, options.setup)

  return {
    connection,
    async reset() {
      await truncate(connection, options.models)
      if (options.setup) await runScript(connection, options.setup)
    },
    async close() {
      await disconnect()
    },
  }
}

async function runScript(connection: Connection, sqlText: string): Promise<void> {
  if (connection.dialect === 'sqlite') connection.client.exec(sqlText)
  else await connection.client.unsafe(sqlText)
}

/**
 * Emits `CREATE TABLE` from the model definitions.
 *
 * Deliberately minimal: column types, nullability, defaults, primary keys and
 * uniqueness — enough for the queries a test runs. Foreign keys are declared so
 * cascade behaviour is testable; check constraints and indexes are not, since
 * they don't change query results.
 */
async function createTables(connection: Connection, models: AnyModel[]): Promise<void> {
  const sqlite = connection.dialect === 'sqlite'

  // Referenced tables must exist first, so models are emitted dependency-first.
  for (const model of order(models)) {
    const columns: string[] = []

    for (const [attr, field] of Object.entries(model.fields as FieldMap)) {
      const spec = field.spec
      const name = model.columns[attr]!
      const parts = [quote(name), columnType(spec.kind, sqlite, spec)]

      if (spec.primaryKey) {
        parts.push(sqlite ? 'PRIMARY KEY AUTOINCREMENT' : 'PRIMARY KEY')
      } else {
        if (!spec.null) parts.push('NOT NULL')
        if (spec.unique) parts.push('UNIQUE')
        if (spec.hasDefault && spec.default !== undefined && typeof spec.default !== 'function') {
          parts.push(`DEFAULT ${literal(spec.default)}`)
        }
      }

      if (spec.kind === 'foreignKey') {
        const target = spec.to!()
        parts.push(
          `REFERENCES ${quote(target.meta.tableName)}(${quote(target.columns[target.pk]!)})` +
            ` ON DELETE ${(spec.onDelete ?? 'cascade').toUpperCase()}`,
        )
      }

      columns.push(parts.join(' '))
    }

    for (const group of model.meta.uniqueTogether) {
      columns.push(`UNIQUE (${group.map((attr) => quote(model.columns[attr]!)).join(', ')})`)
    }

    await runScript(connection, `CREATE TABLE IF NOT EXISTS ${quote(model.meta.tableName)} (\n  ${columns.join(',\n  ')}\n);`)
  }
}

/** Topological order by foreign key, so a referenced table is created first. */
function order(models: AnyModel[]): AnyModel[] {
  const done = new Set<string>()
  const result: AnyModel[] = []

  const visit = (model: AnyModel, seen: Set<string>) => {
    if (done.has(model.name) || seen.has(model.name)) return
    seen.add(model.name)

    for (const field of Object.values(model.fields as FieldMap)) {
      if (field.spec.kind !== 'foreignKey') continue
      const target = field.spec.to!()
      // Self-references and cycles fall through; SQLite tolerates a forward
      // reference inside CREATE TABLE.
      if (target.name !== model.name && models.some((m) => m.name === target.name)) visit(target, seen)
    }

    done.add(model.name)
    result.push(model)
  }

  for (const model of models) visit(model, new Set())
  return result
}

function columnType(kind: string, sqlite: boolean, spec: { maxLength?: number }): string {
  if (sqlite) {
    switch (kind) {
      case 'auto':
      case 'bigAuto':
      case 'integer':
      case 'smallInteger':
      case 'bigInteger':
      case 'foreignKey':
      case 'boolean':
      case 'date':
      case 'datetime':
        return 'INTEGER'
      case 'float':
        return 'REAL'
      default:
        return 'TEXT'
    }
  }

  switch (kind) {
    case 'auto':
      return 'SERIAL'
    case 'bigAuto':
      return 'BIGSERIAL'
    case 'integer':
    case 'foreignKey':
      return 'INTEGER'
    case 'smallInteger':
      return 'SMALLINT'
    case 'bigInteger':
      return 'BIGINT'
    case 'float':
      return 'DOUBLE PRECISION'
    case 'boolean':
      return 'BOOLEAN'
    case 'date':
      return 'DATE'
    case 'datetime':
      return 'TIMESTAMPTZ'
    case 'time':
      return 'TIME'
    case 'json':
      return 'JSONB'
    case 'uuid':
      return 'UUID'
    case 'decimal':
      return 'NUMERIC'
    case 'char':
    case 'email':
    case 'slug':
    case 'url':
      return spec.maxLength ? `VARCHAR(${spec.maxLength})` : 'TEXT'
    default:
      return 'TEXT'
  }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

function literal(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return `'${String(value).replace(/'/g, "''")}'`
}

async function truncate(connection: Connection, models: AnyModel[]): Promise<void> {
  const tables = order(models).map((model) => model.meta.tableName).reverse()

  if (connection.dialect === 'sqlite') {
    connection.client.exec(
      tables.map((table) => `DELETE FROM ${quote(table)};`).join('\n') +
        `\nDELETE FROM sqlite_sequence WHERE name IN (${tables.map((t) => `'${t}'`).join(', ')});`,
    )
    return
  }

  await runScript(connection, `TRUNCATE ${tables.map(quote).join(', ')} RESTART IDENTITY CASCADE;`)
}

// ---------------------------------------------------------------------------
// Transactional test cases
// ---------------------------------------------------------------------------

/**
 * Runs `fn` inside a transaction that is always rolled back, so a test leaves
 * the database exactly as it found it. Much faster than truncating between
 * cases, and it keeps tests independent without a `beforeEach`.
 *
 * ```ts
 * test('charges the card', () => transactional(async () => {
 *   await Order.objects.create({ ... })
 * }))
 * ```
 */
export async function transactional<T>(fn: () => Promise<T> | T): Promise<T> {
  let captured: T
  try {
    await atomic(async () => {
      captured = await fn()
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  return captured!
}

// ---------------------------------------------------------------------------
// Test client
// ---------------------------------------------------------------------------

export interface TestResponse<T = any> {
  status: number
  headers: Headers
  body: T
  text: string
  ok: boolean
}

export interface TestClientOptions {
  /** Prepended to every path, so tests can omit the API prefix. */
  basePath?: string
  /** Sent with every request — an auth token, a tenant header. */
  headers?: Record<string, string>
  origin?: string
}

/**
 * Drives an Elysia app through `app.handle()`: real routing, real validation,
 * real serialization, no port and no network.
 */
export class TestClient {
  constructor(
    private readonly app: Elysia<any, any>,
    private readonly options: TestClientOptions = {},
  ) {}

  /** A client that sends additional headers on every request. */
  with(headers: Record<string, string>): TestClient {
    return new TestClient(this.app, { ...this.options, headers: { ...this.options.headers, ...headers } })
  }

  /** Shorthand for `with({ authorization: ... })`. */
  as(token: string): TestClient {
    return this.with({ authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` })
  }

  async request<T = any>(method: string, path: string, init: RequestInit = {}): Promise<TestResponse<T>> {
    const origin = this.options.origin ?? 'http://test'
    const url = `${origin}${this.options.basePath ?? ''}${path}`

    const response = await this.app.handle(
      new Request(url, {
        ...init,
        method,
        headers: { ...this.options.headers, ...((init.headers ?? {}) as Record<string, string>) },
      }),
    )

    const text = await response.text()
    let body: unknown = undefined
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      body: body as T,
      text,
      ok: response.status >= 200 && response.status < 300,
    }
  }

  get<T = any>(path: string, init?: RequestInit) {
    return this.request<T>('GET', path, init)
  }

  delete<T = any>(path: string, init?: RequestInit) {
    return this.request<T>('DELETE', path, init)
  }

  post<T = any>(path: string, body?: unknown, init?: RequestInit) {
    return this.json<T>('POST', path, body, init)
  }

  put<T = any>(path: string, body?: unknown, init?: RequestInit) {
    return this.json<T>('PUT', path, body, init)
  }

  patch<T = any>(path: string, body?: unknown, init?: RequestInit) {
    return this.json<T>('PATCH', path, body, init)
  }

  /** Submits a urlencoded form, the way a browser posts an admin page. */
  form<T = any>(path: string, fields: Record<string, string>, init: RequestInit = {}) {
    return this.request<T>('POST', path, {
      ...init,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: this.options.origin ?? 'http://test',
        'sec-fetch-site': 'same-origin',
        ...((init.headers ?? {}) as Record<string, string>),
      },
      body: new URLSearchParams(fields).toString(),
    })
  }

  private json<T>(method: string, path: string, body: unknown, init: RequestInit = {}) {
    return this.request<T>(method, path, {
      ...init,
      headers: { 'content-type': 'application/json', ...((init.headers ?? {}) as Record<string, string>) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
}

/** Builds the project's app and wraps it in a test client. */
export async function testClient(settings: Settings, options: TestClientOptions = {}): Promise<TestClient> {
  const app = await createApp(settings, { connectDatabase: false })
  return new TestClient(app, options)
}

/** Wraps an app you built yourself. */
export function clientFor(app: Elysia<any, any>, options: TestClientOptions = {}): TestClient {
  return new TestClient(app, options)
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let sequence = 0

/** A monotonically increasing number, for generating unique values. */
export function nextSequence(): number {
  return ++sequence
}

export type FactoryDefaults<M extends AnyModel> =
  | Partial<InsertOf<M>>
  | ((index: number) => Partial<InsertOf<M>>)

export interface Factory<M extends AnyModel> {
  /** Builds the attributes without touching the database. */
  attributes(overrides?: Partial<InsertOf<M>>): InsertOf<M>
  create(overrides?: Partial<InsertOf<M>>): Promise<RowOf<M>>
  createMany(count: number, overrides?: Partial<InsertOf<M>> | ((index: number) => Partial<InsertOf<M>>)): Promise<RowOf<M>[]>
}

/**
 * A factory fills in whatever a test doesn't care about, so a test that is
 * about one field mentions only that field.
 *
 * ```ts
 * const users = factory(User, (n) => ({ email: `user${n}@example.com`, name: `User ${n}` }))
 * const admin = await users.create({ isStaff: true })
 * ```
 */
export function factory<M extends AnyModel>(model: M, defaults: FactoryDefaults<M> = {}): Factory<M> {
  const resolve = (index: number): Partial<InsertOf<M>> =>
    typeof defaults === 'function' ? defaults(index) : { ...defaults }

  return {
    attributes(overrides = {}) {
      return { ...resolve(nextSequence()), ...overrides } as InsertOf<M>
    },
    async create(overrides = {}) {
      return model.objects.create({ ...resolve(nextSequence()), ...overrides } as InsertOf<M>) as Promise<RowOf<M>>
    },
    async createMany(count, overrides = {}) {
      const rows: RowOf<M>[] = []
      for (let index = 0; index < count; index++) {
        const extra = typeof overrides === 'function' ? overrides(index) : overrides
        rows.push((await model.objects.create({ ...resolve(nextSequence()), ...extra } as InsertOf<M>)) as RowOf<M>)
      }
      return rows
    },
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Counts the queries a block issues, for asserting the absence of an N+1. */
export async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
  const connection = getConnection()
  let count = 0

  const original = connection.db.constructor.prototype
  // Drizzle exposes the logger it was constructed with; swapping it is the
  // least invasive way to observe queries without wrapping every method.
  const previousLogger = (connection.db as any).logger
  ;(connection.db as any).logger = {
    logQuery() {
      count++
    },
  }
  void original

  try {
    const result = await fn()
    return { result, count }
  } finally {
    ;(connection.db as any).logger = previousLogger
  }
}

export { buildTables }
