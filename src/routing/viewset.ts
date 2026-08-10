/**
 * Model view sets.
 *
 * One declaration produces the six CRUD endpoints, their schemas, their
 * OpenAPI entries, filtering, search, ordering, and pagination — DRF's
 * `ModelViewSet`, expressed as a function that returns a `Router`.
 */

import { t, type TSchema } from 'elysia'
import { Q } from '../db/lookups.ts'
import type { AnyModel, RowOf } from '../db/model.ts'
import type { QuerySet } from '../db/queryset.ts'
import { NotFound, PermissionDenied, Unauthorized } from '../http/errors.ts'
import { pageNumberPagination, type Paginator } from '../http/pagination.ts'
import type { Serializer } from '../serializers/index.ts'
import { Router, type Context, type Permission } from './router.ts'

export type ViewSetAction = 'list' | 'retrieve' | 'create' | 'update' | 'partialUpdate' | 'destroy'

const ALL_ACTIONS: ViewSetAction[] = ['list', 'retrieve', 'create', 'update', 'partialUpdate', 'destroy']

export interface ViewSetHooks<M extends AnyModel> {
  /** Last chance to adjust the payload — stamp an owner, normalise a field. */
  beforeCreate?: (data: Record<string, unknown>, context: Context) => unknown | Promise<unknown>
  afterCreate?: (row: RowOf<M>, context: Context) => unknown | Promise<unknown>
  beforeUpdate?: (
    data: Record<string, unknown>,
    row: RowOf<M>,
    context: Context,
  ) => unknown | Promise<unknown>
  afterUpdate?: (row: RowOf<M>, context: Context) => unknown | Promise<unknown>
  beforeDestroy?: (row: RowOf<M>, context: Context) => unknown | Promise<unknown>
}

export interface ModelViewSetOptions<M extends AnyModel> {
  model: M
  serializer: Serializer<M, any, any>
  /**
   * The base queryset. Called per request, so it can scope rows to the caller:
   * `queryset: (ctx) => Post.objects.filter({ author: ctx.user.id })`.
   */
  queryset?: (context: Context) => QuerySet<M, RowOf<M>>
  /** Field used in the detail URL. Defaults to the primary key. */
  lookupField?: keyof M['fields'] & string
  /** Which endpoints to generate. Defaults to all six. */
  actions?: ViewSetAction[]
  permissions?: Permission[]
  /** Per-action permissions, merged with the viewset-wide ones. */
  actionPermissions?: Partial<Record<ViewSetAction, Permission[]>>
  /**
   * Checked against the object itself, after it is loaded.
   *
   * A `Permission` runs before anything is fetched, so it can only ask about
   * the caller and the URL. This asks about the row: "anyone signed in may read
   * a post, but only its author may edit it" needs both, and neither a
   * permission nor a scoped `queryset` can say it alone — a queryset that hid
   * other people's posts would hide them from readers too.
   *
   * Pass one function to apply it to every detail action, or an object to vary
   * it per action. Failing gives 403, the same as a route permission.
   *
   * When the *existence* of a row is itself confidential, scope `queryset`
   * instead: a 403 confirms the row is there, while an out-of-scope queryset
   * yields an honest 404.
   */
  objectPermissions?: ObjectPermission<M> | Partial<Record<DetailAction, ObjectPermission<M>>>
  /** Fields exposed as query filters — `?status=draft&views__gte=10`. */
  filterFields?: readonly (keyof M['fields'] & string)[]
  /** Fields scanned by `?search=` using a case-insensitive OR. */
  searchFields?: readonly (keyof M['fields'] & string)[]
  /** Fields allowed in `?ordering=-createdAt,title`. */
  orderingFields?: readonly (keyof M['fields'] & string)[]
  /** Foreign keys to join on list and retrieve. */
  selectRelated?: readonly string[]
  /** `false` returns a bare array. Defaults to page-number pagination. */
  pagination?: Paginator | false
  hooks?: ViewSetHooks<M>
  tags?: string[]
}

