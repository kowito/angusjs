/**
 * A view set validates every field it names the moment it is built. The failure
 * this prevents is the quiet one: `searchFields: ['titel']` makes `?search=` do
 * nothing, and the developer concludes search is broken rather than misspelled.
 */

import { describe, expect, test } from 'bun:test'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { serializer } from '../serializers/index.ts'
import { modelViewSet } from './viewset.ts'

const Post = defineModel('vvPost', {
  fields: {
    title: f.char({ maxLength: 80 }),
    body: f.text({ blank: true, default: '' }),
    views: f.integer({ default: 0 }),
    author: f.foreignKey(() => Author),
  },
  meta: { tableName: 'vv_posts' },
})

const Author = defineModel('vvAuthor', { fields: { name: f.char({ maxLength: 40 }) }, meta: { tableName: 'vv_authors' } })

const build = (options: any) => () => modelViewSet({ model: Post, serializer: serializer(Post, { readOnly: ['id'] }), ...options })

describe('field references are checked at construction', () => {
  test('a mistyped searchField throws, and names the field', () => {
    expect(build({ searchFields: ['titel'] })).toThrow(/searchFields names "titel"/)
  })

  test('the error suggests the field that was meant', () => {
    expect(build({ searchFields: ['titel'] })).toThrow(/Did you mean "title"\?/)
  })

  test('filterFields and orderingFields are checked the same way', () => {
    expect(build({ filterFields: ['viewz'] })).toThrow(/filterFields names "viewz".*Did you mean "views"/s)
    expect(build({ orderingFields: ['ttitle'] })).toThrow(/orderingFields names "ttitle"/)
  })

  test('a mistyped lookupField suggests the real one', () => {
    expect(build({ lookupField: 'titl' })).toThrow(/lookupField "titl".*Did you mean "title"/s)
  })
})

describe('selectRelated must name a relation', () => {
  test('a non-existent field throws', () => {
    expect(build({ selectRelated: ['auther'] })).toThrow(/selectRelated names "auther".*Did you mean "author"/s)
  })

  test('a real field that is not a foreign key is rejected', () => {
    // This is the one the type checker cannot catch — selectRelated is string[].
    // Joining on `title` is meaningless and would silently do nothing.
    expect(build({ selectRelated: ['title'] })).toThrow(/not a foreign key/)
  })

  test('an actual foreign key is accepted', () => {
    expect(build({ selectRelated: ['author'] })).not.toThrow()
  })
})

describe('valid configurations are untouched', () => {
  test('correct field names build without complaint', () => {
    expect(
      build({
        filterFields: ['views', 'author'],
        searchFields: ['title', 'body'],
        orderingFields: ['views', 'title'],
        selectRelated: ['author'],
        lookupField: 'title',
      }),
    ).not.toThrow()
  })

  test('an empty configuration is fine', () => {
    expect(build({})).not.toThrow()
  })
})
