/**
 * Application services, exercised through every surface that reads them —
 * direct calls, REST, OpenAPI and MCP — to prove they cannot diverge.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { t } from 'elysia'
import { defineApp } from '../core/app.ts'
import { createApp, projectSpec, projectTools } from '../core/project.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { NotFound } from '../http/errors.ts'
import { router } from '../routing/router.ts'
import { serializer } from '../serializers/index.ts'
import { clientFor, testDatabase, type TestClient, type TestDatabase } from '../testing/index.ts'
import { callService, service } from './index.ts'
import { fromService } from './route.ts'

const Invoice = defineModel('invoice', {
  fields: {
    reference: f.char({ maxLength: 40, unique: true }),
    amount: f.integer({ min: 0 }),
    status: f.char({ choices: ['draft', 'approved', 'refunded'], default: 'draft' }),
  },
  meta: { ordering: ['reference'] },
})

const InvoiceSerializer = serializer(Invoice, { readOnly: ['id'] })

const isStaff = (context: Record<string, any>) => Boolean(context.user?.isStaff)

/** A domain action, not CRUD: it has a rule and it writes twice. */
const approveInvoice = service({
  name: 'approve-invoice',
  summary: 'Approve a draft invoice',
  input: t.Object({ invoiceId: t.Numeric(), note: t.Optional(t.String()) }),
  output: InvoiceSerializer.read,
  permissions: [isStaff],
  tags: ['invoices'],
  async handler({ input }) {
    const invoice = await Invoice.objects.getOrNull({ id: input.invoiceId })
    if (!invoice) throw new NotFound(`No invoice ${input.invoiceId}.`)
    if (invoice.status !== 'draft') throw new Error(`Invoice ${invoice.reference} is not a draft.`)

    const [updated] = await Invoice.objects.filter({ id: invoice.id }).update({ status: 'approved' })
    return InvoiceSerializer.toRepresentation(updated!)
  },
})

/** Writes twice and then fails, to prove the transaction boundary. */
const brokenBatch = service({
  name: 'broken-batch',
  input: t.Object({}),
  async handler() {
    await Invoice.objects.create({ reference: 'batch-1', amount: 1 })
    await Invoice.objects.create({ reference: 'batch-2', amount: 2 })
    throw new Error('halfway failure')
  },
})

const nonTransactional = service({
  name: 'no-transaction',
  input: t.Object({}),
  transactional: false,
  async handler() {
    await Invoice.objects.create({ reference: 'kept', amount: 1 })
    throw new Error('still fails')
  },
})

const billing = defineApp({
  name: 'billing',
  prefix: '/',
  models: { Invoice },
  urls: router().post('/invoices/:invoiceId/approve', fromService(approveInvoice, {
    params: t.Object({ invoiceId: t.Numeric() }),
  })),
})

const settings = {
  apps: [billing],
  prefix: '/api',
  openapi: { title: 'Billing', version: '1.0.0' },
  authenticate: (context: Record<string, any>) =>
    context.request.headers.get('x-staff') ? { id: 1, isStaff: true } : null,
}

let db: TestDatabase
let client: TestClient
/** MCP mounts at /mcp, outside the project's /api prefix. */
let rootClient: TestClient

beforeAll(async () => {
  db = await testDatabase({ models: [Invoice] })
  const app = await createApp(settings, { connectDatabase: false })
  client = clientFor(app, { basePath: '/api' })
  rootClient = clientFor(app)
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  await Invoice.objects.create({ reference: 'INV-1', amount: 100 })
})

