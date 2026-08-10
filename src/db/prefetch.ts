/**
 * Prefetching reverse relations.
 *
 * `selectRelated` handles the many-to-one direction with a join: a post has one
 * author, so the row can carry it. The other direction can't work that way — an
 * author has many posts, and joining would multiply the author across every row
 * and break `limit`.
 *
 * So this issues **one extra query per relation, not per row**. Fetching 50
 * authors with their posts is two queries, not fifty-one. That is the whole
 * point: the N+1 is the default outcome of the obvious code, and the framework's
 * job is to make the batched version the easy one.
 *
 * The related model is passed explicitly rather than looked up by name:
 *
 * ```ts
 * await Author.objects.prefetch({ posts: Post })
 * ```
 *
 * which keeps the result typed without a global registry of reverse names, and
 * makes the extra query visible at the call site instead of hidden behind an
 * attribute access that silently costs a round trip.
 */

import type { AnyModel, FieldMap, RowOf } from './model.ts'
import type { QuerySet } from './queryset.ts'

export interface PrefetchConfig {
  model: AnyModel
  /**
   * The foreign key on the related model that points back here. Only needed
   * when the related model has more than one — otherwise it is inferred.
   */
  via?: string
  /** Narrows what is fetched: only published posts, say. */
  queryset?: (base: QuerySet<AnyModel, any>) => QuerySet<AnyModel, any>
  /** Ordering applied to each group. */
  orderBy?: string[]
}

export type PrefetchSpec = AnyModel | PrefetchConfig

export type PrefetchMap = Record<string, PrefetchSpec>

type ModelOf<S> = S extends AnyModel ? S : S extends { model: infer M extends AnyModel } ? M : never

/** What `prefetch()` adds to the row type: an array per named relation. */
export type PrefetchResult<Spec extends PrefetchMap> = {
  [K in keyof Spec]: RowOf<ModelOf<Spec[K]>>[]
}

export interface ResolvedPrefetch {
  key: string
  model: AnyModel
  /** Attribute on the related model holding the foreign key. */
  via: string
  config: PrefetchConfig
}

function normalise(spec: PrefetchSpec): PrefetchConfig {
  return 'model' in spec ? spec : { model: spec as AnyModel }
}

/**
 * Works out which foreign key on the related model points back at `owner`.
 * Ambiguity is an error rather than a guess: a model with both `author` and
 * `editor` pointing at User has no obvious answer, and picking one silently
 * would produce quietly wrong data.
 */
export function resolvePrefetch(owner: AnyModel, key: string, spec: PrefetchSpec): ResolvedPrefetch {
  const config = normalise(spec)
  const fields = config.model.fields as FieldMap

  if (config.via) {
    const field = fields[config.via]
    if (!field || field.spec.kind !== 'foreignKey') {
      throw new Error(
        `prefetch({ ${key} }): "${config.model.name}.${config.via}" is not a foreign key.`,
      )
    }
    return { key, model: config.model, via: config.via, config }
  }

  const candidates = Object.entries(fields).filter(
    ([, field]) => field.spec.kind === 'foreignKey' && field.spec.to?.().name === owner.name,
  )

  if (candidates.length === 0) {
    throw new Error(
      `prefetch({ ${key} }): "${config.model.name}" has no foreign key pointing at "${owner.name}".`,
    )
  }

  if (candidates.length > 1) {
    throw new Error(
      `prefetch({ ${key} }): "${config.model.name}" has ${candidates.length} foreign keys pointing at ` +
        `"${owner.name}" (${candidates.map(([attr]) => attr).join(', ')}). ` +
        `Say which one with { ${key}: { model: ${config.model.name}, via: '${candidates[0]![0]}' } }.`,
    )
  }

  return { key, model: config.model, via: candidates[0]![0], config }
}

/**
 * Runs the prefetch queries and attaches the results.
 *
 * Rows are mutated in place: they came from `execute()` and belong to nobody
 * else yet, and copying every row to add one key would be wasteful on a page of
 * results.
 */
export async function attachPrefetches(
  owner: AnyModel,
  rows: Record<string, unknown>[],
  prefetches: ResolvedPrefetch[],
): Promise<void> {
  if (rows.length === 0 || prefetches.length === 0) return

  const pk = owner.pk
  const ids = [...new Set(rows.map((row) => row[pk]).filter((id) => id !== null && id !== undefined))]

  await Promise.all(
    prefetches.map(async (prefetch) => {
      // An empty parent set still needs the key present, as an empty array.
      if (ids.length === 0) {
        for (const row of rows) row[prefetch.key] = []
        return
      }

      let queryset = prefetch.model.objects.filter({ [`${prefetch.via}Id__in`]: ids } as never)
      if (prefetch.config.orderBy?.length) queryset = queryset.orderBy(...(prefetch.config.orderBy as never[]))
      if (prefetch.config.queryset) queryset = prefetch.config.queryset(queryset as never) as never

      const related = (await queryset) as Record<string, unknown>[]

      const grouped = new Map<unknown, Record<string, unknown>[]>()
      for (const child of related) {
        const parentId = child[`${prefetch.via}Id`]
        const bucket = grouped.get(parentId)
        if (bucket) bucket.push(child)
        else grouped.set(parentId, [child])
      }

      // Every parent gets the key, so `author.posts` is never undefined.
      for (const row of rows) {
        row[prefetch.key] = grouped.get(row[pk]) ?? []
      }
    }),
  )
}
