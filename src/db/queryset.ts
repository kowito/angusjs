/**
 * QuerySets.
 *
 * Lazy and immutable, like Django's: every chaining method returns a new
 * QuerySet and nothing touches the database until the object is awaited or a
 * terminal method (`count`, `first`, `delete`, ...) is called.
 */

import { asc, avg, count as countAgg, desc, eq, max as maxAgg, min as minAgg, sum, type SQL } from 'drizzle-orm'
import { getConnection, type Connection } from './connection.ts'
import { isFExpression } from './expressions.ts'
import { activeDb } from './transaction.ts'
import { attachPrefetches, resolvePrefetch, type PrefetchMap, type PrefetchResult, type ResolvedPrefetch } from './prefetch.ts'
import { DoesNotExist, MultipleObjectsReturned } from './errors.ts'
import { buildCondition, combine, Q, type Filter, type OrderBy, type QCondition, type ResolveContext } from './lookups.ts'
import type { AnyModel, FieldMap, InsertOf, RowOf, UpdateOf } from './model.ts'

type Condition<M extends AnyModel> = Filter<M['fields']> | Q<M['fields']>

interface QueryState {
  filters: QCondition[]
  excludes: QCondition[]
  ordering: string[]
  limit?: number
  offset?: number
  distinct: boolean
  /** Attribute subset requested via `values()`/`only()`. */
  fields?: string[]
  selectRelated: string[]
  prefetch: ResolvedPrefetch[]
}

/** Sentinel meaning "explicitly no ordering", distinct from "none specified". */
const NO_ORDERING = '\0none'

const EMPTY: QueryState = {
  filters: [],
  excludes: [],
  ordering: [],
  distinct: false,
  selectRelated: [],
  prefetch: [],
}

/** `author` -> `authorId`, matching the row shape. */
function rowKey(model: AnyModel, attr: string): string {
  return model.fields[attr]!.spec.kind === 'foreignKey' ? `${attr}Id` : attr
}

/** The inverse: accepts `authorId` or `author` and returns the field attribute. */
function attrFor(model: AnyModel, key: string): string {
  if (key in model.fields) return key
  const stripped = key.endsWith('Id') ? key.slice(0, -2) : undefined
  if (stripped && model.fields[stripped]?.spec.kind === 'foreignKey') return stripped
  throw new Error(
    `Model "${model.name}" has no field "${key}". Available: ${Object.keys(model.fields).join(', ')}.`,
  )
}

/**
 * `R` is the shape a row comes back as. It starts as the model's full row and
 * is narrowed by `values()` or widened by `selectRelated()`, so the awaited
 * type always matches what was actually selected.
 */
export class QuerySet<M extends AnyModel, R = RowOf<M>> implements PromiseLike<R[]> {
  constructor(
    readonly model: M,
    private readonly state: QueryState = EMPTY,
  ) {}

  private derive(patch: Partial<QueryState>): QuerySet<M, R> {
    return new QuerySet(this.model, { ...this.state, ...patch })
  }

  private deriveAs<R2>(patch: Partial<QueryState>): QuerySet<M, R2> {
    return new QuerySet<M, R2>(this.model, { ...this.state, ...patch })
  }

  // -------------------------------------------------------------------------
  // Chaining
  // -------------------------------------------------------------------------

  /** Narrows the result set. Multiple conditions are ANDed. */
  filter(...conditions: Condition<M>[]): QuerySet<M, R> {
    return this.derive({ filters: [...this.state.filters, ...(conditions as QCondition[])] })
  }

  /** Removes matching rows from the result set. */
  exclude(...conditions: Condition<M>[]): QuerySet<M, R> {
    return this.derive({ excludes: [...this.state.excludes, ...(conditions as QCondition[])] })
  }

  /** `orderBy('-createdAt', 'title')`. A leading `-` means descending. */
  orderBy(...fields: OrderBy<M['fields']>[]): QuerySet<M, R> {
    return this.derive({ ordering: fields as string[] })
  }

  /** Drops any ordering, including the model's default. */
  unordered(): QuerySet<M, R> {
    return this.derive({ ordering: [NO_ORDERING] })
  }

  /** Reverses the current ordering. */
  reverse(): QuerySet<M, R> {
    const ordering = this.effectiveOrdering().map((field) =>
      field.startsWith('-') ? field.slice(1) : `-${field}`,
    )
    return this.derive({ ordering: ordering.length > 0 ? ordering : [NO_ORDERING] })
  }

