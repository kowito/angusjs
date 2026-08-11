/**
 * Routers.
 *
 * A router is a declarative list of routes — it holds no Elysia instance until
 * `toElysia()` is called. That indirection is what lets `angus routes` print
 * the URL table without booting a server, and lets apps be composed under a
 * prefix the way Django's `include()` works.
 */

import { Elysia, type TSchema } from 'elysia'
import { APIError, PermissionDenied, Unauthorized } from '../http/errors.ts'
import { isViewDefinition, type ViewDefinition } from './view.ts'

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options'

/** Whatever Elysia hands the handler, plus anything middleware derived onto it. */
export type Context = Record<string, any>

export type Handler = (context: Context) => unknown | Promise<unknown>

/**
 * Returns true to allow the request. Returning false raises 403 — or 401 when
 * the request was unauthenticated, since that's the more useful signal.
 */
export type Permission = (context: Context) => boolean | Promise<boolean>

export interface RouteSchema {
  body?: TSchema
  query?: TSchema
  params?: TSchema
  headers?: TSchema
  response?: TSchema | Record<number, TSchema>
}

export interface RouteOptions extends RouteSchema {
  /** All must pass. Evaluated before the handler runs. */
  permissions?: Permission[]
  summary?: string
  description?: string
  tags?: string[]
  /** Route name, for reverse lookup — `reverse('post-detail', { id: 3 })`. */
  name?: string
  /** Hidden from the generated OpenAPI document. */
  hidden?: boolean
}

export interface RouteDefinition extends RouteOptions {
  method: HttpMethod
  path: string
  handler: Handler
}

interface Mounted {
  prefix: string
  router: Router
}

/** Joins path segments without doubling or dropping slashes. */
export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((part) => part && part !== '/')
    .map((part) => (part.startsWith('/') ? part : `/${part}`))
    .map((part) => (part.endsWith('/') && part.length > 1 ? part.slice(0, -1) : part))
    .join('')
  return joined === '' ? '/' : joined
}

export class Router {
  readonly routes: RouteDefinition[] = []
  readonly mounted: Mounted[] = []
  readonly plugins: Elysia<any, any>[] = []
  private readonly sharedPermissions: Permission[] = []

  /** Applies these permissions to every route on this router and its children. */
  permissions(...permissions: Permission[]): this {
    this.sharedPermissions.push(...permissions)
    return this
  }

  /** Mounts a raw Elysia plugin — cookies, CORS, anything from the ecosystem. */
  use(plugin: Elysia<any, any>): this {
    this.plugins.push(plugin)
    return this
  }

  /** Accepts either a bare function or a `view()` definition carrying its schema. */
  add(method: HttpMethod, path: string, handler: Handler | ViewDefinition, options: RouteOptions = {}): this {
    const route = isViewDefinition(handler)
      ? { ...handler, ...options, permissions: [...(handler.permissions ?? []), ...(options.permissions ?? [])] }
      : { ...options, handler }
    this.routes.push({ ...route, method, path } as RouteDefinition)
    return this
  }

  get(path: string, handler: Handler | ViewDefinition, options?: RouteOptions): this {
    return this.add('get', path, handler, options)
  }

  post(path: string, handler: Handler | ViewDefinition, options?: RouteOptions): this {
    return this.add('post', path, handler, options)
  }

  put(path: string, handler: Handler | ViewDefinition, options?: RouteOptions): this {
    return this.add('put', path, handler, options)
  }

  patch(path: string, handler: Handler | ViewDefinition, options?: RouteOptions): this {
    return this.add('patch', path, handler, options)
  }

  delete(path: string, handler: Handler | ViewDefinition, options?: RouteOptions): this {
    return this.add('delete', path, handler, options)
  }

  /** Django's `include()` — mounts another router under a prefix. */
  include(prefix: string, router: Router): this {
    this.mounted.push({ prefix, router })
    return this
  }

