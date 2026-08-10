/**
 * The Drizzle bridge.
 *
 * Models describe themselves dialect-agnostically; a column can only be built
 * once we know whether we're talking to SQLite or Postgres, so tables are
 * constructed here at connection time (and by the migration codegen).
 */

import {
  index as pgIndex,
  uniqueIndex as pgUniqueIndex,
  pgTable,
  bigint as pgBigint,
  bigserial,
  boolean as pgBoolean,
  date as pgDate,
  doublePrecision,
  integer as pgInteger,
  jsonb,
  numeric,
  serial,
  smallint,
  text as pgText,
  time as pgTime,
  timestamp as pgTimestamp,
  uuid as pgUuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  index as sqliteIndex,
  uniqueIndex as sqliteUniqueIndex,
  sqliteTable,
  integer as sqliteInteger,
  real as sqliteReal,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core'
import type { FieldSpec } from './fields.ts'
import type { AnyModel, FieldMap } from './model.ts'

export type Dialect = 'sqlite' | 'postgres'

export type TableMap = Record<string, any>

/** Where the FK thunk looks up its target once every table exists. */
interface BuildContext {
  tables: TableMap
  dialect: Dialect
}

// ---------------------------------------------------------------------------
// Column construction
// ---------------------------------------------------------------------------

function sqliteColumn(name: string, spec: FieldSpec): any {
  switch (spec.kind) {
    case 'auto':
    case 'bigAuto':
      return sqliteInteger(name)
    case 'char':
    case 'text':
    case 'email':
    case 'slug':
    case 'url':
    case 'uuid':
    case 'time':
      return sqliteText(name)
    // SQLite has no fixed-point type; text round-trips the exact digits.
    case 'decimal':
      return sqliteText(name)
    case 'integer':
    case 'smallInteger':
    case 'bigInteger':
    case 'foreignKey':
      return sqliteInteger(name)
    case 'float':
      return sqliteReal(name)
    case 'boolean':
      return sqliteInteger(name, { mode: 'boolean' })
    case 'date':
    case 'datetime':
      return sqliteInteger(name, { mode: 'timestamp_ms' })
    case 'json':
      return sqliteText(name, { mode: 'json' })
  }
}

function postgresColumn(name: string, spec: FieldSpec): any {
  switch (spec.kind) {
    case 'auto':
      return serial(name)
    case 'bigAuto':
      return bigserial(name, { mode: 'number' })
    case 'char':
    case 'email':
    case 'slug':
    case 'url':
      return spec.maxLength ? varchar(name, { length: spec.maxLength }) : pgText(name)
    case 'text':
      return pgText(name)
    case 'uuid':
      return pgUuid(name)
    case 'time':
      return pgTime(name)
    case 'decimal':
      return numeric(name, { precision: spec.precision ?? 10, scale: spec.scale ?? 2 })
    case 'integer':
    case 'foreignKey':
      return pgInteger(name)
    case 'smallInteger':
      return smallint(name)
    case 'bigInteger':
      return pgBigint(name, { mode: 'number' })
    case 'float':
      return doublePrecision(name)
    case 'boolean':
      return pgBoolean(name)
    case 'datetime':
      return pgTimestamp(name, { withTimezone: true, mode: 'date' })
    case 'date':
      return pgDate(name, { mode: 'date' })
    case 'json':
      return jsonb(name)
  }
}

function buildColumn(ctx: BuildContext, model: AnyModel, attr: string, spec: FieldSpec): any {
  const name = model.columns[attr]!
  let column = ctx.dialect === 'sqlite' ? sqliteColumn(name, spec) : postgresColumn(name, spec)

  if (spec.primaryKey) {
    // SQLite needs AUTOINCREMENT spelled out; Postgres gets it from serial.
    column =
      ctx.dialect === 'sqlite' && (spec.kind === 'auto' || spec.kind === 'bigAuto')
        ? column.primaryKey({ autoIncrement: true })
        : column.primaryKey()
  }

  if (!spec.null && !spec.primaryKey) column = column.notNull()
  if (spec.unique && !spec.primaryKey) column = column.unique()

  if (spec.hasDefault && spec.default !== undefined && !spec.auto) {
    column = column.default(spec.default)
  }

  if (spec.kind === 'foreignKey') {
    const target = spec.to!()
    column = column.references(() => ctx.tables[target.meta.tableName]![target.columns[target.pk]!], {
      onDelete: spec.onDelete ?? 'cascade',
    })
  }

  return column
}

// ---------------------------------------------------------------------------
// Table construction
// ---------------------------------------------------------------------------

function tableExtras(model: AnyModel, dialect: Dialect) {
  const makeIndex = dialect === 'sqlite' ? sqliteIndex : pgIndex
  const makeUnique = dialect === 'sqlite' ? sqliteUniqueIndex : pgUniqueIndex

  return (columns: Record<string, any>) => {
    const extras: any[] = []

    for (const [attr, field] of Object.entries(model.fields as FieldMap)) {
      // Foreign keys get an index for free — almost every query filters on them.
      if (!field.spec.index && field.spec.kind !== 'foreignKey') continue
      if (field.spec.primaryKey || field.spec.unique) continue
      const column = columns[model.columns[attr]!]
      if (column) extras.push(makeIndex(`${model.meta.tableName}_${model.columns[attr]}_idx`).on(column))
    }

    for (const spec of model.meta.indexes) {
      const cols = spec.fields.map((attr) => columns[model.columns[attr]!]).filter(Boolean)
      if (cols.length !== spec.fields.length) continue
      const name = spec.name ?? `${model.meta.tableName}_${spec.fields.map((a) => model.columns[a]).join('_')}_idx`
      const builder = spec.unique ? makeUnique(name) : makeIndex(name)
      extras.push(builder.on(...(cols as [any, ...any[]])))
    }

    for (const group of model.meta.uniqueTogether) {
      const cols = group.map((attr) => columns[model.columns[attr]!]).filter(Boolean)
      if (cols.length !== group.length) continue
      const name = `${model.meta.tableName}_${group.map((a) => model.columns[a]).join('_')}_uniq`
      extras.push(makeUnique(name).on(...(cols as [any, ...any[]])))
    }

    return extras
  }
}

/**
 * Builds a Drizzle table for every model, keyed by physical table name.
 *
 * Columns are created before any foreign key is resolved, so models may
 * reference each other in a cycle.
 */
export function buildTables(models: AnyModel[], dialect: Dialect): TableMap {
  const tables: TableMap = {}
  const ctx: BuildContext = { tables, dialect }

  for (const model of models) {
    const columns: Record<string, any> = {}
    for (const [attr, field] of Object.entries(model.fields as FieldMap)) {
      columns[model.columns[attr]!] = buildColumn(ctx, model, attr, field.spec)
    }

    // The two table factories have structurally incompatible signatures, so the
    // dialect branch has to be taken at the call site rather than on the value.
    const extras = tableExtras(model, dialect) as any
    const table =
      dialect === 'sqlite'
        ? sqliteTable(model.meta.tableName, columns, extras)
        : pgTable(model.meta.tableName, columns, extras)

    tables[model.meta.tableName] = table
    model.__table = table
  }

  return tables
}

/**
 * The same tables keyed by model name — this is what gets exported to
 * drizzle-kit, which reads the module's exported table objects.
 */
export function buildSchemaExports(models: AnyModel[], dialect: Dialect): TableMap {
  const tables = buildTables(models, dialect)
  const exports: TableMap = {}
  for (const model of models) exports[model.name] = tables[model.meta.tableName]
  return exports
}
