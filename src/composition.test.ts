/**
 * Angus composes with Elysia; it does not replace it.
 *
 * These tests exist because the README makes that claim on its first screen.
 * A router is a plain data structure that compiles to an Elysia instance, so
 * any piece of Angus can be dropped into an application you already own —
 * without adopting settings, apps, or the CLI.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import { connect, disconnect, getConnection } from './db/connection.ts'
import { DoesNotExist } from './db/errors.ts'
import { f } from './db/fields.ts'
import { defineModel } from './db/model.ts'
import { router } from './routing/router.ts'
import { modelViewSet } from './routing/viewset.ts'
import { serializer } from './serializers/index.ts'

const Widget = defineModel('widget', {
  fields: {
    name: f.char({ maxLength: 60 }),
    price: f.integer({ default: 0, min: 0 }),
  },
  meta: { ordering: ['name'] },
})

const WidgetSerializer = serializer(Widget, { readOnly: ['id'] })

beforeAll(async () => {
  await connect({ dialect: 'sqlite', url: ':memory:' }, [Widget])
  getConnection().client.exec(`
    CREATE TABLE widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0
    );
  `)
  await Widget.objects.bulkCreate([{ name: 'Anvil', price: 10 }, { name: 'Bolt', price: 2 }])
})

afterAll(async () => {
  await disconnect()
})

describe('dropping Angus into an Elysia app you already own', () => {
  test('a view set mounts alongside ordinary Elysia routes', async () => {
    const app = new Elysia()
      // Your own routes, written the ordinary Elysia way.
      .get('/health', () => ({ status: 'ok' }))
      // An Angus view set, compiled to an Elysia instance and mounted.
      .use(modelViewSet({ model: Widget, serializer: WidgetSerializer, pagination: false }).toElysia({ prefix: '/widgets' }))

    const health = await app.handle(new Request('http://test/health'))
    expect(await health.json()).toEqual({ status: 'ok' })

    const list = await app.handle(new Request('http://test/widgets'))
    expect(((await list.json()) as unknown[]).length).toBe(2)
  })

  test('Elysia validation and lifecycle hooks still apply', async () => {
    let seen = 0

    const app = new Elysia()
      .onRequest(() => {
        seen++
      })
      .get('/echo/:n', ({ params }) => ({ n: params.n }), { params: t.Object({ n: t.Numeric() }) })
      .use(modelViewSet({ model: Widget, serializer: WidgetSerializer, pagination: false }).toElysia({ prefix: '/widgets' }))

    // The hook fires for Angus routes as well as hand-written ones, because
    // they are the same Elysia instance.
    await app.handle(new Request('http://test/widgets'))
    await app.handle(new Request('http://test/echo/3'))
    expect(seen).toBe(2)

    const bad = await app.handle(new Request('http://test/echo/abc'))
    expect(bad.status).toBe(422)
  })

  test('an Angus router can carry hand-written handlers too', async () => {
    const mixed = router()
      .get('/ping', () => ({ pong: true }))
      .include('/widgets', modelViewSet({ model: Widget, serializer: WidgetSerializer, pagination: false }))

    const app = new Elysia().use(mixed.toElysia({ prefix: '/api' }))

    expect(await (await app.handle(new Request('http://test/api/ping'))).json()).toEqual({ pong: true })
    expect((await app.handle(new Request('http://test/api/widgets'))).status).toBe(200)
  })

  test('the ORM works with no Elysia involved at all', async () => {
    // Nothing here touches HTTP: the model layer stands on its own, so it can
    // back a queue worker, a script, or a WebSocket handler.
    const cheap = await Widget.objects.filter({ price__lte: 5 })
    expect(cheap.map((widget) => widget.name)).toEqual(['Bolt'])
  })

  test('routes are inspectable before any server exists', async () => {
    const routes = router()
      .include('/widgets', modelViewSet({ model: Widget, serializer: WidgetSerializer }))
      .flatten('/api')

    expect(routes.map((route) => `${route.method.toUpperCase()} ${route.path}`)).toContain('GET /api/widgets/:id')
  })
})

describe('the plugin surface', () => {
  test('angus() installs error translation into an app you own', async () => {
    const { angus, mount } = await import('./plugin.ts')

    const app = new Elysia()
      .use(angus())
      .get('/boom', () => {
        // A DoesNotExist from the ORM must become a 404 even though this app
        // never went near createApp().
        throw new DoesNotExist('widget')
      })
      .use(mount('/widgets', router().include('/', modelViewSet({ model: Widget, serializer: WidgetSerializer, pagination: false }))))

    const failed = await app.handle(new Request('http://test/boom'))
    expect(failed.status).toBe(404)
    expect(((await failed.json()) as any).code).toBe('not_found')

    expect((await app.handle(new Request('http://test/widgets'))).status).toBe(200)
  })

  test('openapi() documents routers without a project', async () => {
    const { openapi } = await import('./plugin.ts')
    const routes = router().include('/widgets', modelViewSet({ model: Widget, serializer: WidgetSerializer }))
    const app = new Elysia().use(openapi([routes], { title: 'Standalone', version: '9.9.9' }))

    const spec = (await (await app.handle(new Request('http://test/openapi.json'))).json()) as any
    expect(spec.info.title).toBe('Standalone')
    expect(spec.paths['/widgets']).toBeDefined()

    expect((await app.handle(new Request('http://test/docs'))).status).toBe(200)
  })

  test('mcp() exposes routers as tools without a project', async () => {
    const { angus, mcp, mount } = await import('./plugin.ts')
    const routes = router().include('/widgets', modelViewSet({ model: Widget, serializer: WidgetSerializer, pagination: false }))

    let self: Elysia<any, any>
    const app = new Elysia()
      .use(angus())
      .use(mount('', routes))
      .use(mcp([routes], () => self, { name: 'standalone' }))
    self = app

    const response = await app.handle(
      new Request('http://test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    const body = (await response.json()) as any
    expect(body.result.tools.map((tool: any) => tool.name)).toContain('widget-list')
  })
})
