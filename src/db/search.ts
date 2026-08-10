/**
 * Full-text search.
 *
 * Two dialects with genuinely different capabilities, and the difference is
 * worth stating rather than hiding. Postgres has a real text search engine:
 * stemming, stop words, relevance ranking, and a query syntax users already
 * know from search boxes. SQLite, through this path, has `LIKE`.
 *
 * The API is the same on both because the alternative — making applications
 * branch on dialect — pushes the problem onto every caller. What differs is
 * quality, and quality degrades in the direction you would want: a search that
 * finds fewer things on SQLite is a development inconvenience, whereas one that
 * silently found *different* things in production would be a bug.
 */

import { sql, type SQL } from 'drizzle-orm'
import type { AnyModel } from './model.ts'
import type { Dialect } from './schema.ts'

export interface SearchOptions {
  /**
   * Postgres text search configuration — the dictionary that decides stemming
   * and stop words. Defaults to `english`.
   *
   * Ignored on SQLite, which has neither.
   */
  language?: string
  /**
   * Order results by relevance. Defaults to true.
   *
   * Turn it off when the caller's own ordering matters more, such as a feed
   * that must stay chronological.
   */
  rank?: boolean
}

/** How a dialect answers a search, so callers can tell what they are getting. */
export interface SearchCapability {
  /** Stemming, stop words and a real query syntax. */
  fullText: boolean
  /** Relevance ranking. */
  ranking: boolean
  description: string
}

export function searchCapability(dialect: Dialect): SearchCapability {
  return dialect === 'postgres'
    ? {
        fullText: true,
        ranking: true,
        description: 'Postgres full-text search: stemming, stop words, web query syntax and relevance ranking.',
      }
    : {
        fullText: false,
        ranking: true,
        description: 'SQLite substring matching: every term must appear somewhere, ranked by how many fields matched.',
      }
}

/** The columns being searched, as SQL, with nulls treated as empty text. */
function columns(model: AnyModel, table: Record<string, any>, fields: readonly string[]): SQL[] {
  return fields.map((attr) => {
    const column = model.columns[attr]
    if (!column) {
      throw new Error(
        `${model.name} has no field "${attr}" to search. ` +
          `Searchable fields must be declared on the model.`,
      )
    }
    // A null column would make the whole concatenation null, which would
    // silently exclude every row that left one field empty.
    return sql`coalesce(${table[column]}, '')`
  })
}

/**
 * Splits a query into terms for the substring fallback.
 *
 * Quoted phrases are kept whole, because "new york" meaning two independent
 * words is exactly the case the quotes were typed to prevent.
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = []
  const pattern = /"([^"]+)"|(\S+)/g

  let match: RegExpExecArray | null
  while ((match = pattern.exec(query)) !== null) {
    const term = (match[1] ?? match[2] ?? '').trim()
    if (term !== '') terms.push(term)
  }

  return terms
}

/**
 * The WHERE condition for a search.
 *
 * On Postgres this uses `websearch_to_tsquery` rather than `to_tsquery`, which
 * matters more than it looks: `to_tsquery` throws a syntax error on input like
 * `hello world` or a stray quote, so passing a search box straight into it
 * turns ordinary typing into a 500. `websearch_to_tsquery` accepts whatever a
 * person types and understands the conventions they already use — quoted
 * phrases, `or`, and `-` to exclude.
 */
export function searchCondition(
  dialect: Dialect,
  model: AnyModel,
  table: Record<string, any>,
  fields: readonly string[],
  query: string,
  options: SearchOptions = {},
): SQL | null {
  const trimmed = query.trim()
  if (trimmed === '' || fields.length === 0) return null

  const parts = columns(model, table, fields)

  if (dialect === 'postgres') {
    const language = options.language ?? 'english'
    return sql`${vector(parts, language)} @@ websearch_to_tsquery(${language}, ${trimmed})`
  }

  // SQLite: every term must appear in at least one of the fields. AND across
  // terms, OR across fields — the behaviour people expect from a search box,
  // where adding a word narrows rather than widens.
  const terms = searchTerms(trimmed)
  if (terms.length === 0) return null

  const perTerm = terms.map((term) => {
    const escaped = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    const matches = parts.map((part) => sql`lower(${part}) like lower(${escaped}) escape '\\'`)
    return sql`(${joinWith(matches, sql` or `)})`
  })

  return sql`(${joinWith(perTerm, sql` and `)})`
}

/** The relevance expression to order by, descending. */
export function searchRank(
  dialect: Dialect,
  model: AnyModel,
  table: Record<string, any>,
  fields: readonly string[],
  query: string,
  options: SearchOptions = {},
): SQL | null {
  const trimmed = query.trim()
  if (trimmed === '' || fields.length === 0) return null

  const parts = columns(model, table, fields)

  if (dialect === 'postgres') {
    const language = options.language ?? 'english'
    return sql`ts_rank(${vector(parts, language)}, websearch_to_tsquery(${language}, ${trimmed}))`
  }

  // Without a ranking function, count how many of the searched fields matched.
  // Crude, but it reliably puts a row matching title *and* body above one that
  // only matched body, which is most of what ranking is for.
  const terms = searchTerms(trimmed)
  if (terms.length === 0) return null

  const hits = terms.flatMap((term) => {
    const escaped = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    return parts.map(
      (part) => sql`(case when lower(${part}) like lower(${escaped}) escape '\\' then 1 else 0 end)`,
    )
  })

  return sql`(${joinWith(hits, sql` + `)})`
}

/** `to_tsvector` over every searched column joined by spaces. */
function vector(parts: SQL[], language: string): SQL {
  return sql`to_tsvector(${language}, ${joinWith(parts, sql` || ' ' || `)})`
}

/** Drizzle's `sql.join` with a separator, kept local so the intent is visible. */
function joinWith(parts: SQL[], separator: SQL): SQL {
  return parts.reduce((accumulated, part, index) =>
    index === 0 ? part : (sql`${accumulated}${separator}${part}` as SQL),
  ) as SQL
}
