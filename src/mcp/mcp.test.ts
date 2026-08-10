import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Elysia } from 'elysia'
import { defineApp } from '../core/app.ts'
import { createApp } from '../core/project.ts'
import { connect, disconnect, getConnection } from '../db/connection.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { router } from '../routing/router.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { serializer } from '../serializers/index.ts'
import { buildTools } from './tools.ts'

const Crate = defineModel('crate', {
  fields: {
    label: f.char({ maxLength: 60 }),
    weight: f.integer({ default: 1, min: 0 }),
    fragile: f.boolean({ default: false }),
  },
  meta: { ordering: ['label'] },
})

const CrateSerializer = serializer(Crate, { readOnly: ['id'] })

const warehouse = defineApp({
  name: 'warehouse',
  prefix: '/',
  models: { Crate },
  urls: router()
    .get('/hidden', () => ({ secret: true }), { hidden: true, name: 'hidden-thing' })
    .include(
      '/crates',
      modelViewSet({
        model: Crate,
        serializer: CrateSerializer,
        filterFields: ['fragile'],
        searchFields: ['label'],
        tags: ['crates'],
      }),
    ),
})

const settings = { apps: [warehouse], prefix: '/api', openapi: false as const }

let app: Elysia<any, any>

/** Sends a JSON-RPC message the way a legacy client would. */
const rpc = async (message: unknown, headers: Record<string, string> = {}) => {
  const response = await app.handle(
    new Request('http://test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(message),
    }),
  )
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as any) }
}

/** Sends a message with the header set the 2026-07-28 transport requires. */
const modern = async (message: any, extra: Record<string, string> = {}) => {
  const withMeta = {
    ...message,
    params: {
      ...(message.params ?? {}),
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    },
  }
  return rpc(withMeta, {
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': message.method,
    ...(message.params?.name ? { 'Mcp-Name': message.params.name } : {}),
    ...extra,
  })
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

beforeAll(async () => {
  await connect({ dialect: 'sqlite', url: ':memory:' }, [Crate])
  getConnection().client.exec(`
    CREATE TABLE crates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      fragile INTEGER NOT NULL DEFAULT false
    );
  `)
  app = await createApp(settings, { connectDatabase: false })
})

afterAll(async () => {
  await disconnect()
})

beforeEach(async () => {
  getConnection().client.exec("DELETE FROM crates; DELETE FROM sqlite_sequence WHERE name = 'crates';")
  await Crate.objects.bulkCreate([
    { label: 'Apples', weight: 10 },
    { label: 'Bananas', weight: 5, fragile: true },
  ])
})

describe('tool generation', () => {
  const tools = buildTools(router().include('/crates', modelViewSet({ model: Crate, serializer: CrateSerializer })).flatten())

  test('one tool per route, named from the route name', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'crate-list',
      'crate-create',
      'crate-detail',
      'crate-update',
      'crate-partial-update',
      'crate-destroy',
    ])
  })

  test('path parameters are required and top level', () => {
    const detail = tools.find((tool) => tool.name === 'crate-detail')!
    expect(detail.inputSchema.properties).toHaveProperty('id')
    expect(detail.inputSchema.required).toEqual(['id'])
  })

  test('the request body is nested under `body`, avoiding query collisions', () => {
    const create = tools.find((tool) => tool.name === 'crate-create')!
    expect(create.inputSchema.properties).toHaveProperty('body')
    expect(create.inputSchema.required).toEqual(['body'])
  })

  test('query parameters are optional', () => {
    const list = tools.find((tool) => tool.name === 'crate-list')!
    expect(list.inputSchema.properties).toHaveProperty('page')
    expect(list.inputSchema.required).toEqual([])
  })

  test('the schema is closed, so an invented argument fails loudly', () => {
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true)
  })

  test('annotations describe the effect of each method', () => {
    const list = tools.find((tool) => tool.name === 'crate-list')!
    const destroy = tools.find((tool) => tool.name === 'crate-destroy')!
    expect(list.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(destroy.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })

  test('hidden routes never become tools', () => {
    const all = buildTools(warehouse.urls!.flatten())
    expect(all.some((tool) => tool.name === 'hidden-thing')).toBe(false)
  })

  test('readOnly exposes only safe methods', () => {
    const safe = buildTools(warehouse.urls!.flatten(), { readOnly: true })
    expect(safe.every((tool) => tool.route.method === 'get')).toBe(true)
  })

  test('exclude drops named tools', () => {
    const filtered = buildTools(warehouse.urls!.flatten(), { exclude: ['crate-destroy'] })
    expect(filtered.some((tool) => tool.name === 'crate-destroy')).toBe(false)
  })
})

describe('legacy handshake', () => {
  test('initialize echoes a version we speak', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
    })
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.serverInfo.name).toBeDefined()
  })

  test('an unknown legacy version falls back to our newest legacy revision', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    })
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  test('a notification is accepted with 202 and no body', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(status).toBe(202)
    expect(body).toBeNull()
  })
})

