/**
 * Pagination strategies for list endpoints.
 *
 * A paginator turns a QuerySet plus the request's query string into a page of
 * rows and the envelope that describes it.
 */

import { t, type TSchema } from 'elysia'
import type { QuerySet } from '../db/queryset.ts'
import type { AnyModel } from '../db/model.ts'

export interface Page<T> {
  results: T[]
  count: number
  next: string | null
  previous: string | null
}

export interface PaginationContext {
  /** Parsed query string. */
  query: Record<string, string | undefined>
  /** The request URL, used to build `next`/`previous`. */
  url: string
}

export interface Paginator {
  readonly name: string
  /** Extra query parameters to document and validate. */
  readonly querySchema: Record<string, TSchema>
  paginate<M extends AnyModel, R>(queryset: QuerySet<M, R>, context: PaginationContext): Promise<Page<R>>
  /** Wraps the page in its response envelope. */
  envelope<T extends TSchema>(itemSchema: T): TSchema
}

function withParam(url: string, key: string, value: string | number): string {
  const parsed = new URL(url, 'http://placeholder')
  parsed.searchParams.set(key, String(value))
  return `${parsed.pathname}${parsed.search}`
}

const envelopeSchema = <T extends TSchema>(itemSchema: T): TSchema =>
  t.Object({
    count: t.Integer(),
    next: t.Union([t.String(), t.Null()]),
    previous: t.Union([t.String(), t.Null()]),
    results: t.Array(itemSchema),
  })

/**
 * `?page=2&pageSize=50`. The familiar default.
 */
export function pageNumberPagination(options: { pageSize?: number; maxPageSize?: number } = {}): Paginator {
  const defaultSize = options.pageSize ?? 25
  const maxSize = options.maxPageSize ?? 100

  return {
    name: 'page-number',
    querySchema: {
      page: t.Optional(t.Numeric({ minimum: 1, default: 1 })),
      pageSize: t.Optional(t.Numeric({ minimum: 1, maximum: maxSize, default: defaultSize })),
    },
    envelope: envelopeSchema,

    async paginate(queryset, context) {
      const page = Math.max(1, Number(context.query.page ?? 1) || 1)
      const size = Math.min(maxSize, Math.max(1, Number(context.query.pageSize ?? defaultSize) || defaultSize))

      // One count and one page; `count` ignores limit/offset by design.
      const [count, results] = await Promise.all([
        queryset.count(),
        queryset.limit(size).offset((page - 1) * size).execute(),
      ])

      const lastPage = Math.max(1, Math.ceil(count / size))
      return {
        results,
        count,
        next: page < lastPage ? withParam(context.url, 'page', page + 1) : null,
        previous: page > 1 ? withParam(context.url, 'page', page - 1) : null,
      }
    },
  }
}

/**
 * `?limit=50&offset=100`. Better when clients page through a changing list.
 */
export function limitOffsetPagination(options: { limit?: number; maxLimit?: number } = {}): Paginator {
  const defaultLimit = options.limit ?? 25
  const maxLimit = options.maxLimit ?? 100

  return {
    name: 'limit-offset',
    querySchema: {
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: maxLimit, default: defaultLimit })),
      offset: t.Optional(t.Numeric({ minimum: 0, default: 0 })),
    },
    envelope: envelopeSchema,

    async paginate(queryset, context) {
      const limit = Math.min(maxLimit, Math.max(1, Number(context.query.limit ?? defaultLimit) || defaultLimit))
      const offset = Math.max(0, Number(context.query.offset ?? 0) || 0)

      const [count, results] = await Promise.all([
        queryset.count(),
        queryset.limit(limit).offset(offset).execute(),
      ])

      return {
        results,
        count,
        next: offset + limit < count ? withParam(context.url, 'offset', offset + limit) : null,
        previous: offset > 0 ? withParam(context.url, 'offset', Math.max(0, offset - limit)) : null,
      }
    },
  }
}

/** Returns every row in a bare array. Fine for small, bounded collections. */
export function noPagination(): Paginator {
  return {
    name: 'none',
    querySchema: {},
    envelope: (itemSchema) => t.Array(itemSchema),
    async paginate(queryset) {
      const results = await queryset.execute()
      return { results, count: results.length, next: null, previous: null }
    },
  }
}
