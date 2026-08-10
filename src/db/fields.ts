/**
 * Field definitions.
 *
 * A field is a *description*, not a column. The same `FieldSpec` is consumed by
 * three different layers: the Drizzle bridge (to build a real column), the
 * serializer layer (to build a TypeBox schema), and the QuerySet (to know which
 * lookups are legal). Nothing here imports Drizzle or Elysia on purpose.
 */

import type { AnyModel } from './model.ts'

export type FieldKind =
  | 'auto'
  | 'bigAuto'
  | 'char'
  | 'text'
  | 'email'
  | 'slug'
  | 'url'
  | 'uuid'
  | 'integer'
  | 'bigInteger'
  | 'smallInteger'
  | 'float'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'json'
  | 'foreignKey'

export type OnDelete = 'cascade' | 'restrict' | 'set null' | 'no action'

/** The runtime shape every field carries. */
export interface FieldSpec {
  kind: FieldKind
  /** Column is nullable in the database. */
  null: boolean
  /** Value may be omitted/empty in *validation* (Django's `blank`). */
  blank: boolean
  unique: boolean
  index: boolean
  primaryKey: boolean
  /** Writable by serializers. `false` for auto pks and auto timestamps. */
  editable: boolean
  /** The database generates this value; never required on insert. */
  auto: boolean
  hasDefault: boolean
  default?: unknown
  /** Override the physical column name. Defaults to snake_case of the attribute. */
  dbColumn?: string
  maxLength?: number
  minLength?: number
  min?: number
  max?: number
  precision?: number
  scale?: number
  choices?: readonly (string | number)[]
  /** Stamp `new Date()` on every save. */
  autoNow?: boolean
  /** Stamp `new Date()` on insert only. */
  autoNowAdd?: boolean
  verboseName?: string
  helpText?: string
  /** Foreign key target, lazy so models can reference each other circularly. */
  to?: () => AnyModel
  onDelete?: OnDelete
  relatedName?: string
}

/**
 * Compile-time facts about a field. Kept separate from the value type so
 * `InsertType` can tell "optional because nullable" from "optional because it
 * has a default".
 */
export interface FieldMeta {
  null: boolean
  hasDefault: boolean
  primaryKey: boolean
  auto: boolean
  unique: boolean
  editable: boolean
}

/**
 * A field carries its value type and metadata purely in the type system —
 * `$type` and `$meta` never exist at runtime.
 */
export class Field<T = unknown, M extends FieldMeta = FieldMeta> {
  declare readonly $type: T
  declare readonly $meta: M

  constructor(readonly spec: FieldSpec) {}

  /** Narrow a field to nullable after the fact (useful in generic helpers). */
  get isRelation(): boolean {
    return this.spec.kind === 'foreignKey'
  }
}

/**
 * Marker subclass so the type layer can tell a relation from a plain integer
 * column. Lives here rather than in `model.ts` to keep the runtime import graph
 * acyclic — `model.ts` imports fields, never the reverse.
 */
export class RelationField<T = number, M extends FieldMeta = FieldMeta, To extends AnyModel = AnyModel> extends Field<
  T,
  M
> {
  declare readonly $relation: true
  declare readonly $to: To
}

export type AnyField = Field<any, any>

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface BaseOptions<T> {
  null?: boolean
  blank?: boolean
  unique?: boolean
  index?: boolean
  primaryKey?: boolean
  editable?: boolean
  default?: T
  dbColumn?: string
  verboseName?: string
  helpText?: string
}

export interface CharOptions<T extends string = string> extends BaseOptions<T> {
  maxLength?: number
  minLength?: number
  choices?: readonly T[]
}

export interface NumberOptions<T extends number = number> extends BaseOptions<T> {
  min?: number
  max?: number
  choices?: readonly T[]
}

export interface DecimalOptions extends BaseOptions<string> {
  precision?: number
  scale?: number
}

export interface DateTimeOptions extends BaseOptions<Date> {
  autoNow?: boolean
  autoNowAdd?: boolean
}

export interface ForeignKeyOptions extends Omit<BaseOptions<never>, 'default'> {
  onDelete?: OnDelete
  relatedName?: string
}

/**
 * Derives compile-time metadata from the literal options object. Requires the
 * builders to be generic over `const O` so `{ null: true }` keeps its literal
 * type rather than widening to `boolean`.
 */
export type MetaOf<O> = {
  null: O extends { null: true } ? true : false
  hasDefault: O extends { default: unknown } ? true : false
  primaryKey: O extends { primaryKey: true } ? true : false
  auto: O extends { autoNow: true } | { autoNowAdd: true } ? true : false
  unique: O extends { unique: true } ? true : false
  editable: O extends { editable: false } ? false : true
}

/** Applies `choices` as a literal union when present. */
type Choose<O, T> = O extends { choices: readonly (infer C)[] } ? C : T

