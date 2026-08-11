/**
 * A 422 body is what a client renders next to a form field. TypeBox's structural
 * messages ("Expected union value") name the shape, not the rule, so they are
 * reconstructed from the schema's real constraint into something a person acts
 * on.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { serializer } from '../serializers/index.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { describeConstraint, errorTranslation } from './errors.ts'
import { clientFor, testDatabase, type TestDatabase } from '../testing/index.ts'

describe('describeConstraint', () => {
  test('a numeric bound survives the coercing union that hides it', () => {
    // The headline case: `t.Numeric({minimum})` reports "Expected union value",
    // and the real bound is on the wrapper and the number member.
    const schema = { minimum: 0, maximum: 100, anyOf: [{ format: 'numeric', type: 'string' }, { minimum: 0, type: 'number' }] }
    expect(describeConstraint(schema as any, 'Expected union value')).toBe('must be between 0 and 100')
  })

  test('length, format and choices each read plainly', () => {
    expect(describeConstraint({ type: 'string', maxLength: 5 } as any, 'x')).toBe('must be at most 5 characters')
    expect(describeConstraint({ type: 'string', format: 'email' } as any, 'x')).toBe('must be a valid email address')
    expect(describeConstraint({ anyOf: [{ const: 'draft' }, { const: 'live' }] } as any, 'x')).toBe(
      'must be one of: draft, live',
    )
  })

  test('one-sided bounds', () => {
    expect(describeConstraint({ minimum: 1 } as any, 'x')).toBe('must be at least 1')
    expect(describeConstraint({ maximum: 9 } as any, 'x')).toBe('must be at most 9')
    expect(describeConstraint({ minLength: 8 } as any, 'x')).toBe('must be at least 8 characters')
  })

  test('falls back to the original message when nothing legible is there', () => {
    expect(describeConstraint({ type: 'string' } as any, 'Expected string')).toBe('Expected string')
    expect(describeConstraint(undefined, 'Required')).toBe('Required')
  })

  test('the opaque union message alone becomes something rather than noise', () => {
    // A union wrapper with no recoverable constraint still should not ship
    // "Expected union value" to a user.
    expect(describeConstraint({ anyOf: [{ type: 'string' }, { type: 'number' }] } as any, 'Expected union value')).toBe(
      'is not a valid value',
    )
  })
})

describe('over HTTP', () => {
  const Widget = defineModel('vmWidget', {
    fields: {
      name: f.char({ maxLength: 5 }),
      qty: f.integer({ min: 0, max: 100 }),
      email: f.email(),
      status: f.char({ choices: ['active', 'archived'], default: 'active' }),
    },
    meta: { tableName: 'vm_widgets' },
  })

  let db: TestDatabase
  let client: ReturnType<typeof clientFor>
  beforeAll(async () => {
    db = await testDatabase({ models: [Widget] })
    const app: any = new Elysia()
      .use(errorTranslation({ debug: false }))
      .use(modelViewSet({ model: Widget, serializer: serializer(Widget, { readOnly: ['id'] }) }).toElysia({ prefix: '/w' }))
    client = clientFor(app)
  })
  afterAll(async () => { await db.close() })

  test('every field comes back with a message a form can show', async () => {
    const res = await client.post('/w', { name: 'toolong', qty: -3, email: 'nope', status: 'zzz' })
    expect(res.status).toBe(422)
    const errors = (res.body as any).errors

    expect(errors.name).toContain('must be at most 5 characters')
    expect(errors.qty).toContain('must be between 0 and 100')
    expect(errors.email).toContain('must be a valid email address')
    expect(errors.status).toContain('must be one of: active, archived')
  })

  test('no field carries the raw "Expected union value"', async () => {
    const res = await client.post('/w', { name: 'x', qty: -1, email: 'a@b.c' })
    expect(JSON.stringify(res.body)).not.toContain('Expected union value')
  })
})
