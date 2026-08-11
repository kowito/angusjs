/**
 * Serializers.
 *
 * DRF's job description — decide which fields cross the wire, validate what
 * comes in, shape what goes out — but the schema it produces is a real TypeBox
 * schema, so Elysia does the validating and documents the endpoint for free.
 */

import { t, type Static, type TSchema } from 'elysia'
import type { AnyModel, FieldMap, RowOf } from '../db/model.ts'
import type { FieldValue } from '../db/model.ts'
import { fieldSchema } from './schema.ts'

export { fieldSchema } from './schema.ts'
export type { SchemaMode } from './schema.ts'

/**
 * A schema whose *declared* type we control while the runtime value stays a
 * genuine TypeBox object. That keeps handler return types precise without
 * hand-writing a mapped type for every TypeBox constructor.
 */
type Typed<T> = TSchema & { static: T }

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** Dates leave as ISO strings. */
type Wire<V> = V extends Date ? string : V

type RelationKeys<F extends FieldMap> = {
  [K in keyof F]: F[K] extends { $relation: true } ? K : never
}[keyof F]

type ReadKey<F extends FieldMap, K extends keyof F> = K extends RelationKeys<F> ? `${K & string}Id` : K

type MetaOfField<X> = X extends { $meta: infer M } ? M : never

/** Fields the database fills in are optional on the way in. */
type OptionalWriteKeys<F extends FieldMap, K extends keyof F> = {
  [P in K]: MetaOfField<F[P]> extends { null: true } | { hasDefault: true } | { auto: true } | { primaryKey: true }
    ? P
    : F[P] extends { spec: { blank: true } }
      ? P
      : never
}[K]

export type Representation<F extends FieldMap, K extends keyof F> = {
  [P in K as ReadKey<F, P>]: Wire<FieldValue<F[P]>>
}

/** Relations accept a bare id or anything carrying one, as the ORM does. */
type WriteValue<F extends FieldMap, P extends keyof F> = P extends RelationKeys<F>
  ? number | { id: number }
  : FieldValue<F[P]>