const base = (kind: FieldKind, options: object = {}): FieldSpec => {
  const opts = options as Record<string, unknown>
  return {
    kind,
    null: opts.null === true,
    blank: opts.blank === true || opts.null === true,
    unique: opts.unique === true,
    index: opts.index === true,
    primaryKey: opts.primaryKey === true,
    editable: opts.editable !== false,
    auto: opts.autoNow === true || opts.autoNowAdd === true,
    hasDefault: 'default' in opts && opts.default !== undefined,
    ...opts,
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Auto-incrementing integer primary key. The default `id` on every model. */
export function auto(): Field<number, { null: false; hasDefault: true; primaryKey: true; auto: true; unique: true; editable: false }> {
  return new Field({ ...base('auto'), primaryKey: true, auto: true, hasDefault: true, unique: true, editable: false })
}

/** 64-bit auto-incrementing primary key. */
export function bigAuto(): Field<number, { null: false; hasDefault: true; primaryKey: true; auto: true; unique: true; editable: false }> {
  return new Field({ ...base('bigAuto'), primaryKey: true, auto: true, hasDefault: true, unique: true, editable: false })
}

export function char<const O extends CharOptions<string>>(
  opts: O = {} as O,
): Field<Choose<O, string> & string, MetaOf<O>> {
  return new Field(base('char', opts))
}

export function text<const O extends CharOptions<string>>(
  opts: O = {} as O,
): Field<Choose<O, string> & string, MetaOf<O>> {
  return new Field(base('text', opts))
}

export function email<const O extends CharOptions<string>>(opts: O = {} as O): Field<string, MetaOf<O>> {
  return new Field(base('email', { maxLength: 254, ...opts }))
}

export function slug<const O extends CharOptions<string>>(opts: O = {} as O): Field<string, MetaOf<O>> {
  return new Field(base('slug', { maxLength: 50, ...opts }))
}

export function url<const O extends CharOptions<string>>(opts: O = {} as O): Field<string, MetaOf<O>> {
  return new Field(base('url', { maxLength: 2048, ...opts }))
}

export function uuid<const O extends BaseOptions<string>>(opts: O = {} as O): Field<string, MetaOf<O>> {
  return new Field(base('uuid', opts))
}

export function integer<const O extends NumberOptions<number>>(
  opts: O = {} as O,
): Field<Choose<O, number> & number, MetaOf<O>> {
  return new Field(base('integer', opts))
}

export function smallInteger<const O extends NumberOptions<number>>(
  opts: O = {} as O,
): Field<Choose<O, number> & number, MetaOf<O>> {
  return new Field(base('smallInteger', opts))
}

export function bigInteger<const O extends NumberOptions<number>>(opts: O = {} as O): Field<number, MetaOf<O>> {
  return new Field(base('bigInteger', opts))
}

export function float<const O extends NumberOptions<number>>(opts: O = {} as O): Field<number, MetaOf<O>> {
  return new Field(base('float', opts))
}

/** Fixed-precision decimal. Represented as a string to avoid float drift. */
export function decimal<const O extends DecimalOptions>(opts: O = {} as O): Field<string, MetaOf<O>> {
  return new Field(base('decimal', { precision: 10, scale: 2, ...opts }))
}

export function boolean<const O extends BaseOptions<boolean>>(opts: O = {} as O): Field<boolean, MetaOf<O>> {
  return new Field(base('boolean', opts))
}

export function datetime<const O extends DateTimeOptions>(opts: O = {} as O): Field<Date, MetaOf<O>> {
  const editable = opts.autoNow || opts.autoNowAdd ? false : opts.editable !== false
  return new Field(base('datetime', { ...opts, editable }))
}

export function date<const O extends DateTimeOptions>(opts: O = {} as O): Field<Date, MetaOf<O>> {
  const editable = opts.autoNow || opts.autoNowAdd ? false : opts.editable !== false
  return new Field(base('date', { ...opts, editable }))
}

export function time<const O extends BaseOptions<string>>(opts: O = {} as O): Field<string, MetaOf<O>> {
  return new Field(base('time', opts))
}

export function json<T = unknown, const O extends BaseOptions<T> = BaseOptions<T>>(
  opts: O = {} as O,
): Field<T, MetaOf<O>> {
  return new Field(base('json', opts))
}

/**
 * A many-to-one relation. Stores `<attr>_id` in the database; the QuerySet
 * accepts either `{ author: userInstance }` or `{ authorId: 1 }`.
 *
 * The target is a thunk so two models can point at each other.
 */
export function foreignKey<To extends AnyModel, const O extends ForeignKeyOptions>(
  to: () => To,
  opts: O = {} as O,
): RelationField<number, MetaOf<O>, To> {
  return new RelationField(base('foreignKey', { ...opts, to, onDelete: opts.onDelete ?? 'cascade' }))
}

/** Django's `OneToOneField` — a foreign key with a uniqueness constraint. */
export function oneToOne<To extends AnyModel, const O extends ForeignKeyOptions>(
  to: () => To,
  opts: O = {} as O,
): RelationField<number, MetaOf<O> & { unique: true }, To> {
  return new RelationField(
    base('foreignKey', { ...opts, to, unique: true, onDelete: opts.onDelete ?? 'cascade' }),
  ) as never
}

/** Namespaced access, so model files read `f.char({ ... })`. */
export const f = {
  auto,
  bigAuto,
  char,
  text,
  email,
  slug,
  url,
  uuid,
  integer,
  smallInteger,
  bigInteger,
  float,
  decimal,
  boolean,
  datetime,
  date,
  time,
  json,
  foreignKey,
  oneToOne,
}