describe('direct invocation', () => {
  test('runs the handler and returns the output', async () => {
    const result: any = await callService(approveInvoice, { invoiceId: 1 }, { system: true })
    expect(result.status).toBe('approved')
  })

  test('validates and coerces the input', async () => {
    // '1' is coerced by t.Numeric, exactly as it would be over HTTP.
    const result: any = await callService(approveInvoice, { invoiceId: '1' }, { system: true })
    expect(result.status).toBe('approved')
  })

  test('rejects invalid input with field-level errors', async () => {
    expect(callService(approveInvoice, { invoiceId: 'nope' }, { system: true })).rejects.toThrow(/invoiceId/)
  })

  test('enforces permissions unless the caller is trusted', async () => {
    expect(callService(approveInvoice, { invoiceId: 1 })).rejects.toThrow(/credentials|permission/i)
    expect(callService(approveInvoice, { invoiceId: 1 }, { actor: { isStaff: false } })).rejects.toThrow()
    const allowed: any = await callService(approveInvoice, { invoiceId: 1 }, { actor: { isStaff: true } })
    expect(allowed.status).toBe('approved')
  })

  test('domain rules are enforced wherever the call comes from', async () => {
    await callService(approveInvoice, { invoiceId: 1 }, { system: true })
    expect(callService(approveInvoice, { invoiceId: 1 }, { system: true })).rejects.toThrow(/not a draft/)
  })
})

describe('transaction boundary', () => {
  test('a failure rolls back everything the service wrote', async () => {
    expect(callService(brokenBatch, {}, { system: true })).rejects.toThrow('halfway failure')
    expect(await Invoice.objects.filter({ reference__startswith: 'batch-' })).toHaveLength(0)
  })

  test('transactional: false leaves partial work behind', async () => {
    expect(callService(nonTransactional, {}, { system: true })).rejects.toThrow('still fails')
    expect(await Invoice.objects.filter({ reference: 'kept' }).exists()).toBe(true)
  })
})

describe('mounted as a route', () => {
  test('the path parameter feeds the service input', async () => {
    const response = await client.post('/invoices/1/approve', {}, { headers: { 'x-staff': '1' } })
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('approved')
  })

  test('the route inherits the service permissions', async () => {
    const response = await client.post('/invoices/1/approve', {})
    expect(response.status).toBe(401)
    expect(await Invoice.objects.get({ id: 1 })).toMatchObject({ status: 'draft' })
  })

  test('a domain error surfaces as an API error', async () => {
    const response = await client.post('/invoices/999/approve', {}, { headers: { 'x-staff': '1' } })
    expect(response.status).toBe(404)
  })

  test('body and params are merged before validation', async () => {
    const response = await client.post('/invoices/1/approve', { note: 'looks fine' }, { headers: { 'x-staff': '1' } })
    expect(response.status).toBe(200)
  })
})

describe('the other surfaces read the same declaration', () => {
  test('OpenAPI documents the service as an operation', () => {
    const spec = projectSpec(settings)
    const operation = (spec.paths['/api/invoices/{invoiceId}/approve'] as any)?.post
    expect(operation).toBeDefined()
    expect(operation.operationId).toBe('approve-invoice')
    expect(operation.summary).toBe('Approve a draft invoice')
    expect(operation.tags).toEqual(['invoices'])
    // Permissions on the service reach the document.
    expect(operation.description).toContain('Requires authentication')
  })

  test('MCP exposes it as a tool with the service input schema', () => {
    const tools = projectTools(settings)
    const tool = tools.find((candidate) => candidate.name === 'approve-invoice')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema.properties).toHaveProperty('invoiceId')
    expect(tool!.outputSchema).toBeDefined()
  })

  test('an agent calling the tool is refused without permission', async () => {
    const response = await rootClient.post('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'approve-invoice', arguments: { invoiceId: 1, body: {} } },
    })
    // Reaches the endpoint and is refused there — the same 401 a human gets.
    expect(response.body.result.isError).toBe(true)
    expect(response.body.result.content[0].text).toContain('401')
  })
})

describe('definition rules', () => {
  test('a duplicate name is rejected', () => {
    expect(() => service({ name: 'approve-invoice', input: t.Object({}), handler: () => null })).toThrow(
      /already defined/,
    )
  })

  test('a name that cannot be a tool or CLI command is rejected', () => {
    expect(() => service({ name: 'not valid!', input: t.Object({}), handler: () => null })).toThrow(
      /must start with a letter/,
    )
  })
})
