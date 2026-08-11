/**
 * Many-to-many relations.
 *
 * The join table is an ordinary model, always — never a hidden one the ORM
 * conjures and owns. That is the single most important decision here, because
 * the "extra column on the join" moment arrives in almost every project
 * (`addedAt`, `role`, `quantity`), and in ORMs that hide the table it means a
 * painful migration to a "through model" you should have had from the start.
 *
 * ```ts
 * const PostTag = defineModel('postTag', {
 *   fields: { post: f.foreignKey(() => Post), tag: f.foreignKey(() => Tag) },
 *   meta: { uniqueTogether: [['post', 'tag']] },
 * })
 *
 * const tags = manyToMany({ from: Post, to: Tag, through: PostTag })
 *
 * await tags.add(post.id, [1, 2])
 * await tags.of(post.id)            // TagRow[]
 * await tags.forMany([1, 2, 3])     // Map<postId, TagRow[]> — one query
 * ```
 *
 * So `manyToMany` is a *helper over models you own*, not a field type. There is
 * no new storage concept to learn: it is two foreign keys and a uniqueness
 * constraint, which is what a many-to-many has always been.
 */

import { atomic } from './transaction.ts'
import type { AnyModel, FieldMap, RowOf } from './model.ts'

/**
 * Coerces a stringified id back to a number when the target uses a numeric
 * primary key, and leaves it a string when it does not. A join row is keyed
 * on the target id, so a UUID primary key that `Number()` turned into `NaN`
 * produced a filter that matched nothing — `set()` then kept links it was
 * asked to remove.
 */
function toId(id: string): number | string {
  const numeric = Number(id)
  return Number.isNaN(numeric) ? id : numeric
}

export interface ManyToManyConfig<From extends AnyModel, To extends AnyModel, Through extends AnyModel> {
  from: From
  to: To
  /** The join model. You define it, so you can add columns to it. */
  through: Through
  /** Foreign key on `through` pointing at `from`. Inferred when unambiguous. */
  fromField?: string
  /** Foreign key on `through` pointing at `to`. Inferred when unambiguous. */
  toField?: string
}

function locate(through: AnyModel, target: AnyModel, explicit: string | undefined, role: string): string {
  const fields = through.fields as FieldMap

  if (explicit) {
    const field = fields[explicit]
    if (!field || field.spec.kind !== 'foreignKey') {
      throw new Error(`manyToMany: "${through.name}.${explicit}" is not a foreign key.`)
    }
    return explicit
  }

  const candidates = Object.entries(fields).filter(
    ([, field]) => field.spec.kind === 'foreignKey' && field.spec.to?.().name === target.name,
  )

  if (candidates.length === 0) {
    throw new Error(`manyToMany: "${through.name}" has no foreign key pointing at "${target.name}".`)
  }
  if (candidates.length > 1) {
    throw new Error(
      `manyToMany: "${through.name}" has ${candidates.length} foreign keys pointing at "${target.name}" ` +
        `(${candidates.map(([attr]) => attr).join(', ')}). Name it with { ${role}: '...' }.`,
    )
  }

  return candidates[0]![0]
}

export interface ManyToMany<To extends AnyModel, Through extends AnyModel> {
  readonly fromField: string
  readonly toField: string

  /** The related rows for one owner. */
  of(ownerId: number | string): Promise<RowOf<To>[]>
  /**
   * Related rows for many owners at once, grouped by owner id.
   * One query regardless of how many owners — the batched form exists so the
   * loop-and-await version never has to be written.
   */
  forMany(ownerIds: readonly (number | string)[]): Promise<Map<unknown, RowOf<To>[]>>
  /** The join rows themselves, when the extra columns matter. */
  links(ownerId: number | string): Promise<RowOf<Through>[]>

  /** Adds links, ignoring any that already exist. Returns how many were created. */
  add(ownerId: number | string, targetIds: readonly (number | string)[], extra?: Record<string, unknown>): Promise<number>
  /** Removes the named links. Returns how many went. */
  remove(ownerId: number | string, targetIds: readonly (number | string)[]): Promise<number>
  /** Removes every link for this owner. */
  clear(ownerId: number | string): Promise<number>
  /**
   * Makes the set exactly `targetIds`: adds what's missing, removes the rest.
   * Runs in one transaction, so a failure leaves the previous set intact.
   */
  set(ownerId: number | string, targetIds: readonly (number | string)[], extra?: Record<string, unknown>): Promise<void>
  /** Whether a particular link exists. */
  has(ownerId: number | string, targetId: number | string): Promise<boolean>
}

/**
 * Builds the helper for a many-to-many expressed through a model you own.
 */
