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

export const isAuthenticated: Permission = (context) => Boolean(context.user)

export const isActive: Permission = (context) => Boolean(userOf(context)?.isActive)

export const isStaff: Permission = (context) => {
  const user = userOf(context)
  return Boolean(user && (user.isStaff || user.isSuperuser))
}

export const isSuperuser: Permission = (context) => Boolean(userOf(context)?.isSuperuser)

export const isEmailVerified: Permission = (context) => Boolean(userOf(context)?.emailVerifiedAt)

/** Requires one of the named roles. A superuser always passes. */
export function hasRole(...roles: string[]): Permission {
  return (context) => {
    const user = userOf(context)
    if (!user) return false
    if (user.isSuperuser) return true
    const owned = new Set(user.roles ?? [])
    return roles.some((role) => owned.has(role))
  }
}

/**
 * Requires a scope on the *credential*, not the user.
 *
 * This is what makes a narrow API token possible: a full user issues a token
 * limited to `posts:read`, and it cannot do more than that even though the user
 * could. Credentials with no scopes are unrestricted.
 */
export function hasScope(...required: string[]): Permission {
  return (context) => {
    const identity = identityOf(context)
    if (!identity) return false
    if (identity.scopes.length === 0) return true
    return required.every((scope) => identity.scopes.includes(scope))
  }
}

/**
 * Object-level ownership, checked against a route parameter.
 *
 * `isOwner('userId')` compares `params.userId` to the signed-in user's id.
 */
export function isOwner(param = 'userId'): Permission {
  return (context) => {
    const user = userOf(context)
    if (!user) return false
    if (user.isSuperuser) return true
    const value = (context.params as Record<string, unknown> | undefined)?.[param]
    return value !== undefined && String(value) === String(user.id)
  }
}

/** Anonymous callers may read; writes require a signed-in user. */
export const readOnlyOrAuthenticated: Permission = (context) => {
  const method = (context.request as Request | undefined)?.method ?? 'GET'
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || Boolean(context.user)
}

/** Passes when every one of `permissions` passes. */
export function all(...permissions: Permission[]): Permission {
  return async (context) => {
    for (const permission of permissions) if (!(await permission(context))) return false
    return true
  }
}

/** Passes when any one of `permissions` passes. */
export function any(...permissions: Permission[]): Permission {
  return async (context) => {
    for (const permission of permissions) if (await permission(context)) return true
    return false
  }
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
