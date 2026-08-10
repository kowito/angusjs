/**
 * Model lifecycle hooks.
 *
 * The classic use is denormalisation and cache invalidation: something outside
 * the row needs to know the row changed. Doing that at every call site is how
 * a stale counter or a stale cache entry gets shipped — one place always gets
 * missed.
 *
 * Two deliberate limits, both about not lying:
 *
 * - Hooks fire for writes made **through the ORM**. A raw SQL update, a
 *   migration, or someone with a database client will not trigger them. Any
 *   ORM claiming otherwise is claiming more than it can enforce.
 * - `before` hooks may reshape the payload; `after` hooks may not. An `after`
 *   hook runs when the write has already happened, so a "change" there would
 *   silently do nothing.
 */

import type { AnyModel } from './model.ts'

export type HookEvent = 'beforeCreate' | 'afterCreate' | 'beforeUpdate' | 'afterUpdate' | 'beforeDelete' | 'afterDelete'

export interface HookContext {
  model: AnyModel
  event: HookEvent
  /** The values being written. Mutable in a `before` hook. */
  values?: Record<string, unknown>
  /** Rows affected. Present on `after` hooks, and on `beforeDelete`. */
  rows?: Record<string, unknown>[]
}

export type Hook = (context: HookContext) => void | Promise<void>

/** model name -> event -> hooks. */
const hooks = new Map<string, Map<HookEvent, Hook[]>>()

/**
 * Registers a hook.
 *
 * ```ts
 * onModel(Post, 'afterUpdate', async ({ rows }) => {
 *   await invalidateModels(Post)
 * })
 * ```
 */
export function onModel(model: AnyModel, event: HookEvent, hook: Hook): () => void {
  const byEvent = hooks.get(model.name) ?? new Map<HookEvent, Hook[]>()
  const list = byEvent.get(event) ?? []

  list.push(hook)
  byEvent.set(event, list)
  hooks.set(model.name, byEvent)

  // Returning the remover makes a hook testable, and lets an app tear one down.
  return () => {
    const current = hooks.get(model.name)?.get(event)
    if (!current) return
    const index = current.indexOf(hook)
    if (index !== -1) current.splice(index, 1)
  }
}

/** Registers the same hook for several events. */
export function onModelAny(model: AnyModel, events: HookEvent[], hook: Hook): () => void {
  const removers = events.map((event) => onModel(model, event, hook))
  return () => removers.forEach((remove) => remove())
}

export function hasHooks(model: AnyModel, event: HookEvent): boolean {
  return (hooks.get(model.name)?.get(event)?.length ?? 0) > 0
}

/**
 * Runs the hooks for an event.
 *
 * Sequential rather than parallel: hooks commonly mutate `values`, and running
 * them concurrently would make the result depend on scheduling.
 */
export async function runHooks(context: HookContext): Promise<void> {
  const list = hooks.get(context.model.name)?.get(context.event)
  if (!list || list.length === 0) return

  for (const hook of [...list]) {
    await hook(context)
  }
}

/** Only for tests. */
export function _resetHooks(): void {
  hooks.clear()
}

// ---------------------------------------------------------------------------
// Conveniences
// ---------------------------------------------------------------------------

/**
 * Clears cached entries tagged with this model whenever it changes.
 *
 * The one-liner that stops a cache going stale, and the reason hooks exist at
 * all rather than being left to call sites.
 */
export function invalidateCacheOnWrite(model: AnyModel): () => void {
  return onModelAny(model, ['afterCreate', 'afterUpdate', 'afterDelete'], async () => {
    const { invalidateModels } = await import('../cache/index.ts')
    await invalidateModels(model)
  })
}