  limit(value: number): QuerySet<M, R> {
    return this.derive({ limit: value })
  }

  offset(value: number): QuerySet<M, R> {
    return this.derive({ offset: value })
  }

  /** Django's `qs[start:stop]`. */
  slice(start: number, stop?: number): QuerySet<M, R> {
    return this.derive({ offset: start, limit: stop === undefined ? this.state.limit : stop - start })
  }

  distinct(): QuerySet<M, R> {
    return this.derive({ distinct: true })
  }

  /** Returns plain objects containing only the named fields. */
  values<K extends keyof R & string>(...fields: K[]): QuerySet<M, Pick<R, K>> {
    return this.deriveAs<Pick<R, K>>({ fields: fields.map((key) => attrFor(this.model, key)) })
  }

  /** Same as `values()`, but keeps the full row type — a SELECT optimisation. */
  only<K extends keyof R & string>(...fields: K[]): QuerySet<M, R> {
    const attrs = fields.map((key) => attrFor(this.model, key))
    // The primary key always comes along; without it rows can't be updated.
    if (!attrs.includes(this.model.pk)) attrs.unshift(this.model.pk)
    return this.derive({ fields: attrs })
  }

  /**
   * Joins the named foreign keys and nests the related row under the relation
   * attribute, so `post.author.name` is available without a second query.
   */
  selectRelated<K extends RelationNames<M>>(...relations: K[]): QuerySet<M, R & WithRelations<M, K>> {
    for (const relation of relations) {
      const field = this.model.fields[relation as string]
      if (field?.spec.kind !== 'foreignKey') {
        throw new Error(`selectRelated("${String(relation)}"): not a foreign key on "${this.model.name}".`)
      }
    }
    return this.deriveAs<R & WithRelations<M, K>>({
      selectRelated: [...this.state.selectRelated, ...(relations as string[])],
    })
  }

  /**
   * Fetches a reverse relation in one extra query rather than one per row.
   *
   * `selectRelated` joins the many-to-one direction; this covers one-to-many,
   * where a join would multiply the parent row and break `limit`.
   *
   * ```ts
   * const authors = await Author.objects.prefetch({ posts: Post })
   * authors[0].posts        // PostRow[], no second round trip
   * ```
   *
   * The related model is named explicitly, which keeps the result typed and
   * keeps the extra query visible at the call site.
   */
  prefetch<const Spec extends PrefetchMap>(spec: Spec): QuerySet<M, R & PrefetchResult<Spec>> {
    const resolved = Object.entries(spec).map(([key, entry]) => resolvePrefetch(this.model, key, entry))
    return this.deriveAs<R & PrefetchResult<Spec>>({ prefetch: [...this.state.prefetch, ...resolved] })
  }

  // -------------------------------------------------------------------------
  // Compilation
  // -------------------------------------------------------------------------

  private context(connection: Connection): ResolveContext {
    return {
      db: activeDb(connection),
      dialect: connection.dialect,
      table: (model) => connection.table(model),
    }
  }

  private effectiveOrdering(): string[] {
    if (this.state.ordering.length > 0) {
      return this.state.ordering[0] === NO_ORDERING ? [] : this.state.ordering
    }
    return this.model.meta.ordering
  }

  /** The WHERE clause for this queryset, or undefined when unfiltered. */
  private where(ctx: ResolveContext): SQL | undefined {
    const includes = this.state.filters.map((condition) => buildCondition(ctx, this.model, condition))
    const excludes = this.state.excludes.map((condition) =>
      buildCondition(ctx, this.model, Q.not(condition as never)),
    )
    return combine([...includes, ...excludes])
  }

  /** Every column of the model, ignoring any `values()` narrowing. */
  private fullSelection(connection: Connection): Record<string, any> {
    const table = connection.table(this.model)
    const selection: Record<string, any> = {}
    for (const attr of Object.keys(this.model.fields)) {
      selection[rowKey(this.model, attr)] = table[this.model.columns[attr]!]
    }
    return selection
  }

