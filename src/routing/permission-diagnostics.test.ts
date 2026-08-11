/**
 * A 403 knows which gate closed. The split that matters: the operator and a
 * developer should learn which permission refused; a production client must
 * not, because the name of the gate is a hint to whoever is probing it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { errorTranslation } from '../core/errors.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { serializer } from '../serializers/index.ts'
import { hasRole, hasScope } from '../auth/permissions.ts'
import { isStaff, isAuthenticated } from './router.ts'
import { modelViewSet } from './viewset.ts'
import { clientFor, testDatabase, type TestDatabase } from '../testing/index.ts'

const Doc = defineModel('permDoc', { fields: { title: f.char({ maxLength: 40 }) }, meta: { tableName: 'perm_doc' } })

let db: TestDatabase
beforeAll(async () => { db = await testDatabase({ models: [Doc] }) })
afterAll(async () => { await db.close() })

const build = (debug: boolean, permission: any, user: unknown) => {
  // `.resolve()` widens the Elysia type past clientFor's `Elysia<any, any>`;
  // the cast is at this boundary only.
  const app: any = new Elysia()
    .use(errorTranslation({ debug }))
    .resolve(() => ({ user }))
    .use(modelViewSet({ model: Doc, serializer: serializer(Doc, { readOnly: ['id'] }), permissions: [permission] }).toElysia({ prefix: '/docs' }))
  return clientFor(app)
}

describe('the security split', () => {
  test('development reveals which permission refused', async () => {
    const res = await build(true, isStaff, { id: 1, isStaff: false }).get('/docs')
    expect(res.status).toBe(403)
    expect((res.body as any).deniedBy).toBe('isStaff')
  })

  test('production never reveals it', async () => {
    const res = await build(false, isStaff, { id: 1, isStaff: false }).get('/docs')
    expect(res.status).toBe(403)
    // The gate name is a map for an attacker — the body stays generic.
    expect((res.body as any).deniedBy).toBeUndefined()
    expect((res.body as any).detail).toBe('You do not have permission to perform this action.')
  })

  test('an anonymous caller gets 401, still naming the gate in dev', async () => {
    const res = await build(true, isAuthenticated, null).get('/docs')
    expect(res.status).toBe(401)
    expect((res.body as any).deniedBy).toBe('isAuthenticated')
  })
})

describe('factory permissions name themselves', () => {
  test('hasRole reports the roles it wanted', async () => {
    const res = await build(true, hasRole('editor', 'admin'), { id: 1, roles: ['viewer'] }).get('/docs')
    expect((res.body as any).deniedBy).toBe('hasRole(editor, admin)')
  })

  test('hasScope reports the scope it wanted', async () => {
    const res = await build(true, hasScope('docs:write'), { id: 1 }).get('/docs')
    // No identity resolved here, so it refuses — and says which scope gate.
    expect((res.body as any).deniedBy).toBe('hasScope(docs:write)')
  })
})

describe('an anonymous permission does not fabricate a name', () => {
  test('a bare arrow refuses without a misleading deniedBy', async () => {
    const res = await build(true, () => false, { id: 1 }).get('/docs')
    expect(res.status).toBe(403)
    // Empty name -> omitted, not reported as "denied by ''".
    expect((res.body as any).deniedBy).toBeUndefined()
  })
})