/**
 * Decides whether the caller may act on this particular row.
 *
 * Async so it can consult the database — object rules often depend on a
 * relation the row does not carry, such as membership of the owning team.
 */
export type ObjectPermission<M extends AnyModel> = (
  object: RowOf<M>,
  context: Context,
) => boolean | Promise<boolean>

/** The actions that address a single row, and so can be judged against one. */
export type DetailAction = Extract<ViewSetAction, 'retrieve' | 'update' | 'partialUpdate' | 'destroy'>

/** Lookups a client may append to a filter field in the query string. */
const QUERY_LOOKUPS = [
  'exact',
  'iexact',
  'ne',
  'in',
  'notIn',
  'isnull',
  'contains',
  'icontains',
  'startswith',
  'istartswith',
  'endswith',
  'iendswith',
  'gt',
  'gte',
  'lt',
  'lte',
] as const

/**
 * Query strings are all strings; the field's kind says what it should become.
 * A value that won't convert is skipped rather than 400ing, so a stray
 * `?views__gte=abc` narrows nothing instead of breaking the page.
 */
function coerce(model: AnyModel, attr: string, lookup: string, raw: string): unknown {
  if (lookup === 'isnull') return raw === 'true' || raw === '1'

  const kind = model.fields[attr]!.spec.kind
  const one = (value: string): unknown => {
    switch (kind) {
      case 'auto':
      case 'bigAuto':
      case 'integer':
      case 'smallInteger':
      case 'bigInteger':
      case 'foreignKey': {
        const parsed = Number.parseInt(value, 10)
        return Number.isNaN(parsed) ? undefined : parsed
      }
      case 'float': {
        const parsed = Number.parseFloat(value)
        return Number.isNaN(parsed) ? undefined : parsed
      }
      case 'boolean':
        return value === 'true' || value === '1'
      case 'date':
      case 'datetime': {
        const parsed = new Date(value)
        return Number.isNaN(parsed.getTime()) ? undefined : parsed
      }
      default:
        return value
    }
  }

  if (lookup === 'in' || lookup === 'notIn') {
    const values = raw.split(',').map(one).filter((value) => value !== undefined)
    return values
  }
  return one(raw)
}

/** Turns the request's query string into a filter object. */
function queryFilters(
  model: AnyModel,
  allowed: readonly string[],
  query: Record<string, unknown>,
): Record<string, unknown> {
  const filters: Record<string, unknown> = {}
  const allowedSet = new Set(allowed)

  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || raw === null || raw === '') continue

    const marker = key.lastIndexOf('__')
    const candidate = marker === -1 ? '' : key.slice(marker + 2)
    const isLookup = (QUERY_LOOKUPS as readonly string[]).includes(candidate)
    const attr = isLookup ? key.slice(0, marker) : key
    const lookup = isLookup ? candidate : 'exact'

    if (!allowedSet.has(attr) || !(attr in model.fields)) continue

    const value = coerce(model, attr, lookup, String(raw))
    if (value === undefined) continue
    filters[isLookup ? key : attr] = value
  }

  return filters
}

/** Validates `?ordering=` against the allow-list, dropping anything unlisted. */
function parseOrdering(raw: unknown, allowed: readonly string[]): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  const allowedSet = new Set(allowed)
  return raw
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '' && allowedSet.has(field.startsWith('-') ? field.slice(1) : field))
}

