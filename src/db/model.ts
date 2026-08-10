/**
 * Models.
 *
 * `defineModel` is a function rather than a class because the whole point of
 * the "type-first, minimal magic" design is that the row type is *inferred*
 * from the field map — a class body can't do that without decorators.
 */

import { Field, RelationField, auto, type AnyField, type FieldMeta, type FieldSpec } from './fields.ts'
import { Manager } from './queryset.ts'

export type FieldMap = Record<string, AnyField>

export interface IndexSpec {
  fields: string[]
  unique?: boolean
  name?: string
}

export interface ModelMeta {
  /** Physical table name. Defaults to snake_case + pluralised model name. */
  tableName?: string
  /** Default ordering, Django style: `['-createdAt', 'title']`. */
  ordering?: string[]
  indexes?: IndexSpec[]
  uniqueTogether?: string[][]
  verboseName?: string
  verboseNamePlural?: string
}

export interface ResolvedMeta extends ModelMeta {
  tableName: string
  ordering: string[]
  indexes: IndexSpec[]
  uniqueTogether: string[][]
  verboseName: string
  verboseNamePlural: string
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

type MetaOfField<X> = X extends Field<any, infer M> ? M : never
type ValueOfField<X> = X extends Field<infer T, any> ? T : never

/** The value as it comes back from a SELECT. */
export type FieldValue<X> = MetaOfField<X>['null'] extends true ? ValueOfField<X> | null : ValueOfField<X>

/** Relations live in the row as `<attr>Id`. */
type RelationKeys<F extends FieldMap> = {
  [K in keyof F]: F[K] extends RelationField<any, any, any> ? K : never
}[keyof F]

type ColumnKey<F extends FieldMap, K extends keyof F> = K extends RelationKeys<F>
  ? `${K & string}Id`
  : K

/** A row as selected from the database. */
export type SelectRow<F extends FieldMap> = {
  [K in keyof F as ColumnKey<F, K>]: FieldValue<F[K]>
}

type OptionalInsertKeys<F extends FieldMap> = {
  [K in keyof F]: MetaOfField<F[K]> extends infer M extends FieldMeta
    ? M['null'] extends true
      ? K
      : M['hasDefault'] extends true
        ? K
        : M['auto'] extends true
          ? K
          : never
    : never
}[keyof F]

/**
 * Writes address a relation by its field name (`author`), reads get the id
 * column (`authorId`) — the same split Django makes between `Post(author=user)`
 * and `post.author_id`. Either an instance or a bare id is accepted.
 */
type InsertValue<F extends FieldMap, K extends keyof F> = K extends RelationKeys<F>
  ? number | { id: number }
  : FieldValue<F[K]>

/** The shape accepted by `create()`. Defaults and nullables become optional. */
export type InsertRow<F extends FieldMap> = {
  [K in keyof F as K extends OptionalInsertKeys<F> ? never : K]: InsertValue<F, K>
} & {
  [K in keyof F as K extends OptionalInsertKeys<F> ? K : never]?: InsertValue<F, K>
}

/** The shape accepted by `update()` — everything optional, pk excluded. */
export type UpdateRow<F extends FieldMap> = Partial<{
  [K in keyof F as MetaOfField<F[K]>['primaryKey'] extends true ? never : K]: InsertValue<F, K>
}>

type HasExplicitPk<F extends FieldMap> = true extends {
  [K in keyof F]: MetaOfField<F[K]>['primaryKey']
}[keyof F]
  ? true
  : false

type ImplicitPk = {
  id: Field<number, { null: false; hasDefault: true; primaryKey: true; auto: true; unique: true; editable: false }>
}

/** Django adds an `id` primary key when you don't declare one. So do we. */
export type WithPk<F extends FieldMap> = HasExplicitPk<F> extends true ? F : ImplicitPk & F

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface Model<N extends string = string, F extends FieldMap = FieldMap> {
  readonly name: N
  readonly fields: F
  readonly meta: ResolvedMeta
  /** The primary key attribute name. */
  readonly pk: string
  readonly objects: Manager<Model<N, F>>

  /** Phantom row types — `typeof Post.$row` is the selected shape. */
  readonly $row: SelectRow<F>
  readonly $insert: InsertRow<F>
  readonly $update: UpdateRow<F>

  /** Set by the Drizzle bridge once a dialect is known. */
  __table?: unknown
  /** Maps attribute name -> physical column name. */
  readonly columns: Record<string, string>

  toString(): string
}

export type AnyModel = Model<string, any>

export type RowOf<M extends AnyModel> = M['$row']
export type InsertOf<M extends AnyModel> = M['$insert']
export type UpdateOf<M extends AnyModel> = M['$update']

export interface ModelDefinition<F extends FieldMap> {
  fields: F
  meta?: ModelMeta
}

const registry = new Map<string, AnyModel>()

/** Every model defined in this process. Used by the schema builder and CLI. */
export function registeredModels(): AnyModel[] {
  return [...registry.values()]
}

export function getModel(name: string): AnyModel | undefined {
  return registry.get(name)
}

/** `BlogPost` -> `blog_post` */
export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

/** Naive but predictable pluraliser, matching Django's table naming vibe. */
export function pluralize(value: string): string {
  if (/(s|sh|ch|x|z)$/.test(value)) return `${value}es`
  if (/[^aeiou]y$/.test(value)) return `${value.slice(0, -1)}ies`
  return `${value}s`
}

/**
 * Defines a model and registers it globally.
 *
 * ```ts
 * export const Post = defineModel('post', {
 *   fields: {
 *     title: f.char({ maxLength: 200 }),
 *     author: f.foreignKey(() => User),
 *     createdAt: f.datetime({ autoNowAdd: true }),
 *   },
 *   meta: { ordering: ['-createdAt'] },
 * })
 * ```
 */
export function defineModel<const N extends string, F extends FieldMap>(
  name: N,
  definition: ModelDefinition<F>,
): Model<N, WithPk<F>> {
  if (registry.has(name)) {
    throw new Error(
      `Model "${name}" is already defined. Model names must be unique across the project ` +
        `(the existing one maps to table "${registry.get(name)!.meta.tableName}").`,
    )
  }

  const declared = definition.fields as FieldMap
  const hasPk = Object.values(declared).some((field) => field.spec.primaryKey)
  const fields: FieldMap = hasPk ? { ...declared } : { id: auto(), ...declared }

  const pk = Object.entries(fields).find(([, field]) => field.spec.primaryKey)![0]

  const columns: Record<string, string> = {}
  for (const [attr, field] of Object.entries(fields)) {
    const suffixed = field.spec.kind === 'foreignKey' ? `${attr}_id` : attr
    columns[attr] = field.spec.dbColumn ?? snakeCase(suffixed)
  }

  const userMeta = definition.meta ?? {}
  const meta: ResolvedMeta = {
    ...userMeta,
    tableName: userMeta.tableName ?? pluralize(snakeCase(name)),
    ordering: userMeta.ordering ?? [],
    indexes: userMeta.indexes ?? [],
    uniqueTogether: userMeta.uniqueTogether ?? [],
    verboseName: userMeta.verboseName ?? name,
    verboseNamePlural: userMeta.verboseNamePlural ?? pluralize(userMeta.verboseName ?? name),
  }

  validateMeta(name, fields, meta)

  const model = {
    name,
    fields,
    meta,
    pk,
    columns,
    toString: () => `<Model ${name}>`,
  } as unknown as Model<N, WithPk<F>>

  Object.defineProperty(model, 'objects', {
    // Lazy so the manager can capture the finished model object.
    value: new Manager(model as unknown as AnyModel),
    enumerable: true,
  })

  registry.set(name, model as unknown as AnyModel)
  return model
}

function validateMeta(name: string, fields: FieldMap, meta: ResolvedMeta): void {
  const known = new Set(Object.keys(fields))
  const check = (attr: string, where: string) => {
    const bare = attr.startsWith('-') ? attr.slice(1) : attr
    if (!known.has(bare)) {
      throw new Error(`Model "${name}": ${where} references unknown field "${bare}".`)
    }
  }
  for (const attr of meta.ordering) check(attr, 'meta.ordering')
  for (const index of meta.indexes) for (const attr of index.fields) check(attr, 'meta.indexes')
  for (const group of meta.uniqueTogether) for (const attr of group) check(attr, 'meta.uniqueTogether')
}

/**
 * Clears the model registry. Only for tests — a real process defines each model
 * exactly once at import time.
 */
export function _resetModelRegistry(): void {
  registry.clear()
}

/** Resolves the target model of a foreign key, throwing a useful error if unset. */
export function relationTarget(model: AnyModel, attr: string): AnyModel {
  const field = model.fields[attr]
  const to = field?.spec.to
  if (!to) throw new Error(`Field "${model.name}.${attr}" is not a relation.`)
  const target = to()
  if (!target) {
    throw new Error(
      `Foreign key "${model.name}.${attr}" resolved to undefined. ` +
        `This usually means a circular import — make sure the target is referenced lazily: ` +
        `f.foreignKey(() => User).`,
    )
  }
  return target
}

export type { FieldSpec }