describe('modern negotiation', () => {
  test('server/discover reports versions, capabilities and identity', async () => {
    const { body } = await modern({ jsonrpc: '2.0', id: 1, method: 'server/discover' })
    expect(body.result.supportedVersions).toContain('2026-07-28')
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBeDefined()
  })

  test('an unsupported version returns 400 and lists what we do speak', async () => {
    const { status, body } = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'MCP-Protocol-Version': '1900-01-01' },
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe(-32022)
    expect(body.error.data.supported).toContain('2026-07-28')
    expect(body.error.data.requested).toBe('1900-01-01')
  })

  test('a missing Mcp-Method header is a header mismatch', async () => {
    const { status, body } = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      },
      { 'MCP-Protocol-Version': '2026-07-28' },
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe(-32020)
  })

  test('a header and body that disagree about the version are rejected', async () => {
    // Regression: the body used to win, quietly downgrading the request to the
    // legacy era and skipping header validation entirely.
    const { status, body } = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } },
      },
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe(-32020)
  })

  test('an Mcp-Name that disagrees with the body is rejected', async () => {
    const { status, body } = await modern(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'crate-list', arguments: {} } },
      { 'Mcp-Name': 'something-else' },
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe(-32020)
  })

  test('a base64-wrapped Mcp-Name is decoded before comparison', async () => {
    const encoded = `=?base64?${btoa('crate-list')}?=`
    const { status } = await modern(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'crate-list', arguments: {} } },
      { 'Mcp-Name': encoded },
    )
    expect(status).toBe(200)
  })

  test('an unimplemented method returns 404 with a JSON-RPC error', async () => {
    // `prompts/*` is genuinely unimplemented; `resources/*` is not any more.
    const { status, body } = await modern({ jsonrpc: '2.0', id: 1, method: 'prompts/list' })
    expect(status).toBe(404)
    expect(body.error.code).toBe(-32601)
  })
})

describe('tools/list and tools/call', () => {
  test('lists the generated tools', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = body.result.tools.map((tool: any) => tool.name)
    expect(names).toContain('crate-list')
    expect(names).not.toContain('hidden-thing')
  })

  test('a read returns text and structured content', async () => {
    const { body } = await call('crate-list', {})
    expect(body.result.isError).toBe(false)
    expect(body.result.structuredContent.count).toBe(2)
    expect(JSON.parse(body.result.content[0].text).count).toBe(2)
  })

  test('query arguments reach the endpoint', async () => {
    const { body } = await call('crate-list', { search: 'Apples' })
    expect(body.result.structuredContent.count).toBe(1)
  })

  test('a path parameter is substituted', async () => {
    const { body } = await call('crate-detail', { id: 1 })
    expect(body.result.structuredContent.label).toBe('Apples')
  })

  test('a write goes through the real endpoint', async () => {
    const { body } = await call('crate-create', { body: { label: 'Cherries', weight: 3 } })
    expect(body.result.isError).toBe(false)
    expect(await Crate.objects.filter({ label: 'Cherries' }).exists()).toBe(true)
  })

  test('a delete removes the row, once confirmed', async () => {
    const { body } = await call('crate-destroy', { id: 1, confirm: true })
    expect(body.result.isError).toBe(false)
    expect(await Crate.objects.filter({ id: 1 }).exists()).toBe(false)
  })

  test('a delete without confirmation leaves the row alone', async () => {
    const { body } = await call('crate-destroy', { id: 1 })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/without confirmation/i)
    expect(await Crate.objects.filter({ id: 1 }).exists()).toBe(true)
  })
})

describe('error semantics', () => {
  test('an API 404 is a tool error, not a protocol error', async () => {
    const { status, body } = await call('crate-detail', { id: 999 })
    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('404')
  })

  test('validation failures name the offending fields', async () => {
    const { body } = await call('crate-create', { body: {} })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('label')
  })

  test('an unknown tool is a protocol error', async () => {
    const { body } = await call('no-such-tool')
    expect(body.error.code).toBe(-32602)
  })

  test('a missing path parameter is reported as a tool error', async () => {
    const { body } = await call('crate-detail', {})
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('id')
  })
})

describe('transport rules', () => {
  test('a cross-origin POST is refused', async () => {
    const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'http://evil.example' })
    expect(status).toBe(403)
  })

  test('a same-origin POST is allowed', async () => {
    const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'http://test' })
    expect(status).toBe(200)
  })

  test('GET and DELETE are 405 — no SSE stream, no sessions', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await app.handle(new Request('http://test/mcp', { method }))
      expect(response.status).toBe(405)
    }
  })

  test('a malformed message is rejected', async () => {
    const { status, body } = await rpc({ notJsonRpc: true })
    expect(status).toBe(400)
    expect(body.error.code).toBe(-32600)
  })

  test('ping answers', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 7, method: 'ping' })
    expect(body).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })
})

describe('permissions are not bypassed', () => {
  test('a tool inherits the route permission it was generated from', async () => {
    const guarded = defineApp({
      name: 'guarded',
      prefix: '/',
      urls: router().get('/vault', () => ({ gold: true }), {
        permissions: [() => false],
        name: 'vault-read',
      }),
    })
    const guardedApp = await createApp({ apps: [guarded], openapi: false }, { connectDatabase: false })

    const response = await guardedApp.handle(
      new Request('http://test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'vault-read', arguments: {} },
        }),
      }),
    )
    const body = (await response.json()) as any
    // The call reaches the endpoint and is refused there, exactly as HTTP would.
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('401')
  })
})