export function manyToMany<From extends AnyModel, To extends AnyModel, Through extends AnyModel>(
  config: ManyToManyConfig<From, To, Through>,
): ManyToMany<To, Through> {
  const { from, to, through } = config
  const fromField = locate(through, from, config.fromField, 'fromField')
  const toField = locate(through, to, config.toField, 'toField')

  // Self-referential relations (a user following users) would otherwise
  // resolve both ends to the same column.
  if (fromField === toField) {
    throw new Error(
      `manyToMany: both ends resolved to "${through.name}.${fromField}". ` +
        `A self-referential relation needs explicit fromField and toField.`,
    )
  }

  const targetIdsOf = (links: Record<string, unknown>[]) => links.map((link) => link[`${toField}Id`])

  return {
    fromField,
    toField,

    async of(ownerId) {
      const links = (await through.objects.filter({ [`${fromField}Id`]: ownerId } as never)) as Record<string, unknown>[]
      const ids = targetIdsOf(links)
      if (ids.length === 0) return []
      return (await to.objects.filter({ [`${to.pk}__in`]: ids } as never)) as RowOf<To>[]
    },

    async forMany(ownerIds) {
      const grouped = new Map<unknown, RowOf<To>[]>()
      for (const ownerId of ownerIds) grouped.set(ownerId, [])
      if (ownerIds.length === 0) return grouped

      const links = (await through.objects.filter({
        [`${fromField}Id__in`]: ownerIds,
      } as never)) as Record<string, unknown>[]

      const ids = [...new Set(targetIdsOf(links))]
      if (ids.length === 0) return grouped

      const rows = (await to.objects.filter({ [`${to.pk}__in`]: ids } as never)) as Record<string, unknown>[]
      const byId = new Map(rows.map((row) => [row[to.pk], row]))

      for (const link of links) {
        const row = byId.get(link[`${toField}Id`])
        if (!row) continue
        grouped.get(link[`${fromField}Id`])?.push(row as RowOf<To>)
      }

      return grouped
    },

    async links(ownerId) {
      return (await through.objects.filter({ [`${fromField}Id`]: ownerId } as never)) as RowOf<Through>[]
    },

    async add(ownerId, targetIds, extra = {}) {
      if (targetIds.length === 0) return 0

      return atomic(async () => {
        // Read the existing set first: re-adding a link should be a no-op, not
        // a uniqueness violation the caller has to catch.
        const existing = (await through.objects.filter({
          [`${fromField}Id`]: ownerId,
          [`${toField}Id__in`]: targetIds,
        } as never)) as Record<string, unknown>[]

        const already = new Set(targetIdsOf(existing).map(String))
        const missing = [...new Set(targetIds.map(String))].filter((id) => !already.has(id))
        if (missing.length === 0) return 0

        const rows = missing.map((id) => ({
          ...extra,
          [fromField]: ownerId,
          [toField]: toId(id),
        }))

        await through.objects.bulkCreate(rows as never[])
        return rows.length
      })
    },

    async remove(ownerId, targetIds) {
      if (targetIds.length === 0) return 0
      return through.objects
        .filter({ [`${fromField}Id`]: ownerId, [`${toField}Id__in`]: targetIds } as never)
        .delete()
    },

    async clear(ownerId) {
      return through.objects.filter({ [`${fromField}Id`]: ownerId } as never).delete()
    },

    async set(ownerId, targetIds, extra = {}) {
      // One transaction: a failure halfway must not leave the owner with a
      // partial set, which would be worse than not having applied it at all.
      await atomic(async () => {
        const wanted = new Set(targetIds.map(String))

        const existing = (await through.objects.filter({
          [`${fromField}Id`]: ownerId,
        } as never)) as Record<string, unknown>[]

        const current = new Set(targetIdsOf(existing).map(String))
        const toRemove = [...current].filter((id) => !wanted.has(id))
        const toAdd = [...wanted].filter((id) => !current.has(id))

        if (toRemove.length > 0) {
          await through.objects
            .filter({ [`${fromField}Id`]: ownerId, [`${toField}Id__in`]: toRemove.map(toId) } as never)
            .delete()
        }

        if (toAdd.length > 0) {
          await through.objects.bulkCreate(
            toAdd.map((id) => ({
              ...extra,
              [fromField]: ownerId,
              [toField]: toId(id),
            })) as never[],
          )
        }
      })
    },

    async has(ownerId, targetId) {
      return through.objects
        .filter({ [`${fromField}Id`]: ownerId, [`${toField}Id`]: targetId } as never)
        .exists()
    },
  }
}