export type Payload<F extends FieldMap, K extends keyof F> = {
  [P in Exclude<K, OptionalWriteKeys<F, K>>]: WriteValue<F, P>
} & {
  [P in Extract<K, OptionalWriteKeys<F, K>>]?: WriteValue<F, P>
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** A field computed at serialisation time rather than read from the row. */
export interface ComputedField<Row, Schema extends TSchema> {
  schema: Schema
  get: (row: Row) => Static<Schema> | Promise<Static<Schema>>
}

export interface SerializerOptions<M extends AnyModel, K extends keyof M['fields'], Extra> {
  /**
   * Schema name, used for the OpenAPI component. Defaults to the model name in
   * PascalCase. Set it when a model has more than one serializer, so the
   * document gets `Author` and `AuthorSummary` rather than `Author` twice.
   */
  name?: string
  /** Which model fields to include. Defaults to all of them. */
  fields?: readonly K[]
  /** Fields to leave out. Applied after `fields`. */
  exclude?: readonly (keyof M['fields'])[]
  /**
   * Relations to embed as a nested object instead of a bare id, keyed by the
   * foreign key's attribute name. The row must have been fetched with
   * `selectRelated(attr)` — `modelViewSet` arranges that automatically.
   */
  nested?: Record<string, Serializer<any, any, any>>
  /** Present in responses, rejected in request bodies. */
  readOnly?: readonly (keyof M['fields'])[]
  /** Accepted in request bodies, never returned — passwords and the like. */
  writeOnly?: readonly (keyof M['fields'])[]
  /**
   * Extra response-only fields computed from the row. Intersecting with the
   * concrete map type is what gives `get`'s parameter a contextual type —
   * inferring it from the generic constraint alone leaves it `any`.
   */
  computed?: Extra & Record<string, ComputedField<RowOf<M>, TSchema>>
  /** Last-chance hook to reshape the output object. */
  transform?: (output: Record<string, unknown>, row: RowOf<M>) => Record<string, unknown>
  /** Cross-field validation. Throw `ValidationError` to reject. */
  validate?: (payload: Record<string, unknown>) => void | Promise<void>
}

type ComputedMap<Row> = Record<string, ComputedField<Row, TSchema>>

type ComputedOutput<Extra> = Extra extends ComputedMap<any>
  ? { [P in keyof Extra]: Extra[P] extends ComputedField<any, infer S> ? Static<S> : never }
  : unknown

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** DRF-shaped: a map of field name to the problems with it. */
export class ValidationError extends Error {
  readonly errors: Record<string, string[]>

  constructor(errors: Record<string, string[]> | string) {
    const map = typeof errors === 'string' ? { detail: [errors] } : errors
    super(Object.entries(map).map(([field, messages]) => `${field}: ${messages.join(', ')}`).join('; '))
    this.name = 'ValidationError'
    this.errors = map
  }
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export interface Serializer<M extends AnyModel, Output, Input> {
  readonly model: M
  /** Model field attributes included in responses. */
  readonly readFields: string[]
  /** Model field attributes accepted in request bodies. */
  readonly writeFields: string[]

  /** Response schema for a single object. */
  readonly read: Typed<Output>
  /** Response schema for a list. */
  readonly readMany: Typed<Output[]>
  /** Request body schema for a create. */
  readonly write: Typed<Input>
  /** Request body schema for a partial update. */
  readonly patch: Typed<Partial<Input>>

  /** Relations embedded as nested objects, by attribute name. */
  readonly nestedFields: string[]

  /** Row -> the object that goes out over the wire. */
  toRepresentation(row: RowOf<M>): Promise<Output>
  toRepresentationMany(rows: RowOf<M>[]): Promise<Output[]>
  /**
   * Validated body -> the object handed to `create()` / `update()`.
   * `partial` skips the required-field check, which is what PATCH needs.
   */
  toInternal(payload: unknown, options?: { partial?: boolean }): Promise<Record<string, unknown>>
}

/**
 * Builds a serializer from a model.
 *
 * ```ts
 * const PostSerializer = serializer(Post, {
 *   fields: ['id', 'title', 'body', 'author', 'createdAt'],
 *   readOnly: ['id', 'createdAt'],
 *   computed: {
 *     excerpt: { schema: t.String(), get: (post) => post.body.slice(0, 80) },
 *   },
 * })
 * ```
 */
export function serializer<
  M extends AnyModel,
  const K extends keyof M['fields'] & string = keyof M['fields'] & string,
  const Extra extends ComputedMap<RowOf<M>> = {},
>(
  model: M,
  options: SerializerOptions<M, K, Extra> = {},
): Serializer<M, Representation<M['fields'], K> & ComputedOutput<Extra>, Payload<M['fields'], K>> {
  const all = Object.keys(model.fields) as K[]
  const excluded = new Set((options.exclude ?? []) as string[])
  const selected = (options.fields ?? all).map(String).filter((attr) => !excluded.has(attr))

  for (const attr of selected) {
    if (!(attr in model.fields)) {
      throw new Error(
        `serializer(${model.name}): "${attr}" is not a field. ` +
          `Available: ${Object.keys(model.fields).join(', ')}.`,
      )
    }
  }

  const readOnly = new Set((options.readOnly ?? []) as string[])
  const writeOnly = new Set((options.writeOnly ?? []) as string[])
  const computed = (options.computed ?? {}) as ComputedMap<RowOf<M>>

  const readFields = selected.filter((attr) => !writeOnly.has(attr))
  const writeFields = selected.filter((attr) => {
    if (readOnly.has(attr)) return false
    const spec = model.fields[attr]!.spec
    // Auto pks and auto timestamps are never client-supplied.
    return spec.editable && !spec.auto && !spec.primaryKey
  })

  /** Response key for an attribute: relations surface as `<attr>Id`. */
  const outKey = (attr: string) => (model.fields[attr]!.spec.kind === 'foreignKey' ? `${attr}Id` : attr)

  const nested = options.nested ?? {}
  for (const attr of Object.keys(nested)) {
    if (model.fields[attr]?.spec.kind !== 'foreignKey') {
      throw new Error(`serializer(${model.name}): nested field "${attr}" is not a foreign key.`)
    }
  }
  const nestedFields = Object.keys(nested).filter((attr) => readFields.includes(attr))

  const readProperties: Record<string, TSchema> = {}
  for (const attr of readFields) readProperties[outKey(attr)] = fieldSchema(model.fields[attr]!.spec, 'read')
  for (const attr of nestedFields) {
    const schema = nested[attr]!.read
    readProperties[attr] = model.fields[attr]!.spec.null ? t.Union([schema, t.Null()]) : schema
  }
  for (const [name, field] of Object.entries(computed)) readProperties[name] = field.schema

  // A foreign key reads as `<attr>Id` but writes as `<attr>`. Left alone, that
  // asymmetry breaks the most ordinary edit flow there is: GET a record, change
  // a field, PUT it back — the echoed `authorId` satisfies nothing and the
  // required `author` is missing, so the round-trip 422s. So a foreign key
  // accepts its value under either key. Both are optional at the schema level;
  // `toInternal` enforces that a required relation arrives under one of them.
  const writeAliases = new Map<string, string>() // authorId -> author
  const writeProperties: Record<string, TSchema> = {}
  for (const attr of writeFields) {
    const spec = model.fields[attr]!.spec
    if (spec.kind === 'foreignKey') {
      const idKey = `${attr}Id`
      writeProperties[attr] = t.Optional(fieldSchema(spec, 'write'))
      writeProperties[idKey] = t.Optional(fieldSchema(spec, 'write'))
      writeAliases.set(idKey, attr)
    } else {
      writeProperties[attr] = fieldSchema(spec, 'write')
    }
  }

  // PascalCase, because these names become OpenAPI component names and, from
  // there, the type names in whatever client is generated from the document.
  const schemaName = options.name ?? model.name.replace(/(^|[_-])([a-z])/g, (_, __, char: string) => char.toUpperCase())

  const read = t.Object(readProperties, { title: schemaName })
  const write = t.Object(writeProperties, { title: `${schemaName}Input` })
  const patch = t.Partial(write, { title: `${schemaName}Patch` })

  // A `date` field is a calendar date with no time, so it is formatted from the
  // Date's *local* components. Slicing toISOString() (UTC) shifts the day across
  // the offset — in UTC+9, a Date at local midnight of the 15th is 15:00Z of the
  // 14th, and the user who entered the 15th got the 14th back.
  const localDate = (value: Date): string =>
    `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`


  async function toRepresentation(row: RowOf<M>): Promise<any> {
    const source = row as Record<string, unknown>
    const output: Record<string, unknown> = {}

    for (const attr of readFields) {
      const key = outKey(attr)
      const value = source[key]
      output[key] =
        value instanceof Date
          ? model.fields[attr]!.spec.kind === 'date'
            ? localDate(value)
            : value.toISOString()
          : value
    }

    for (const attr of nestedFields) {
      const related = source[attr]
      if (related === undefined) {
        throw new Error(
          `serializer(${model.name}): "${attr}" is serialised as a nested object, but the row has no ` +
            `joined data for it. Fetch it with .selectRelated("${attr}").`,
        )
      }
      output[attr] = related === null ? null : await nested[attr]!.toRepresentation(related as never)
    }

    for (const [name, field] of Object.entries(computed)) {
      output[name] = await field.get(row)
    }

    return options.transform ? options.transform(output, row) : output
  }

  return {
    model,
    readFields,
    writeFields,
    nestedFields,
    read: read as never,
    readMany: t.Array(read) as never,
    write: write as never,
    patch: patch as never,

    toRepresentation,

    async toRepresentationMany(rows) {
      return Promise.all(rows.map((row) => toRepresentation(row)))
    },

    async toInternal(payload, internalOptions = {}) {
      if (payload === null || typeof payload !== 'object') {
        throw new ValidationError({ detail: ['Expected an object.'] })
      }
      const source = payload as Record<string, unknown>
      const errors: Record<string, string[]> = {}
      const internal: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(source)) {
        // Read-only and unknown keys are dropped rather than rejected, so a
        // client can echo a full response body back into a PATCH unchanged.
        // `authorId` maps onto the `author` field; an explicit `author` wins
        // over the id alias when a body somehow carries both.
        const attr = writeFields.includes(key) ? key : writeAliases.get(key)
        if (!attr) continue
        if (key === attr || internal[attr] === undefined) internal[attr] = value
      }

      for (const attr of writeFields) {
        const spec = model.fields[attr]!.spec
        const missing = internal[attr] === undefined
        const required = !spec.null && !spec.blank && !spec.hasDefault && !spec.auto
        // A PATCH only says what changes, so absence isn't an omission.
        if (missing && required && !internalOptions.partial) {
          errors[attr] = ['This field is required.']
        }
        if (!missing && internal[attr] === null && !spec.null) {
          errors[attr] = ['This field may not be null.']
        }
      }

      if (Object.keys(errors).length > 0) throw new ValidationError(errors)
      await options.validate?.(internal)
      return internal
    },
  }
}

/** The output type of a serializer, for annotating handlers. */
export type SerializerOutput<S> = S extends Serializer<any, infer O, any> ? O : never
/** The input type of a serializer. */
export type SerializerInput<S> = S extends Serializer<any, any, infer I> ? I : never
