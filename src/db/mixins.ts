/**
 * Field mixins.
 *
 * Reusable groups of fields, spread into a model's `fields`. Deliberately not
 * model inheritance: a mixin is a plain object, so `{ ...timestamps(), title }`
 * is obvious about what ends up on the table, and there is no base class whose
 * fields you have to go and look up.
 *
 * ```ts
 * defineModel('post', {
 *   fields: { ...timestamps(), ...softDelete(), title: f.char({ maxLength: 200 }) },
 * })
 * ```
 */

import { f } from './fields.ts'
import type { AnyModel, RowOf } from './model.ts'
import type { QuerySet } from './queryset.ts'

/** `createdAt` and `updatedAt`, maintained automatically. */
export function timestamps() {
  return {
    createdAt: f.datetime({ autoNowAdd: true }),
    updatedAt: f.datetime({ autoNow: true }),
  }
}

/**
 * Adds `deletedAt`, for rows that should disappear from the application without
 * disappearing from the database.
 *
 * The important caveat, stated rather than hidden: **this does not make
 * `delete()` soft.** `Model.objects.delete()` still removes the row. Use
 * `softDeleted(Model)` for the queryset that hides them and `softRemove()` to
 * mark them. Silently reinterpreting `delete()` would mean a developer reading
 * the call could not tell what it does.
 */
export function softDelete() {
  return {
    deletedAt: f.datetime({ null: true, index: true }),
  }
}

/** A `uuid` column with a generated default, for public-facing identifiers. */
export function publicId() {
  return {
    publicId: f.uuid({ unique: true, default: (() => crypto.randomUUID()) as never }),
  }
}

// ---------------------------------------------------------------------------
// Soft delete helpers
// ---------------------------------------------------------------------------

function assertSoftDeletable(model: AnyModel): void {
  if (!('deletedAt' in model.fields)) {
    throw new Error(
      `Model "${model.name}" has no \`deletedAt\` field. Add \`...softDelete()\` to its fields.`,
    )
  }
}

/** Rows that have not been soft-deleted. The queryset most views want. */
export function alive<M extends AnyModel>(model: M): QuerySet<M, RowOf<M>> {
  assertSoftDeletable(model)
  return model.objects.filter({ deletedAt__isnull: true } as never) as QuerySet<M, RowOf<M>>
}

/** Only the soft-deleted rows — a trash view, or a restore screen. */
export function deleted<M extends AnyModel>(model: M): QuerySet<M, RowOf<M>> {
  assertSoftDeletable(model)
  return model.objects.filter({ deletedAt__isnull: false } as never) as QuerySet<M, RowOf<M>>
}

/** Marks rows deleted without removing them. Returns how many were marked. */
export async function softRemove<M extends AnyModel>(queryset: QuerySet<M, any>): Promise<number> {
  assertSoftDeletable(queryset.model)
  const rows = await queryset.filter({ deletedAt__isnull: true } as never).update({ deletedAt: new Date() } as never)
  return rows.length
}

/** Brings soft-deleted rows back. */
export async function restore<M extends AnyModel>(queryset: QuerySet<M, any>): Promise<number> {
  assertSoftDeletable(queryset.model)
  const rows = await queryset.update({ deletedAt: null } as never)
  return rows.length
}

/**
 * A `queryset` for `modelViewSet` that hides soft-deleted rows on every action.
 *
 * ```ts
 * modelViewSet({ model: Post, serializer, queryset: () => alive(Post) })
 * ```
 */
export function aliveQueryset<M extends AnyModel>(model: M) {
  return () => alive(model)
}
