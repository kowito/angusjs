---
title: Search
section: Building
order: 5
---

# Search

```ts
await Post.objects.search('coastal erosion', ['title', 'body'])
```

A view set with `searchFields` gets the same thing on `?search=`.

## What each database gives you

| | Postgres | SQLite |
| --- | --- | --- |
| Matching | Full text, stemmed | Substring |
| Stop words | Yes | No |
| Quoted phrases | Yes | Yes |
| `-` exclusion | Yes | No |
| Ranking | `ts_rank` relevance | Count of matching fields |

The API is identical on both, deliberately. Making callers branch on dialect pushes the problem outward to every place that searches, and the quality gap degrades in the direction you want: finding fewer things in development is an inconvenience, whereas silently finding *different* things in production would be a bug.

```ts
searchCapability(dialect)   // says plainly which you are getting
```

## Ranking

Relevance leads the ordering, and any explicit ordering breaks ties beneath it — a search ordered by date first is not a search. A caller's own `?ordering=` still wins, because that is them asking for something specific.

```ts
Post.objects.search(query, ['title'], { rank: false })   // keep chronological
```

## Why `websearch_to_tsquery`

Postgres offers two query parsers, and the choice decides whether this is usable at all. `to_tsquery` raises a syntax error on input as ordinary as `hello world` or one unbalanced quote — wire a search box to it and typing produces a 500.

`websearch_to_tsquery` accepts whatever a person types and understands the conventions they already use.

## The fallback's details

Three things the SQLite path gets right that a naive `LIKE` would not:

- Columns are coalesced. A null field would make the concatenation null and silently drop the row.
- `%` and `_` in user input are escaped. Otherwise searching for `100%` matches everything.
- Terms are ANDed while fields are ORed, so adding a word narrows the results the way a search box should.