  /** The `{ jsKey: column }` map handed to Drizzle's `select()`. */
  private selection(connection: Connection): Record<string, any> {
    const table = connection.table(this.model)
    const attrs = this.state.fields ?? Object.keys(this.model.fields)
    const selection: Record<string, any> = {}

    for (const attr of attrs) {
      selection[rowKey(this.model, attr)] = table[this.model.columns[attr]!]
    }

    for (const relation of this.state.selectRelated) {
      const target = this.model.fields[relation]!.spec.to!()
      const targetTable = connection.table(target)
      const nested: Record<string, any> = {}
      for (const attr of Object.keys(target.fields)) {
        nested[rowKey(target, attr)] = targetTable[target.columns[attr]!]
      }
      selection[relation] = nested
    }

    return selection
  }

  private compile(connection: Connection) {
    const ctx = this.context(connection)
    const table = connection.table(this.model)

    let query = activeDb(connection).select(this.selection(connection)).from(table).$dynamic()

    for (const relation of this.state.selectRelated) {
      const target = this.model.fields[relation]!.spec.to!()
      const targetTable = connection.table(target)
      const nullable = this.model.fields[relation]!.spec.null
      const on = eq(table[this.model.columns[relation]!], targetTable[target.columns[target.pk]!])
      query = nullable ? query.leftJoin(targetTable, on) : query.innerJoin(targetTable, on)
    }

    const where = this.where(ctx)
    if (where) query = query.where(where)

    const ordering = this.effectiveOrdering()
    if (ordering.length > 0) {
      query = query.orderBy(
        ...ordering.map((field) => {
          const descending = field.startsWith('-')
          const attr = attrFor(this.model, descending ? field.slice(1) : field)
          const column = table[this.model.columns[attr]!]
          return descending ? desc(column) : asc(column)
        }),
      )
    }

    if (this.state.limit !== undefined) query = query.limit(this.state.limit)
    if (this.state.offset !== undefined) query = query.offset(this.state.offset)

    return query
  }

