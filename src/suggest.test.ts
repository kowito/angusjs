/**
 * A suggestion is only worth making if it is probably right. A confident wrong
 * "did you mean" is more annoying than silence, so these tests pin both the
 * hits and — just as importantly — the misses.
 */

import { describe, expect, test } from 'bun:test'
import { didYouMean, editDistance, nearest } from './suggest.ts'

describe('editDistance', () => {
  test('counts single insert, delete and substitute as one', () => {
    expect(editDistance('migrat', 'migrate')).toBe(1) // insert
    expect(editDistance('routess', 'routes')).toBe(1) // delete
    expect(editDistance('viewz', 'views')).toBe(1) // substitute
  })

  test('an adjacent transposition is one edit, not two', () => {
    // The reason this is Damerau and not plain Levenshtein — a swapped pair is
    // the commonest typo, and plain scoring pushes it out of range.
    expect(editDistance('titel', 'title')).toBe(1)
    expect(editDistance('recieve', 'receive')).toBe(1)
  })

  test('identical strings are zero', () => {
    expect(editDistance('same', 'same')).toBe(0)
  })

  test('the bound lets a far comparison bail early without lying about being close', () => {
    // Past the bound the exact number is irrelevant; it must just read as "far".
    expect(editDistance('completely', 'different', 2)).toBeGreaterThan(2)
  })
})

describe('nearest', () => {
  const commands = ['migrate', 'makemigrations', 'seed', 'runserver', 'routes', 'shell']

  test('finds a close command', () => {
    expect(nearest('migrat', commands)).toBe('migrate')
    expect(nearest('route', commands)).toBe('routes')
  })

  test('returns null when nothing is plausibly close', () => {
    // `serer` is distance 2 from `seed` — the old, looser threshold suggested
    // it, which was worse than useless.
    expect(nearest('serer', commands)).toBeNull()
    expect(nearest('xyzzy', commands)).toBeNull()
  })

  test('prefers the closest of several candidates', () => {
    expect(nearest('migrte', commands)).toBe('migrate')
  })

  test('an exact match returns itself', () => {
    expect(nearest('shell', commands)).toBe('shell')
  })
})

describe('didYouMean', () => {
  test('produces an appendable clause on a hit', () => {
    expect(didYouMean('titel', ['title', 'body'])).toBe(' Did you mean "title"?')
  })

  test('is empty on a miss, so a caller can always concatenate it', () => {
    expect(didYouMean('zzzzz', ['title', 'body'])).toBe('')
  })
})
