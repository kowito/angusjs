/**
 * Route permissions decide what the *person* may do. These decide what the
 * agent acting for them may do, which is normally less.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { errorTranslation } from '../core/errors.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { router } from '../routing/router.ts'
import { serializer } from '../serializers/index.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'
import { memoryAuditSink, redact, fingerprint } from './audit.ts'
import { applyPolicy, needsConfirmation, policyTools, CONFIRM_ARGUMENT } from './policy.ts'
import { dispatch, type DispatchContext, type Era } from './protocol.ts'

const MODERN: Era = { modern: true, version: '2026-07-28' }
import { buildTools, type Tool } from './tools.ts'

const Crate = defineModel('policyCrate', {
  fields: { label: f.char({ maxLength: 40 }) },
  meta: { tableName: 'policy_crates' },
})

const CrateSerializer = serializer(Crate, { readOnly: ['id'] })

const routes = router().include('/crates', modelViewSet({ model: Crate, serializer: CrateSerializer }))

let db: TestDatabase
let app: Elysia
let allTools: Tool[]

beforeAll(async () => {
  db = await testDatabase({ models: [Crate] })
  app = new Elysia().use(errorTranslation({ debug: false })).use(routes.toElysia({ prefix: '/api' }))
  allTools = buildTools(routes.flatten().map((route) => ({ ...route, path: `/api${route.path}` })))
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  await Crate.objects.create({ label: 'Apples' })
})

const names = (tools: Tool[]) => tools.map((tool) => tool.name).sort()

describe('exposure', () => {
  test('an allow list is exhaustive', () => {
    const exposed = applyPolicy(allTools, { allow: ['policyCrate-list', 'policyCrate-detail'] })
    expect(names(exposed)).toEqual(['policyCrate-detail', 'policyCrate-list'])
  })

  test('a trailing star grants a whole resource', () => {
    expect(applyPolicy(allTools, { allow: ['policyCrate-*'] }).length).toBe(allTools.length)
  })

  test('deny beats allow, so a broad grant can still carve out the dangerous one', () => {
    const exposed = applyPolicy(allTools, { allow: ['policyCrate-*'], deny: ['policyCrate-destroy'] })
    expect(names(exposed)).not.toContain('policyCrate-destroy')
    expect(names(exposed).length).toBe(allTools.length - 1)
  })

  test('an empty allow list means nothing, not everything', () => {
    // The dangerous misreading: treating an empty list as "unset" would silently
    // grant an agent every tool at the moment its permissions were revoked.
    expect(applyPolicy(allTools, { allow: [] })).toEqual([])
  })

  test('no policy exposes everything', () => {
    expect(applyPolicy(allTools).length).toBe(allTools.length)
  })
})

describe('confirmation', () => {
  test('destructive tools require it by default', () => {
    const destroy = allTools.find((tool) => tool.name === 'policyCrate-destroy')!
    const list = allTools.find((tool) => tool.name === 'policyCrate-list')!

    expect(needsConfirmation(destroy)).toBe(true)
    expect(needsConfirmation(list)).toBe(false)
  })

  test('an explicit list replaces the default rather than adding to it', () => {
    const destroy = allTools.find((tool) => tool.name === 'policyCrate-destroy')!
    const update = allTools.find((tool) => tool.name === 'policyCrate-update')!

    expect(needsConfirmation(update, { confirm: ['policyCrate-update'] })).toBe(true)
    expect(needsConfirmation(destroy, { confirm: ['policyCrate-update'] })).toBe(false)
    expect(needsConfirmation(destroy, { confirm: [] })).toBe(false)
  })

  test('the requirement is in the schema, so every client already supports it', () => {
    const destroy = policyTools(allTools).find((tool) => tool.name === 'policyCrate-destroy')!
    const schema = destroy.inputSchema as { properties: Record<string, unknown>; required: string[] }

    expect(schema.properties[CONFIRM_ARGUMENT]).toBeDefined()
    expect(schema.required).toContain(CONFIRM_ARGUMENT)
    expect(destroy.description).toMatch(/cannot be undone/i)
  })
})

describe('over the protocol', () => {
  const context = (policy = {}, audit?: any): DispatchContext => ({
    app,
    tools: policyTools(allTools, policy),
    policy,
    audit,
    identity: { name: 'test', version: '0' },
    origin: 'http://localhost',
  })

  const call = (context: DispatchContext, name: string, args: Record<string, unknown> = {}) =>
    dispatch(context, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, MODERN) as any

  test('a withheld tool is indistinguishable from one that never existed', async () => {
    // So an agent cannot probe for the shape of what it is not allowed to reach.
    const response = await call(context({ deny: ['policyCrate-destroy'] }), 'policyCrate-destroy', { id: 1 })
    expect(response.error.message).toMatch(/Unknown tool/)
  })

  test('an unconfirmed destructive call never reaches the database', async () => {
    const response = await call(context(), 'policyCrate-destroy', { id: 1 })

    expect(response.result.isError).toBe(true)
    expect(await Crate.objects.count()).toBe(1)
  })

  test('the refusal tells the model what to do rather than just failing', async () => {
    const text = (await call(context(), 'policyCrate-destroy', { id: 1 })).result.content[0].text
    expect(text).toMatch(/confirm/i)
    expect(text).toMatch(/agree/i)
  })

  test('confirmation lets it through', async () => {
    const response = await call(context(), 'policyCrate-destroy', { id: 1, confirm: true })
    expect(response.result.isError).toBe(false)
    expect(await Crate.objects.count()).toBe(0)
  })

  test('confirm is not forwarded to the API as a query parameter', async () => {
    // It is a control on the agent, not an argument of the endpoint.
    const response = await call(context(), 'policyCrate-destroy', { id: 1, confirm: true })
    expect(response.result.isError).toBe(false)
  })

  test('a refusal is reported to the host', async () => {
    const refusals: string[] = []
    await call(context({ onRefusal: (r: any) => refusals.push(r.reason) }), 'policyCrate-destroy', { id: 1 })
    expect(refusals).toEqual(['unconfirmed'])
  })
})

describe('audit log', () => {
  const context = (audit: any, policy = {}): DispatchContext => ({
    app,
    tools: policyTools(allTools, policy),
    policy,
    audit,
    identity: { name: 'test', version: '0' },
    origin: 'http://localhost',
  })

  const call = (context: DispatchContext, name: string, args: Record<string, unknown> = {}) =>
    dispatch(context, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, MODERN) as any

  test('records the tool, not just the request it produced', async () => {
    const sink = memoryAuditSink()
    await call(context(sink), 'policyCrate-list')

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]!.tool).toBe('policyCrate-list')
    expect(sink.events[0]!.outcome).toBe('ok')
    expect(sink.events[0]!.status).toBe(200)
  })

  test('records a refusal, which no access log would ever see', async () => {
    const sink = memoryAuditSink()
    await call(context(sink), 'policyCrate-destroy', { id: 1 })

    expect(sink.events[0]!.outcome).toBe('refused')
    expect(sink.events[0]!.status).toBeNull()
  })

  test('records an API failure with the status', async () => {
    const sink = memoryAuditSink()
    await call(context(sink), 'policyCrate-detail', { id: 9999 })

    expect(sink.events[0]!.outcome).toBe('error')
    expect(sink.events[0]!.status).toBe(404)
  })

  test('records the arguments the model chose', async () => {
    const sink = memoryAuditSink()
    await call(context(sink), 'policyCrate-create', { body: { label: 'Pears' } })

    expect((sink.events[0]!.args.body as any).label).toBe('Pears')
  })

  test('a sink that throws does not take the call down with it', async () => {
    const response = await call(
      context(() => {
        throw new Error('log volume exceeded')
      }),
      'policyCrate-list',
    )

    // A logging outage is not a reason to stop serving.
    expect(response.result.isError).toBe(false)
  })

  test('keeps only the most recent events in memory', async () => {
    const sink = memoryAuditSink(2)
    const ctx = context(sink)
    await call(ctx, 'policyCrate-list')
    await call(ctx, 'policyCrate-list')
    await call(ctx, 'policyCrate-list')

    expect(sink.events).toHaveLength(2)
  })
})

describe('redaction', () => {
  test('drops secret-looking values, keeping the key so the shape is still readable', () => {
    const out = redact({ email: 'a@b.c', password: 'hunter2', apiKey: 'sk-live-1', nested: { token: 'x' } }) as any

    expect(out.email).toBe('a@b.c')
    expect(out.password).toBe('[redacted]')
    expect(out.apiKey).toBe('[redacted]')
    expect(out.nested.token).toBe('[redacted]')
  })

  test('trims values too large to be worth logging', () => {
    expect(redact({ body: 'x'.repeat(2000) } as any) as any).toHaveProperty('body', expect.stringContaining('2000 chars'))
    expect((redact(Array.from({ length: 50 }, (_, i) => i)) as unknown[]).length).toBe(21)
  })

  test('does not recurse forever on a deep structure', () => {
    let deep: any = 'bottom'
    for (let i = 0; i < 20; i++) deep = { next: deep }
    expect(() => redact(deep)).not.toThrow()
  })
})

describe('actor fingerprint', () => {
  test('identifies the caller without storing their credential', () => {
    const headers = new Headers({ authorization: 'Bearer secret-token-value' })
    const actor = fingerprint(headers)!

    // Stable enough to group a session's calls, useless to whoever reads the log.
    expect(actor).toMatch(/^agent:[0-9a-f]{12}$/)
    expect(actor).not.toContain('secret-token-value')
    expect(fingerprint(headers)).toBe(actor)
  })

  test('an anonymous call is recorded as such rather than invented', () => {
    expect(fingerprint(new Headers())).toBeNull()
  })
})
