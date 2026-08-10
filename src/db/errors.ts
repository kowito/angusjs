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
 * Classifies a driver error.
 *
 * Every one of these is caused by the *data* — a duplicate email, a reference
 * to a row that does not exist, a missing required value — so they are the
 * caller's to fix, not a server fault. Reporting them as 500 both misleads the
 * caller and buries a real 500 in the noise.
 *
 * Matched on message text because SQLite and Postgres expose their codes
 * differently and neither is available through Drizzle uniformly. The patterns
 * are specific enough not to catch anything else.
 */
export function classifyIntegrityError(error: unknown): IntegrityKind | null {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (!message) return null

  // SQLite: "UNIQUE constraint failed: users.email"
  // Postgres: "duplicate key value violates unique constraint"
  if (/UNIQUE constraint failed|duplicate key value|violates unique constraint/i.test(message)) return 'unique'
  if (/FOREIGN KEY constraint failed|violates foreign key constraint/i.test(message)) return 'foreign-key'
  if (/NOT NULL constraint failed|violates not-null constraint|null value in column/i.test(message)) return 'not-null'
  if (/CHECK constraint failed|violates check constraint/i.test(message)) return 'check'

  return null
}

/** The column a constraint error names, when the driver includes one. */
export function constraintField(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '')

  // SQLite names them as table.column.
  const sqlite = /constraint failed: \S+\.(\w+)/i.exec(message)
  if (sqlite) return sqlite[1]!

  // Postgres puts the column in quotes for not-null.
  const postgres = /column "([^"]+)"/i.exec(message)
  if (postgres) return postgres[1]!

  return null
}