export function modelViewSet<M extends AnyModel>(options: ModelViewSetOptions<M>): Router {
  const {
    model,
    serializer,
    lookupField = model.pk,
    actions = ALL_ACTIONS,
    permissions = [],
    actionPermissions = {},
    objectPermissions,
    filterFields = [],
    searchFields = [],
    orderingFields = [],
    selectRelated = [],
    hooks = {},
    tags,
  } = options

  const paginator: Paginator | null =
    options.pagination === false ? null : (options.pagination ?? pageNumberPagination())

  const lookupSpec = model.fields[lookupField]
  if (!lookupSpec) {
    throw new Error(`modelViewSet(${model.name}): lookupField "${lookupField}" is not a field.`)
  }
  const lookupIsNumeric = ['auto', 'bigAuto', 'integer', 'bigInteger', 'smallInteger', 'foreignKey'].includes(
    lookupSpec.spec.kind,
  )

  const paramsSchema = t.Object({
    [lookupField]: lookupIsNumeric ? t.Numeric() : t.String(),
  })

  const listQuerySchema = t.Object(
    {
      ...(paginator?.querySchema ?? {}),
      ...(searchFields.length > 0 ? { search: t.Optional(t.String()) } : {}),
      ...(orderingFields.length > 0 ? { ordering: t.Optional(t.String()) } : {}),
      // Filter params are documented loosely: the set of legal keys is
      // field x lookup, which would bloat the OpenAPI document.
      ...Object.fromEntries(filterFields.map((field) => [field, t.Optional(t.String())])),
    },
    { additionalProperties: true },
  )

  const listResponse: TSchema = paginator ? paginator.envelope(serializer.read) : t.Array(serializer.read)

  const baseQueryset = (context: Context): QuerySet<M, RowOf<M>> =>
    options.queryset ? options.queryset(context) : (model.objects.all() as QuerySet<M, RowOf<M>>)

  // Anything the serializer embeds has to be joined, or it would have no data
  // to embed. Doing it here means callers never have to keep the two in sync.
  const joins = [...new Set([...selectRelated, ...serializer.nestedFields])]

  const withRelations = (queryset: QuerySet<M, RowOf<M>>): QuerySet<M, RowOf<M>> =>
    joins.length > 0 ? (queryset.selectRelated(...(joins as never[])) as never) : queryset

  const objectPermissionFor = (action: DetailAction): ObjectPermission<M> | undefined =>
    typeof objectPermissions === 'function' ? objectPermissions : objectPermissions?.[action]

  /**
   * Fetches the object addressed by the URL, or raises 404 — then judges the
   * caller against it.
   *
   * One choke point on purpose: retrieve, update, partial update and destroy
   * all pass through here, so an object rule cannot be enforced on three of
   * them and forgotten on the fourth.
   */
  async function getObject(context: Context, action: DetailAction): Promise<RowOf<M>> {
    const value = (context.params as Record<string, unknown>)[lookupField]
    const row = await withRelations(baseQueryset(context)).getOrNull({ [lookupField]: value } as never)
    if (!row) throw new NotFound(`No ${model.name} matching ${lookupField}=${String(value)}.`)

    const check = objectPermissionFor(action)
    if (check && !(await check(row, context))) {
      // Same distinction the route layer makes: an anonymous caller might
      // succeed after signing in, so telling them to is more useful than 403.
      throw context.user ? new PermissionDenied() : new Unauthorized()
    }

    return row
  }

  const permissionsFor = (action: ViewSetAction): Permission[] => [
    ...permissions,
    ...(actionPermissions[action] ?? []),
  ]

  const routes = new Router()
  const enabled = new Set(actions)

  if (enabled.has('list')) {
    routes.get(
      '/',
      async (context) => {
        let queryset = withRelations(baseQueryset(context))

        const filters = queryFilters(model, filterFields, context.query ?? {})
        if (Object.keys(filters).length > 0) queryset = queryset.filter(filters as never)

        const search = (context.query as Record<string, unknown>)?.search
        if (typeof search === 'string' && search !== '' && searchFields.length > 0) {
          queryset = queryset.filter(
            Q.or(...searchFields.map((field) => ({ [`${field}__icontains`]: search }) as never)) as never,
          )
        }

        const ordering = parseOrdering((context.query as Record<string, unknown>)?.ordering, orderingFields)
        if (ordering.length > 0) queryset = queryset.orderBy(...(ordering as never[]))

        if (!paginator) {
          return serializer.toRepresentationMany(await queryset.execute())
        }

        const page = await paginator.paginate(queryset, {
          query: (context.query ?? {}) as Record<string, string | undefined>,
          url: new URL(context.request.url).pathname + new URL(context.request.url).search,
        })

        return { ...page, results: await serializer.toRepresentationMany(page.results as RowOf<M>[]) }
      },
      {
        query: listQuerySchema,
        response: listResponse,
        permissions: permissionsFor('list'),
        summary: `List ${model.meta.verboseNamePlural}`,
        tags,
        name: `${model.name}-list`,
      },
    )
  }

  if (enabled.has('create')) {
    routes.post(
      '/',
      async (context) => {
        const data = await serializer.toInternal(context.body)
        const patched = (await hooks.beforeCreate?.(data, context)) ?? data
        const created = (await model.objects.create(patched as never)) as RowOf<M>

        // INSERT ... RETURNING can't join, so embedded relations need a read.
        const row =
          joins.length > 0
            ? ((await withRelations(baseQueryset(context)).getOrNull({
                [model.pk]: (created as Record<string, unknown>)[model.pk],
              } as never)) ?? created)
            : created

        await hooks.afterCreate?.(row, context)
        context.set.status = 201
        return serializer.toRepresentation(row)
      },
      {
        body: serializer.write,
        response: { 201: serializer.read },
        permissions: permissionsFor('create'),
        summary: `Create a ${model.meta.verboseName}`,
        tags,
        name: `${model.name}-create`,
      },
    )
  }

  if (enabled.has('retrieve')) {
    routes.get(
      `/:${lookupField}`,
      async (context) => serializer.toRepresentation(await getObject(context, 'retrieve')),
      {
        params: paramsSchema,
        response: serializer.read,
        permissions: permissionsFor('retrieve'),
        summary: `Retrieve a ${model.meta.verboseName}`,
        tags,
        name: `${model.name}-detail`,
      },
    )
  }

  /**
   * PUT and PATCH differ only in whether a missing field is an error. `update()`
   * returns the bare row, so the relations the serializer needs are re-fetched
   * before rendering.
   */
  const writeDetail = (partial: boolean) => async (context: Context) => {
    const existing = await getObject(context, partial ? 'partialUpdate' : 'update')
    const pk = (existing as Record<string, unknown>)[model.pk]
    const data = await serializer.toInternal(context.body, { partial })
    const patched = (await hooks.beforeUpdate?.(data, existing, context)) ?? data

    const updated = await baseQueryset(context)
      .filter({ [model.pk]: pk } as never)
      .update(patched as never)

    const result =
      updated.length > 0 && joins.length > 0
        ? ((await withRelations(baseQueryset(context)).getOrNull({ [model.pk]: pk } as never)) ??
          (updated[0] as RowOf<M>))
        : ((updated[0] ?? existing) as RowOf<M>)

    await hooks.afterUpdate?.(result, context)
    return serializer.toRepresentation(result)
  }

  if (enabled.has('update')) {
    routes.put(`/:${lookupField}`, writeDetail(false), {
      params: paramsSchema,
      body: serializer.write,
      response: serializer.read,
      permissions: permissionsFor('update'),
      summary: `Replace a ${model.meta.verboseName}`,
      tags,
      name: `${model.name}-update`,
    })
  }

  if (enabled.has('partialUpdate')) {
    routes.patch(`/:${lookupField}`, writeDetail(true), {
      params: paramsSchema,
      body: serializer.patch,
      response: serializer.read,
      permissions: permissionsFor('partialUpdate'),
      summary: `Update part of a ${model.meta.verboseName}`,
      tags,
      name: `${model.name}-partial-update`,
    })
  }

  if (enabled.has('destroy')) {
    routes.delete(
      `/:${lookupField}`,
      async (context) => {
        const existing = await getObject(context, 'destroy')
        await hooks.beforeDestroy?.(existing, context)
        await baseQueryset(context)
          .filter({ [model.pk]: (existing as Record<string, unknown>)[model.pk] } as never)
          .delete()
        context.set.status = 204
        return null
      },
      {
        params: paramsSchema,
        permissions: permissionsFor('destroy'),
        summary: `Delete a ${model.meta.verboseName}`,
        tags,
        name: `${model.name}-destroy`,
      },
    )
  }

  return routes
}