  /** The SQL this queryset would run. Handy in tests and for debugging. */
  toSQL(): { sql: string; params: unknown[] } {
    const compiled = this.compile(getConnection()).toSQL()
    return { sql: compiled.sql, params: compiled.params }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  async execute(): Promise<R[]> {
    const rows = (await this.compile(getConnection())) as R[]

    if (this.state.prefetch.length > 0) {
      await attachPrefetches(this.model, rows as Record<string, unknown>[], this.state.prefetch)
    }

    return rows
  }

  then<TResult1 = R[], TResult2 = never>(
    onfulfilled?: ((value: R[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  /** Streams rows one at a time — `for await (const post of Post.objects.all())`. */
  async *[Symbol.asyncIterator](): AsyncIterator<R> {
    for (const row of await this.execute()) yield row
  }

  // -------------------------------------------------------------------------
  // Terminal operations
  // -------------------------------------------------------------------------

  /** Exactly one row, or `DoesNotExist` / `MultipleObjectsReturned`. */
  async get(...conditions: Condition<M>[]): Promise<R> {
    // Fetch two so a duplicate can be reported without counting the whole table.
    const rows = await this.filter(...conditions).limit(2).execute()
    if (rows.length === 0) throw new DoesNotExist(this.model.name, conditions[0])
    if (rows.length > 1) throw new MultipleObjectsReturned(this.model.name, rows.length)
    return rows[0]!
  }

  /** Exactly one row, or `null`. */
  async getOrNull(...conditions: Condition<M>[]): Promise<R | null> {
    const rows = await this.filter(...conditions).limit(1).execute()
    return rows[0] ?? null
  }

  async first(): Promise<R | null> {
    const rows = await this.limit(1).execute()
    return rows[0] ?? null
  }

  async last(): Promise<R | null> {
    const rows = await this.reverse().limit(1).execute()
    return rows[0] ?? null
  }

  async count(): Promise<number> {
    const connection = getConnection()
    const ctx = this.context(connection)
    let query = activeDb(connection)
      .select({ value: countAgg() })
      .from(connection.table(this.model))
      .$dynamic()
    const where = this.where(ctx)
    if (where) query = query.where(where)
    const [row] = await query
    return Number(row?.value ?? 0)
  }

  async exists(): Promise<boolean> {
    const rows = await this.unordered().limit(1).only(this.model.pk as never).execute()
    return rows.length > 0
  }

  /** `aggregate({ total: 'sum:amount', oldest: 'min:createdAt' })` */
  async aggregate<S extends Record<string, AggregateSpec<M>>>(spec: S): Promise<Record<keyof S, number | null>> {
    const connection = getConnection()
    const ctx = this.context(connection)
    const table = connection.table(this.model)

    const selection: Record<string, any> = {}
    for (const [alias, expression] of Object.entries(spec)) {
      const [fn, field] = (expression as string).split(':') as [string, string]
      const column = table[this.model.columns[attrFor(this.model, field)]!]
      selection[alias] =
        fn === 'sum'
          ? sum(column)
          : fn === 'avg'
            ? avg(column)
            : fn === 'min'
              ? minAgg(column)
              : fn === 'max'
                ? maxAgg(column)
                : countAgg(column)
    }

    let query = activeDb(connection).select(selection).from(table).$dynamic()
    const where = this.where(ctx)
    if (where) query = query.where(where)
    const [row] = await query

    const result = {} as Record<keyof S, number | null>
    for (const alias of Object.keys(spec)) {
      const value = row?.[alias]
      result[alias as keyof S] = value === null || value === undefined ? null : Number(value)
    }
    return result
  }

  /** A `{ [pkValue]: row }` map — convenient for hydrating lists. */
  async inBulk(): Promise<Record<string, R>> {
    const rows = await this.execute()
    const result: Record<string, R> = {}
    for (const row of rows) result[String((row as any)[this.model.pk])] = row
    return result
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async create(data: InsertOf<M>): Promise<RowOf<M>> {
    const [row] = await this.bulkCreate([data])
    return row!
  }

  async bulkCreate(rows: InsertOf<M>[]): Promise<RowOf<M>[]> {
    if (rows.length === 0) return []
    const connection = getConnection()
    const table = connection.table(this.model)
    const values = rows.map((row) => this.toColumns(row as Record<string, unknown>, 'insert'))
    return (await activeDb(connection)
      .insert(table)
      .values(values)
      .returning(this.fullSelection(connection))) as RowOf<M>[]
  }

  /** Updates every matching row. Returns the updated rows. */
  async update(data: UpdateOf<M>): Promise<RowOf<M>[]> {
    const connection = getConnection()
    const ctx = this.context(connection)
    const table = connection.table(this.model)
    const values = this.toColumns(data as Record<string, unknown>, 'update', table)
    if (Object.keys(values).length === 0) return []

    let query = activeDb(connection).update(table).set(values).$dynamic()
    const where = this.where(ctx)
    if (where) query = query.where(where)
    return (await query.returning(this.fullSelection(connection))) as RowOf<M>[]
  }

  /** Deletes every matching row. Returns how many went. */
  async delete(): Promise<number> {
    const connection = getConnection()
    const ctx = this.context(connection)
    const table = connection.table(this.model)

    let query = activeDb(connection).delete(table).$dynamic()
    const where = this.where(ctx)
    if (where) query = query.where(where)
    const deleted = await query.returning({ id: table[this.model.columns[this.model.pk]!] })
    return Array.isArray(deleted) ? deleted.length : 0
  }

  /**
   * Fetches the row matching `criteria`, creating it from `defaults` if absent.
   * Always yields a complete row, even on a `values()`-narrowed queryset.
   */
  async getOrCreate(
    criteria: Filter<M['fields']>,
    defaults: Partial<InsertOf<M>> = {},
  ): Promise<[RowOf<M>, boolean]> {
    const full = this.deriveAs<RowOf<M>>({ fields: undefined })
    const existing = await full.getOrNull(criteria)
    if (existing) return [existing, false]
    return [await full.create({ ...criteria, ...defaults } as InsertOf<M>), true]
  }

  /** Updates the row matching `criteria`, creating it if absent. */
  async updateOrCreate(
    criteria: Filter<M['fields']>,
    values: Partial<InsertOf<M>> = {},
  ): Promise<[RowOf<M>, boolean]> {
    const full = this.deriveAs<RowOf<M>>({ fields: undefined })
    const existing = await full.getOrNull(criteria)
    if (!existing) {
      return [await full.create({ ...criteria, ...values } as InsertOf<M>), true]
    }
    const [updated] = await full
      .filter({ [this.model.pk]: (existing as Record<string, unknown>)[this.model.pk] } as never)
      .update(values as UpdateOf<M>)
    return [updated ?? existing, false]
  }

  /**
   * Maps a `{ attr: value }` object onto physical columns, applying JS-side
   * defaults and auto timestamps along the way.
   */
  private toColumns(
    data: Record<string, unknown>,
    mode: 'insert' | 'update',
    table?: Record<string, any>,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {}

    for (const [key, raw] of Object.entries(data)) {
      if (raw === undefined) continue
      const attr = attrFor(this.model, key)
      const field = this.model.fields[attr]!

      // An F-expression becomes SQL computed from the column's own value, so
      // the database applies it atomically rather than us reading and writing.
      if (isFExpression(raw)) {
        if (!table) throw new Error('F() expressions are only supported in update().')
        values[this.model.columns[attr]!] = raw.toSQL(this.model, table)
        continue
      }

      // Relations accept an instance or a bare id.
      const value =
        field.spec.kind === 'foreignKey' && raw !== null && typeof raw === 'object' && 'id' in (raw as object)
          ? (raw as { id: unknown }).id
          : raw
      values[this.model.columns[attr]!] = value
    }

    for (const [attr, field] of Object.entries(this.model.fields as FieldMap)) {
      const column = this.model.columns[attr]!
      const spec = field.spec

      if (spec.autoNow || (mode === 'insert' && spec.autoNowAdd)) {
        values[column] = new Date()
        continue
      }
      if (mode === 'insert' && values[column] === undefined && typeof spec.default === 'function') {
        values[column] = (spec.default as () => unknown)()
      }
    }

    return values
  }
}

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

type AggregateSpec<M extends AnyModel> = `${'sum' | 'avg' | 'min' | 'max' | 'count'}:${keyof M['fields'] & string}`

type RelationNames<M extends AnyModel> = {
  [K in keyof M['fields']]: M['fields'][K] extends { $relation: true } ? K : never
}[keyof M['fields']] &
  string

type RelationRow<M extends AnyModel, K extends string> = M['fields'][K] extends { $to: infer To extends AnyModel }
  ? RowOf<To>
  : never

type WithRelations<M extends AnyModel, K extends string> = {
  [P in K]: M['fields'][P] extends { $meta: { null: true } } ? RelationRow<M, P> | null : RelationRow<M, P>
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * `Model.objects`. A thin facade that starts a fresh QuerySet for each call,
 * so managers hold no state between queries.
 */
export class Manager<M extends AnyModel> {
  constructor(private readonly model: M) {}

  all(): QuerySet<M> {
    return new QuerySet(this.model)
  }

  filter(...conditions: Condition<M>[]): QuerySet<M> {
    return this.all().filter(...conditions)
  }

  exclude(...conditions: Condition<M>[]): QuerySet<M> {
    return this.all().exclude(...conditions)
  }

  orderBy(...fields: OrderBy<M['fields']>[]): QuerySet<M> {
    return this.all().orderBy(...fields)
  }

  selectRelated<K extends RelationNames<M>>(...relations: K[]) {
    return this.all().selectRelated(...relations)
  }

  prefetch<const Spec extends PrefetchMap>(spec: Spec) {
    return this.all().prefetch(spec)
  }

  get(...conditions: Condition<M>[]): Promise<RowOf<M>> {
    return this.all().get(...conditions)
  }

  getOrNull(...conditions: Condition<M>[]): Promise<RowOf<M> | null> {
    return this.all().getOrNull(...conditions)
  }

  create(data: InsertOf<M>): Promise<RowOf<M>> {
    return this.all().create(data)
  }

  bulkCreate(rows: InsertOf<M>[]): Promise<RowOf<M>[]> {
    return this.all().bulkCreate(rows)
  }

  getOrCreate(criteria: Filter<M['fields']>, defaults?: Partial<InsertOf<M>>): Promise<[RowOf<M>, boolean]> {
    return this.all().getOrCreate(criteria, defaults)
  }

  updateOrCreate(criteria: Filter<M['fields']>, values?: Partial<InsertOf<M>>): Promise<[RowOf<M>, boolean]> {
    return this.all().updateOrCreate(criteria, values)
  }

  count(): Promise<number> {
    return this.all().count()
  }

  first(): Promise<RowOf<M> | null> {
    return this.all().first()
  }

  exists(): Promise<boolean> {
    return this.all().exists()
  }
}

export type { Filter, OrderBy, FieldMap }