  /** Every route, flattened, with prefixes applied. Used by `angus routes`. */
  flatten(prefix = ''): RouteDefinition[] {
    const own = this.routes.map((route) => ({
      ...route,
      path: joinPath(prefix, route.path),
      permissions: [...this.sharedPermissions, ...(route.permissions ?? [])],
    }))
    const nested = this.mounted.flatMap(({ prefix: childPrefix, router }) =>
      router.flatten(joinPath(prefix, childPrefix)).map((route) => ({
        ...route,
        permissions: [...this.sharedPermissions, ...(route.permissions ?? [])],
      })),
    )
    return [...own, ...nested]
  }

  /**
   * Compiles to an Elysia instance.
   *
   * Routes are flattened first so a single instance carries them all — nesting
   * Elysia instances would re-derive middleware at each level.
   */
  toElysia(options: { prefix?: string; name?: string } = {}): Elysia<any, any> {
    const app = new Elysia({ name: options.name })

    for (const plugin of this.collectPlugins()) app.use(plugin)

    for (const route of this.flatten(options.prefix ?? '')) {
      const permissions = route.permissions ?? []

      const handler = async (context: Context) => {
        for (const permission of permissions) {
          let allowed: boolean
          try {
            allowed = await permission(context)
          } catch (error) {
            // A permission may throw a Response to short-circuit with something
            // other than an error — a browser redirect to a login page, say.
            if (error instanceof Response) return error
            throw error
          }
          if (!allowed) {
            // The permission that refused is right here; naming it turns an
            // opaque 403 into "isStaff denied this" during development. A
            // production body never sees it — that name is a map of the gate.
            const deniedBy = permission.name || undefined
            throw context.user
              ? new PermissionDenied(undefined, deniedBy)
              : new Unauthorized(undefined, deniedBy)
          }
        }
        return route.handler(context)
      }

      app.route(route.method.toUpperCase() as never, route.path, handler as never, {
        body: route.body,
        query: route.query,
        params: route.params,
        headers: route.headers,
        response: route.response,
        detail: route.hidden
          ? { hide: true }
          : {
              summary: route.summary,
              description: route.description,
              tags: route.tags,
            },
      } as never)
    }

    return app
  }

  private collectPlugins(): Elysia<any, any>[] {
    return [...this.plugins, ...this.mounted.flatMap(({ router }) => router.collectPlugins())]
  }
}

/** Starts a new router. */
export function router(): Router {
  return new Router()
}

// ---------------------------------------------------------------------------
// Built-in permissions
// ---------------------------------------------------------------------------

export const allowAny: Permission = () => true

export const isAuthenticated: Permission = (context) => Boolean(context.user)

/**
 * A staff member, or a superuser — a superuser can do everything a staff member
 * can, so denying one that is not separately flagged staff is a trap. This is
 * the single canonical `isStaff`; `angusjs/auth` re-exports it rather than
 * shipping a second one that behaves differently.
 */
export const isStaff: Permission = (context) => {
  const user = context.user as { isStaff?: unknown; isSuperuser?: unknown } | null | undefined
  return Boolean(user && (user.isStaff || user.isSuperuser))
}

/** Read-only for anonymous callers, full access once authenticated. */
export const readOnlyOrAuthenticated: Permission = (context) => {
  const method = context.request?.method ?? 'GET'
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || Boolean(context.user)
}

/** Inverts a permission. */
export function not(permission: Permission): Permission {
  return async (context) => !(await permission(context))
}

/** Sets a function's name so a permission denial can report which gate refused. */
function named(name: string, permission: Permission): Permission {
  Object.defineProperty(permission, 'name', { value: name, configurable: true })
  return permission
}

/** Passes only when every one of the given permissions passes (logical AND). */
export function all(...permissions: Permission[]): Permission {
  return named(`all(${permissions.map((p) => p.name || '?').join(', ')})`, async (context) => {
    for (const permission of permissions) if (!(await permission(context))) return false
    return true
  })
}

/** Passes when any of the given permissions passes (logical OR). */
export function any(...permissions: Permission[]): Permission {
  return named(`any(${permissions.map((p) => p.name || '?').join(', ')})`, async (context) => {
    for (const permission of permissions) if (await permission(context)) return true
    return false
  })
}

/** @deprecated Use {@link any}. Kept as an alias so existing code keeps working. */
export const either = any

export { APIError }
