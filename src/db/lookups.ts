/**
 * Django-style field lookups (`age__gte`, `title__icontains`, `author__name`).
 *
 * The point of doing this in TypeScript rather than copying Django verbatim is
 * that the lookups can be *typed*: `age__gte` only accepts a number, `name__in`
 * only accepts `string[]`, and a typo in the field name is a compile error.
 */

import {
  and,
  between,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import type { AnyField, Field } from './fields.ts'
import { isFExpression, type FExpression } from './expressions.ts'
import type { AnyModel, FieldMap, FieldValue } from './model.ts'

// ---------------------------------------------------------------------------
// Type level
// ---------------------------------------------------------------------------

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never

type MetaOfField<X> = X extends Field<any, infer M> ? M : never
type ValueOfField<X> = X extends Field<infer T, any> ? T : never

type IsRelation<X> = X extends { $relation: true } ? true : false
type TargetOf<X> = X extends { $to: infer To extends AnyModel } ? To : never

/** Relations are filtered through their `<attr>Id` column, like Django's `author_id`. */
type FilterKeyOf<F extends FieldMap, K extends keyof F & string> = IsRelation<F[K]> extends true ? `${K}Id` : K

/** Lookups that make sense for every field type. */
type CommonLookups<K extends string, V> = {
  [P in K]?: V | readonly V[] | FExpression
} & {
  [P in `${K}__exact`]?: V | FExpression
} & {
  [P in `${K}__ne`]?: V | FExpression
} & {
  [P in `${K}__in`]?: readonly V[]
} & {
  [P in `${K}__notIn`]?: readonly V[]
} & {
  [P in `${K}__isnull`]?: boolean
}

type StringLookups<K extends string> = {
  [P in
    | `${K}__contains`
    | `${K}__icontains`
    | `${K}__startswith`
    | `${K}__istartswith`
    | `${K}__endswith`
    | `${K}__iendswith`
    | `${K}__iexact`]?: string
}

type OrderedLookups<K extends string, V> = {
  [P in `${K}__gt` | `${K}__gte` | `${K}__lt` | `${K}__lte`]?: V | FExpression
} & {
  [P in `${K}__range`]?: readonly [V, V]
}

type LookupsFor<K extends string, V> = CommonLookups<K, V> &
  ([V] extends [string] ? StringLookups<K> : unknown) &
  ([V] extends [number] ? OrderedLookups<K, V> : [V] extends [Date] ? OrderedLookups<K, V> : unknown)

/** Lookups reachable by traversing one foreign key, e.g. `author__name__icontains`. */
type RelationLookups<K extends string, X> =
  IsRelation<X> extends true
    ? TargetOf<X> extends infer To extends AnyModel
      ? UnionToIntersection<
          {
            [RK in keyof To['fields'] & string]: LookupsFor<
              `${K}__${FilterKeyOf<To['fields'], RK>}`,
              NonNullable<FieldValue<To['fields'][RK]>>
            >
          }[keyof To['fields'] & string]
        >
      : unknown
    : unknown

/**
 * The filter object accepted by `filter()` / `exclude()` / `get()`.
 *
 * Every key is optional; supplying several means AND. Use `Q.or(...)` for
 * disjunctions.
 */
export type Filter<F extends FieldMap> = UnionToIntersection<
  {
    [K in keyof F & string]: IsRelation<F[K]> extends true
      ? // A relation is filterable three ways: by id column (`author__isnull`),
        // by the relation name as a shorthand for the id (`author: user`), and
        // by traversal into the target (`author__name__icontains`).
        LookupsFor<`${K}Id`, number> & { [P in K]?: number | { id: number } } & RelationLookups<K, F[K]>
      : LookupsFor<K, NonNullable<FieldValue<F[K]>>>
  }[keyof F & string]
> & {
  /** Escape hatch for expressions the typed lookups don't cover. */
  $where?: SQL
  /** Set by `search()`; resolved against the dialect at compile time. */
  $search?: (ctx: ResolveContext) => SQL | null
}

export type FilterOf<M extends AnyModel> = Filter<M['fields']>

/** Valid `orderBy` arguments: a field name, optionally `-` prefixed. */
export type OrderBy<F extends FieldMap> = {
  [K in keyof F & string]: K | `-${K}` | FilterKeyOf<F, K> | `-${FilterKeyOf<F, K>}`
}[keyof F & string]

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export const LOOKUP_NAMES = [
  'exact',
  'iexact',
  'ne',
  'in',
  'notIn',
  'isnull',
  'contains',
  'icontains',
  'startswith',
  'istartswith',
  'endswith',
  'iendswith',
  'gt',
  'gte',
  'lt',
  'lte',
  'range',
] as const

export type LookupName = (typeof LOOKUP_NAMES)[number]

const LOOKUP_SET = new Set<string>(LOOKUP_NAMES)

/** Escapes the LIKE metacharacters so `title__contains: '100%'` means what it says. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

type TextLookup = 'contains' | 'startswith' | 'endswith' | 'iexact'

/**
 * Substring matching, which the two dialects disagree about enough to be worth
 * handling separately.
 *
 * SQLite's `LIKE` is case-*insensitive* for ASCII and has no case-sensitive
 * counterpart, so case-sensitive lookups there are built from `instr`/`substr`
 * instead — which also sidesteps escaping entirely. Postgres gets LIKE/ILIKE
 * with an explicit `ESCAPE` clause, without which a `%` in the value would be
 * treated as a wildcard.
 */
function textCondition(
  ctx: ResolveContext,
  column: any,
  lookup: TextLookup,
  insensitive: boolean,
  raw: unknown,
): SQL {
  const value = String(raw)

  if (ctx.dialect === 'postgres') {
    const pattern =
      lookup === 'contains'
        ? `%${escapeLike(value)}%`
        : lookup === 'startswith'
          ? `${escapeLike(value)}%`
          : lookup === 'endswith'
            ? `%${escapeLike(value)}`
            : escapeLike(value)
    return insensitive
      ? (sql`${column} ilike ${pattern} escape '\\'` as SQL)
      : (sql`${column} like ${pattern} escape '\\'` as SQL)
  }

  // SQLite. `lower()` folds ASCII only, which matches LIKE's own behaviour.
  const haystack = insensitive ? sql`lower(${column})` : sql`${column}`
  const needle = insensitive ? value.toLowerCase() : value

  switch (lookup) {
    case 'iexact':
      return sql`${haystack} = ${needle}` as SQL
    case 'contains':
      return sql`instr(${haystack}, ${needle}) > 0` as SQL
    case 'startswith':
      if (needle === '') return sql`1 = 1` as SQL
      return sql`substr(${haystack}, 1, ${needle.length}) = ${needle}` as SQL
    case 'endswith':
      if (needle === '') return sql`1 = 1` as SQL
      return sql`substr(${haystack}, -${needle.length}) = ${needle}` as SQL
  }
}

export interface ResolveContext {
  /** Resolves a model to the Drizzle table object built for the active dialect. */
  table: (model: AnyModel) => Record<string, any>
  dialect: 'sqlite' | 'postgres'
  /** Needed to build subqueries for relation traversal. */
  db: any
}

/** A parsed `author__name__icontains` key. */
export interface ParsedKey {
  /**
   * Relation attributes walked to reach the field, outermost first.
   * `models[i]` owns `path[i]`, which points at `models[i + 1]`.
   */
  path: string[]
  models: AnyModel[]
  /** The model the terminal field belongs to — the last entry of `models`. */
  model: AnyModel
  attr: string
  lookup: LookupName
}

/**
 * Splits a lookup key into its relation path, terminal field, and lookup name.
 *
 * A trailing segment counts as a lookup only when it is a known lookup name and
 * is not itself a field on the model it would apply to — so a model with a
 * field literally called `range` still works.
 */
export function parseLookupKey(model: AnyModel, key: string): ParsedKey {
  const segments = key.split('__')
  if (segments.length === 0 || segments[0] === '') {
    throw new Error(`Cannot resolve empty lookup key on model "${model.name}".`)
  }

  const path: string[] = []
  const models: AnyModel[] = [model]
  let current = model

  for (let i = 0; i < segments.length; i++) {
    const attr = resolveAttr(current, segments[i]!, key, model)
    const isRelation = current.fields[attr]!.spec.kind === 'foreignKey'
    const rest = segments.slice(i + 1)

    if (rest.length === 0) {
      return { path, models, model: current, attr, lookup: 'exact' }
    }

    // A single trailing segment may be a lookup on this field.
    if (rest.length === 1 && LOOKUP_SET.has(rest[0]!)) {
      const shadowed = isRelation && rest[0]! in resolveTarget(current, attr).fields
      if (!shadowed) {
        return { path, models, model: current, attr, lookup: rest[0] as LookupName }
      }
    }

    if (!isRelation) {
      throw new Error(
        `Cannot resolve "${key}" on model "${model.name}": "${attr}" is not a relation, ` +
          `so "${rest.join('__')}" cannot be traversed.`,
      )
    }

    // `authorId__name` is meaningless — the id column has nothing to traverse.
    if (segments[i] !== attr) {
      throw new Error(
        `Cannot resolve "${key}" on model "${model.name}": use "${attr}__${rest.join('__')}" ` +
          `to traverse the relation, not "${segments[i]}".`,
      )
    }

    path.push(attr)
    current = resolveTarget(current, attr)
    models.push(current)
  }

  throw new Error(`Cannot resolve "${key}" on model "${model.name}".`)
}

/** Accepts either the field name or its `<attr>Id` column alias. */
function resolveAttr(model: AnyModel, segment: string, key: string, root: AnyModel): string {
  if (segment in model.fields) return segment
  const stripped = segment.endsWith('Id') ? segment.slice(0, -2) : undefined
  if (stripped && model.fields[stripped]?.spec.kind === 'foreignKey') return stripped
  throw new Error(
    `Cannot resolve "${key}" on model "${root.name}": "${model.name}" has no field named "${segment}". ` +
      `Available: ${Object.keys(model.fields).join(', ')}.`,
  )
}

function resolveTarget(model: AnyModel, attr: string): AnyModel {
  const to = model.fields[attr]?.spec.to
  if (!to) throw new Error(`"${model.name}.${attr}" is not a relation.`)
  return to()
}

/** Normalises a value written for a relation: accepts an instance or a raw id. */
function normalizeValue(field: AnyField | undefined, value: unknown): unknown {
  if (field?.spec.kind === 'foreignKey' && value && typeof value === 'object' && 'id' in (value as object)) {
    return (value as { id: unknown }).id
  }
  return value
}

/**
 * Builds the SQL condition for a single `key: value` pair, wrapping each
 * traversed relation in an `IN (SELECT pk FROM ...)` subquery so no explicit
 * joins are needed.
 */
function buildLeaf(ctx: ResolveContext, model: AnyModel, key: string, rawValue: unknown): SQL {
  const parsed = parseLookupKey(model, key)
  let condition = buildFieldCondition(ctx, parsed.model, parsed.attr, parsed.lookup, rawValue)

  for (let i = parsed.path.length - 1; i >= 0; i--) {
    const owner = parsed.models[i]!
    const target = parsed.models[i + 1]!
    const ownerTable = ctx.table(owner)
    const targetTable = ctx.table(target)
    condition = inArray(
      ownerTable[owner.columns[parsed.path[i]!]!],
      ctx.db.select({ id: targetTable[target.columns[target.pk]!] }).from(targetTable).where(condition),
    ) as SQL
  }

  return condition
}

function buildFieldCondition(
  ctx: ResolveContext,
  model: AnyModel,
  attr: string,
  lookup: LookupName,
  rawValue: unknown,
): SQL {
  const field = model.fields[attr]
  const table = ctx.table(model)
  const column = table[model.columns[attr]!]
  if (!column) {
    throw new Error(
      `Model "${model.name}" has no column for field "${attr}". ` +
        `The Drizzle schema looks stale — re-run \`angus makemigrations\`.`,
    )
  }
  const key = `${attr}__${lookup}`
  // Comparing a column to another column, rather than to a literal.
  const value = isFExpression(rawValue) ? rawValue.toSQL(model, table) : normalizeValue(field, rawValue)

  switch (lookup) {
    case 'exact':
      if (value === null) return isNull(column)
      // `filter({ id: [1, 2] })` is a convenience for `id__in`.
      if (Array.isArray(value)) return inArray(column, value.map((v) => normalizeValue(field, v)))
      return eq(column, value)
    case 'ne':
      return value === null ? isNotNull(column) : ne(column, value)
    case 'iexact':
      return textCondition(ctx, column, 'iexact', true, value)
    case 'in': {
      const list = assertArray(key, value).map((v) => normalizeValue(field, v))
      // An empty IN () matches nothing; some engines reject the literal syntax.
      return list.length === 0 ? (sql`1 = 0` as SQL) : (inArray(column, list) as SQL)
    }
    case 'notIn': {
      const list = assertArray(key, value).map((v) => normalizeValue(field, v))
      return list.length === 0 ? (sql`1 = 1` as SQL) : (notInArray(column, list) as SQL)
    }
    case 'isnull':
      return value ? isNull(column) : isNotNull(column)
    case 'contains':
      return textCondition(ctx, column, 'contains', false, value)
    case 'icontains':
      return textCondition(ctx, column, 'contains', true, value)
    case 'startswith':
      return textCondition(ctx, column, 'startswith', false, value)
    case 'istartswith':
      return textCondition(ctx, column, 'startswith', true, value)
    case 'endswith':
      return textCondition(ctx, column, 'endswith', false, value)
    case 'iendswith':
      return textCondition(ctx, column, 'endswith', true, value)
    case 'gt':
      return gt(column, value)
    case 'gte':
      return gte(column, value)
    case 'lt':
      return lt(column, value)
    case 'lte':
      return lte(column, value)
    case 'range': {
      const range = assertArray(key, value)
      if (range.length !== 2) throw new Error(`"${key}" expects a [from, to] tuple.`)
      return between(column, range[0], range[1]) as SQL
    }
  }
}

function assertArray(key: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Lookup "${key}" expects an array, received ${typeof value}.`)
  return value
}

// ---------------------------------------------------------------------------
// Q objects
// ---------------------------------------------------------------------------

type QNode = { op: 'and' | 'or'; children: QCondition[] } | { op: 'not'; child: QCondition }

export class Q<F extends FieldMap = FieldMap> {
  constructor(readonly node: QNode) {}

  /** All conditions must hold. */
  static and<F extends FieldMap>(...conditions: (Filter<F> | Q<F>)[]): Q<F> {
    return new Q({ op: 'and', children: conditions as QCondition[] })
  }

  /** At least one condition must hold. */
  static or<F extends FieldMap>(...conditions: (Filter<F> | Q<F>)[]): Q<F> {
    return new Q({ op: 'or', children: conditions as QCondition[] })
  }

  /** Negates a condition. */
  static not<F extends FieldMap>(condition: Filter<F> | Q<F>): Q<F> {
    return new Q({ op: 'not', child: condition as QCondition })
  }

  and(other: Filter<F> | Q<F>): Q<F> {
    return Q.and<F>(this as Q<F>, other)
  }

  or(other: Filter<F> | Q<F>): Q<F> {
    return Q.or<F>(this as Q<F>, other)
  }
}

export type QCondition = Q<any> | Record<string, unknown>

/** Compiles a filter object or `Q` tree into a single Drizzle condition. */
export function buildCondition(ctx: ResolveContext, model: AnyModel, condition: QCondition): SQL | undefined {
  if (condition instanceof Q) {
    const node = condition.node
    if (node.op === 'not') {
      const inner = buildCondition(ctx, model, node.child)
      return inner ? (not(inner) as SQL) : undefined
    }
    const parts = node.children
      .map((child: QCondition) => buildCondition(ctx, model, child))
      .filter(Boolean) as SQL[]
    if (parts.length === 0) return undefined
    return (node.op === 'or' ? or(...parts) : and(...parts)) as SQL
  }

  const parts: SQL[] = []
  for (const [key, value] of Object.entries(condition)) {
    if (value === undefined) continue
    if (key === '$where') {
      parts.push(value as SQL)
      continue
    }
    // A search condition is built late, because the SQL it produces depends on
    // the dialect and a queryset is composed before any connection is chosen.
    if (key === '$search') {
      const built = (value as (ctx: ResolveContext) => SQL | null)(ctx)
      if (built) parts.push(built)
      continue
    }
    parts.push(buildLeaf(ctx, model, key, value))
  }
  if (parts.length === 0) return undefined
  return parts.length === 1 ? parts[0]! : (and(...parts) as SQL)
}

/** Combines several conditions with AND, skipping empty ones. */
export function combine(conditions: (SQL | undefined)[]): SQL | undefined {
  const parts = conditions.filter(Boolean) as SQL[]
  if (parts.length === 0) return undefined
  return parts.length === 1 ? parts[0]! : (and(...parts) as SQL)
}
