/**
 * DNS-rebinding defence for the HTTP MCP transport. The attack: a page at
 * evil.com rebinds the name to 127.0.0.1, so the browser reaches a local MCP
 * server while sending an Origin and Host that are equal and attacker-chosen.
 * The old guard passed exactly that case by comparing Origin to Host.
 */

import { describe, expect, test } from 'bun:test'
import { mcpHttpRoutes } from './http.ts'
import type { DispatchContext } from './protocol.ts'

const context = (): DispatchContext => ({ app: new (require('elysia').Elysia)(), tools: [], identity: { name: 't', version: '0' } })

const build = (opts: Partial<Parameters<typeof mcpHttpRoutes>[0]> = {}) =>
  mcpHttpRoutes({ path: '/mcp', context, ...opts })

const call = (app: any, headers: Record<string, string>) =>
  app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
  )

describe('host validation', () => {
  test('a rebinding request (Host: evil.com) is refused', async () => {
    const res = await call(build(), { host: 'evil.com:8000', origin: 'http://evil.com:8000' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.message).toMatch(/Host not allowed/)
  })

  test('a loopback host is allowed', async () => {
    const res = await call(build(), { host: 'localhost:8000' })
    expect(res.status).toBe(200)
  })

  test('127.0.0.1 and IPv6 loopback are allowed', async () => {
    expect((await call(build(), { host: '127.0.0.1:8000' })).status).toBe(200)
    expect((await call(build(), { host: '[::1]:8000' })).status).toBe(200)
  })

  test('a configured public host is allowed via allowedOrigins', async () => {
    const app = build({ allowedOrigins: ['https://mcp.example.com'] })
    const res = await call(app, { host: 'mcp.example.com', origin: 'https://mcp.example.com' })
    expect(res.status).toBe(200)
  })

  test('a non-loopback host with no configuration is refused (fail closed)', async () => {
    expect((await call(build(), { host: 'mcp.example.com' })).status).toBe(403)
  })
})

describe('origin validation', () => {
  test('a browser Origin not on the allowlist is refused even from loopback', async () => {
    const res = await call(build(), { host: 'localhost:8000', origin: 'http://evil.example' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.message).toMatch(/Origin not allowed/)
  })

  test('a non-browser client (no Origin) from loopback is allowed', async () => {
    expect((await call(build(), { host: 'localhost:8000' })).status).toBe(200)
  })

  test('* opts out of both checks', async () => {
    const app = build({ allowedOrigins: ['*'] })
    expect((await call(app, { host: 'anything.com', origin: 'http://anywhere' })).status).toBe(200)
  })
})
