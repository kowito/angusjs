/**
 * The authorization model.
 *
 * One set of predicates over `context.user`, consumed by REST routes, the
 * admin, MCP tools and application services alike — because all four dispatch
 * through the same route table. Adding a surface does not mean re-deciding who
 * may do what.
 */

import type { Context, Permission } from '../routing/router.ts'
import type { SessionRow, UserRow } from './models.ts'

// The base predicates and combinators have a single home in `routing`, which
// `angusjs/auth` re-exports so this module is a complete authorization toolkit
// without shipping second copies that could drift from the originals.
export {
  all,
  allowAny,
  any,
  either,
  isAuthenticated,
  isStaff,
  not,
  readOnlyOrAuthenticated,
} from '../routing/router.ts'

/** What `authenticate` puts on the context. */
export interface Identity {
  user: UserRow
  session: SessionRow
  /** Empty means "everything this user may do". */
  scopes: string[]
}

export function identityOf(context: Context): Identity | null {
  return (context.identity as Identity | undefined) ?? null
}

export function userOf(context: Context): UserRow | null {
  return (context.user as UserRow | undefined) ?? null
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export const isActive: Permission = (context) => Boolean(userOf(context)?.isActive)

export const isSuperuser: Permission = (context) => Boolean(userOf(context)?.isSuperuser)

export const isEmailVerified: Permission = (context) => Boolean(userOf(context)?.emailVerifiedAt)

/** Requires one of the named roles. A superuser always passes. */
/**
 * Names a permission function so a denial can say which one refused.
 *
 * A factory like `hasRole('editor')` returns a fresh closure whose `.name` is
 * empty, so a 403 from it would read "denied by ``" — useless. Naming it
 * `hasRole(editor)` makes the development diagnostic and the server log point
 * at the actual gate. Purely for diagnostics; it changes no behaviour.
 */
function named(name: string, permission: Permission): Permission {
  Object.defineProperty(permission, 'name', { value: name, configurable: true })
  return permission
}

export function hasRole(...roles: string[]): Permission {
  return named(`hasRole(${roles.join(', ')})`, (context) => {
    const user = userOf(context)
    if (!user) return false
    if (user.isSuperuser) return true
    const owned = new Set(user.roles ?? [])
    return roles.some((role) => owned.has(role))
  })
}

/**
 * Requires a scope on the *credential*, not the user.
 *
 * This is what makes a narrow API token possible: a full user issues a token
 * limited to `posts:read`, and it cannot do more than that even though the user
 * could. Credentials with no scopes are unrestricted.
 */
export function hasScope(...required: string[]): Permission {
  return named(`hasScope(${required.join(', ')})`, (context) => {
    const identity = identityOf(context)
    if (!identity) return false
    if (identity.scopes.length === 0) return true
    return required.every((scope) => identity.scopes.includes(scope))
  })
}

/**
 * Object-level ownership, checked against a route parameter.
 *
 * `isOwner('userId')` compares `params.userId` to the signed-in user's id.
 */
export function isOwner(param = 'userId'): Permission {
  return named(`isOwner(${param})`, (context) => {
    const user = userOf(context)
    if (!user) return false
    if (user.isSuperuser) return true
    const value = (context.params as Record<string, unknown> | undefined)?.[param]
    return value !== undefined && String(value) === String(user.id)
  })
}


// ---------------------------------------------------------------------------
// Row-level scoping
// ---------------------------------------------------------------------------

/**
 * The queryset filter that expresses row-level security.
 *
 * Given `ownedBy('author')`, a view set sees only the caller's own rows — on
 * every action, so a row outside the scope 404s on read *and* on write rather
 * than leaking through an endpoint someone forgot to guard.
 *
 * ```ts
 * modelViewSet({ model: Post, serializer, queryset: ownedBy('author')(Post) })
 * ```
 */
export function ownedBy(field: string) {
  return <M extends { objects: { all(): any; filter(condition: any): any } }>(model: M) =>
    (context: Context) => {
      const user = userOf(context)
      if (user?.isSuperuser) return model.objects.all()
      // No user means no rows: safer than returning everything.
      if (!user) return model.objects.filter({ [field]: -1 })
      return model.objects.filter({ [field]: user.id })
    }
}
