/**
 * Client generation.
 *
 * The important tests here run the generated source rather than inspecting the
 * string: a generator that emits plausible-looking TypeScript which doesn't
 * compile, or compiles but calls the wrong URL, is worse than no generator.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { t } from 'elysia'
import { defineApp } from '../core/app.ts'
import { createApp, projectSpec } from '../core/project.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { router } from '../routing/router.ts'
import { view } from '../routing/view.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { serializer } from '../serializers/index.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'
import { generateClient, methodName, typeOf } from './generate.ts'

const Gizmo = defineModel('genGizmo', {
  fields: {
    name: f.char({ maxLength: 60 }),
    price: f.integer({ default: 0 }),
    status: f.char({ choices: ['draft', 'live'], default: 'draft' }),
    note: f.char({ maxLength: 40, null: true }),
  },
  meta: { tableName: 'gen_gizmos', ordering: ['name'] },
})

const GizmoSerializer = serializer(Gizmo, { name: 'Gizmo', readOnly: ['id'] })

const app = defineApp({
  name: 'gen',
  prefix: '/',
  models: { Gizmo },
  urls: router()
    .get(
      '/ping',
      view({
        response: t.Object({ pong: t.Boolean() }),
        name: 'ping',
        summary: 'Health ping',
        handler: () => ({ pong: true }),
      }),
    )
    .include('/gizmos', modelViewSet({ model: Gizmo, serializer: GizmoSerializer, pagination: false })),
})

const settings = { apps: [app], prefix: '/api', openapi: { title: 'Gen API', version: '3.2.1' } }

let db: TestDatabase
let source: string

beforeAll(async () => {
  db = await testDatabase({ models: [Gizmo] })
  source = generateClient(projectSpec(settings))
})

afterAll(async () => {
  await db.close()
})

describe('type printing', () => {
  test('primitives and nullability', () => {
    expect(typeOf({ type: 'string' })).toBe('string')
    expect(typeOf({ type: 'integer' })).toBe('number')
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null')
  })

  test('enums and literals become unions', () => {
    expect(typeOf({ anyOf: [{ const: 'a' }, { const: 'b' }] })).toBe('"a" | "b"')
    expect(typeOf({ enum: ['x', 'y'] })).toBe('"x" | "y"')
  })

  test('arrays and refs', () => {
    expect(typeOf({ type: 'array', items: { $ref: '#/components/schemas/Gizmo' } })).toBe('Gizmo[]')
    expect(typeOf({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } })).toBe(
      'Array<string | null>',
    )
  })

  test("the coercing numeric union collapses to number", () => {
    // Elysia's t.Numeric serialises as anyOf[string, number] so a query string
    // coerces. On the wire it is always the number; keeping the string branch
    // would make every caller write Number(...).
    const coercing = { anyOf: [{ type: 'string', format: 'numeric' }, { type: 'number' }] }
    expect(typeOf(coercing)).toBe('number')
  })

  test('objects render their fields with optionality', () => {
    const rendered = typeOf({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    })
    expect(rendered).toContain('a: string')
    expect(rendered).toContain('b?: number')
  })
})

describe('method naming', () => {
  test('operationIds become camelCase methods', () => {
    expect(methodName('post-list')).toBe('postList')
    expect(methodName('auth-password-reset-confirm')).toBe('authPasswordResetConfirm')
    expect(methodName('get_api_stats')).toBe('getApiStats')
  })

  test('a leading digit is made a valid identifier', () => {
    expect(methodName('2fa-verify')).toBe('_2faVerify')
  })
})

describe('generated source', () => {
  test('declares an interface per component', () => {
    expect(source).toContain('export interface Gizmo {')
    expect(source).toContain('export interface GizmoInput {')
    expect(source).toContain('status: "draft" | "live"')
    expect(source).toContain('note: string | null')
  })

  test('renames a component that would clash with a name the runtime uses', () => {
    // `Error` is the shared error component; ApiError extends the real one.
    expect(source).toContain('export interface ErrorModel {')
    expect(source).not.toMatch(/^export interface Error \{/m)
  })

  test('emits one method per operation, with docs', () => {
    // Method names come from the route name, which comes from the model name.
    expect(source).toContain('genGizmoList:')
    expect(source).toContain('genGizmoCreate:')
    expect(source).toContain('genGizmoDetail:')
    expect(source).toContain('Health ping')
  })

  test('imports nothing, so it can be dropped into any frontend', () => {
    expect(source).not.toMatch(/^import /m)
    expect(source).not.toContain('angusjs')
  })

  test('a route with no input takes no required argument', () => {
    expect(source).toContain('ping: (input?: Record<string, never>')
  })

  test('paths carry the project prefix, so baseUrl is the origin alone', () => {
    // Getting this backwards yields /api/api/..., so the generated docs say it
    // and this pins it.
    expect(source).toContain('"/api/gizmos"')
    expect(source).toContain('Do **not** include the API prefix')
  })
})

describe('the generated client actually works', () => {
  test('it compiles under strict TypeScript, standalone', async () => {
    const dir = `${import.meta.dir}/../../.client-check`
    await Bun.write(`${dir}/api.ts`, source)
    await Bun.write(
      `${dir}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          lib: ['ESNext', 'DOM'],
          skipLibCheck: true,
        },
      }),
    )

    const proc = Bun.spawn(['bunx', 'tsc', '--noEmit'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    const status = await proc.exited
    const output = await new Response(proc.stdout).text()

    expect(output).not.toContain('error TS')
    expect(status).toBe(0)

    await Bun.$`rm -rf ${dir}`.quiet()
  }, 60_000)

  test('it talks to the real server', async () => {
    const elysia = await createApp(settings, { connectDatabase: false })
    await db.reset()

    // Load the generated module and point its fetch at the in-process app,
    // which exercises URL building, headers, JSON handling and error mapping.
    // Written beside this file so the import path needs no traversal.
    const modulePath = `${import.meta.dir}/generated-live.ts`
    await Bun.write(modulePath, source)
    // Indirected so this stays a runtime concern: the file does not exist
    // until the line above writes it.
    const specifier = './generated-live.ts'
    const { createClient, ApiError } = (await import(specifier)) as any

    // The origin only: generated paths already include the project prefix.
    const api = createClient({
      baseUrl: 'http://test',
      fetch: (request: Request) => elysia.handle(request),
    })

    const created = await api.genGizmoCreate({ body: { name: 'Widget', price: 42, status: 'live' } })
    expect(created.name).toBe('Widget')

    const listed = await api.genGizmoList()
    expect(listed).toHaveLength(1)

    const fetched = await api.genGizmoDetail({ params: { id: created.id } })
    expect(fetched.price).toBe(42)

    // Query parameters reach the server.
    const filtered = await api.genGizmoList({ query: { ordering: 'name' } })
    expect(filtered).toHaveLength(1)

    await api.genGizmoDestroy({ params: { id: created.id } })
    expect(await api.genGizmoList()).toEqual([])

    // A failure carries the error contract rather than a bare string.
    try {
      await api.genGizmoDetail({ params: { id: 999 } })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as any).status).toBe(404)
      expect((error as any).code).toBe('not_found')
      expect((error as any).isClientError).toBe(true)
    }

    await Bun.$`rm -f ${modulePath}`.quiet()
  })
})
