/**
 * ORM-level errors. The HTTP layer maps `DoesNotExist` to 404 and
 * `ValidationError` to 400, so views can let them propagate.
 */

export class DoesNotExist extends Error {
  readonly model: string

  constructor(model: string, criteria?: unknown) {
    const detail = criteria ? ` matching ${JSON.stringify(criteria)}` : ''
    super(`${model} matching query does not exist${detail ? ` (${detail.trim()})` : ''}.`)
    this.name = 'DoesNotExist'
    this.model = model
  }
}

export class MultipleObjectsReturned extends Error {
  readonly model: string
  readonly count: number

  constructor(model: string, count: number) {
    super(`get() returned more than one ${model} — it returned ${count}. Use filter() instead.`)
    this.name = 'MultipleObjectsReturned'
    this.model = model
    this.count = count
  }
}

export class IntegrityError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'IntegrityError'
  }
}

// ---------------------------------------------------------------------------
// Driver errors
// ---------------------------------------------------------------------------

export type IntegrityKind = 'unique' | 'foreign-key' | 'not-null' | 'check' | 'unknown'

/**
 * SQLSTATE codes for the integrity classes, which Postgres reports exactly.
 *
 * Far better evidence than message text: they are standardised, stable across
 * versions, and unaffected by the server's locale.
 */
const SQLSTATE: Record<string, IntegrityKind> = {
  '23505': 'unique',
  '23503': 'foreign-key',
  '23502': 'not-null',
  '23514': 'check',
}

/**
 * Walks an error and everything that caused it.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError` whose message is the
 * SQL rather than the failure, so the real error is one or more `cause` links
 * down. Reading only the top-level message finds nothing, which is precisely
 * what happened here until the suite was pointed at a real Postgres.
 */
function* chain(error: unknown): Generator<unknown> {
  let current = error
  // Bounded: a cause cycle would otherwise hang the request it was raised in.
  for (let depth = 0; current && depth < 8; depth++) {
    yield current
    current = (current as { cause?: unknown }).cause
  }
}

/**
 * Classifies a driver error.
 *
 * Every one of these is caused by the *data* — a duplicate email, a reference
 * to a row that does not exist, a missing required value — so they are the
 * caller's to fix, not a server fault. Reporting them as 500 both misleads the
 * caller and buries a real 500 in the noise.
 *
 * SQLSTATE first, since Postgres reports it precisely. SQLite has no such code,
 * so its messages are matched instead — narrowly enough not to catch anything
 * that is genuinely a server fault.
 */
export function classifyIntegrityError(error: unknown): IntegrityKind | null {
  for (const link of chain(error)) {
    // Bun's SQL driver puts SQLSTATE on `errno`; other drivers use `code`.
    const candidate = link as { errno?: unknown; code?: unknown; message?: unknown }
    const state = String(candidate.errno ?? candidate.code ?? '')
    if (SQLSTATE[state]) return SQLSTATE[state]!

    const message = typeof candidate.message === 'string' ? candidate.message : ''
    if (!message) continue

    if (/UNIQUE constraint failed|duplicate key value|violates unique constraint/i.test(message)) return 'unique'
    if (/FOREIGN KEY constraint failed|violates foreign key constraint/i.test(message)) return 'foreign-key'
    if (/NOT NULL constraint failed|violates not-null constraint|null value in column/i.test(message)) {
      return 'not-null'
    }
    if (/CHECK constraint failed|violates check constraint/i.test(message)) return 'check'
  }

  return null
}

/** The column a constraint error names, when the driver includes one. */
export function constraintField(error: unknown): string | null {
  for (const link of chain(error)) {
    const candidate = link as { detail?: unknown; message?: unknown }

    // Postgres: detail is `Key (email)=(a@b.c) already exists.`
    if (typeof candidate.detail === 'string') {
      const key = /Key \(([^)]+)\)/i.exec(candidate.detail)
      if (key) return key[1]!.split(',')[0]!.trim()
    }

    const message = typeof candidate.message === 'string' ? candidate.message : ''
    if (!message) continue

    // SQLite names them as table.column.
    const sqlite = /constraint failed: \S+\.(\w+)/i.exec(message)
    if (sqlite) return sqlite[1]!

    // Postgres puts the column in quotes for a not-null violation.
    const postgres = /column "([^"]+)"/i.exec(message)
    if (postgres) return postgres[1]!
  }

  return null
}
