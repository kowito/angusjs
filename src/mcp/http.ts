/**
 * Streamable HTTP transport.
 *
 * A single endpoint accepting POST. Revision 2026-07-28 removed sessions, the
 * GET stream and resumability, so there is nothing to keep between requests —
 * every POST is self-contained, which suits a stateless API gateway exactly.
 *
 * GET and DELETE return 405, as the spec directs for servers that offer no SSE
 * stream and mint no sessions.
 */

import { Elysia } from 'elysia'
import type { Context, Permission } from '../routing/router.ts'
import {
  dispatch,
  failure,
  isNotification,
  JSON_RPC_ERRORS,
  resolveEra,
  SUPPORTED_VERSIONS,
  type DispatchContext,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.ts'

const SENTINEL = /^=\?base64\?(.*)\?=$/

/** Header values that can't be plain ASCII arrive base64-wrapped. */
function decodeHeaderValue(value: string | null): string | null {
  if (value === null) return null
  const match = SENTINEL.exec(value)
  if (!match) return value
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(match[1]!), (char) => char.charCodeAt(0)))
  } catch {
    return value
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export interface McpHttpOptions {
  path: string
  /**
   * Origins permitted to call the endpoint, beyond the server's own. Validating
   * `Origin` is required by the spec: without it a hostile page could use DNS
   * rebinding to drive a local MCP server.
   */
  allowedOrigins?: readonly string[]
  permissions?: readonly Permission[]
  context: (request: Request) => DispatchContext
}

/** True when the request's Origin is absent (non-browser) or trusted. */
function originAllowed(request: Request, allowed: readonly string[]): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  if (allowed.includes('*') || allowed.includes(origin)) return true
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

export function mcpHttpRoutes(options: McpHttpOptions): Elysia<any, any> {
  const allowed = options.allowedOrigins ?? []

  const notAllowed = () =>
    json(
      failure(null, JSON_RPC_ERRORS.invalidRequest, 'This endpoint accepts POST only.'),
      405,
    )

  return new Elysia({ name: 'angus:mcp' })
    .post(options.path, async (context: Context) => {
      const request = context.request as Request

      if (!originAllowed(request, allowed)) {
        return json(failure(null, JSON_RPC_ERRORS.invalidRequest, 'Origin not allowed.'), 403)
      }

      for (const permission of options.permissions ?? []) {
        if (!(await permission(context))) {
          return json(failure(null, JSON_RPC_ERRORS.invalidRequest, 'Not permitted.'), 403)
        }
      }

      // Elysia has already parsed the body; `context.body` is the JSON value.
      const message = context.body as JsonRpcRequest | null
      if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
        return json(failure(null, JSON_RPC_ERRORS.invalidRequest, 'Expected a JSON-RPC message.'), 400)
      }

      const headerVersion = request.headers.get('mcp-protocol-version')

      // Checked before the era is resolved: otherwise a body declaring a legacy
      // version would silently win over a modern header and skip the header
      // validation below entirely.
      const disagreement = versionMismatch(message, headerVersion)
      if (disagreement) return json(disagreement, 400)

      const era = resolveEra(message, headerVersion)

      if ('code' in era) {
        // Unsupported version is a 400 carrying a recognisable modern error, so
        // a dual-era client knows to retry rather than fall back to initialize.
        return json({ jsonrpc: '2.0', id: message.id ?? null, error: era }, 400)
      }

      if (era.modern) {
        const mismatch = validateModernHeaders(request, message, headerVersion)
        if (mismatch) return json(mismatch, 400)
      }

      const dispatchContext = options.context(request)
      let response: JsonRpcResponse | null
      try {
        response = await dispatch(dispatchContext, message, era)
      } catch (error) {
        return json(
          failure(
            message.id ?? null,
            JSON_RPC_ERRORS.internal,
            error instanceof Error ? error.message : String(error),
          ),
          500,
        )
      }

      // A notification gets no body, only an acknowledgement.
      if (response === null || isNotification(message)) return new Response(null, { status: 202 })

      // The modern transport wants 404 for an unimplemented method, so a client
      // can tell it apart from a legacy server that has no endpoint here.
      if (era.modern && response.error?.code === JSON_RPC_ERRORS.methodNotFound) {
        return json(response, 404)
      }

      return json(response)
    })
    .get(options.path, notAllowed)
    .delete(options.path, notAllowed)
}

function bodyProtocolVersion(message: JsonRpcRequest): string | undefined {
  const meta = (message.params?._meta ?? {}) as Record<string, unknown>
  return meta['io.modelcontextprotocol/protocolVersion'] as string | undefined
}

/** The header and the body must agree about the protocol version. */
function versionMismatch(message: JsonRpcRequest, headerVersion: string | null): JsonRpcResponse | null {
  const bodyVersion = bodyProtocolVersion(message)
  if (!headerVersion || !bodyVersion || headerVersion === bodyVersion) return null
  return failure(
    message.id ?? null,
    JSON_RPC_ERRORS.headerMismatch,
    `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match body value '${bodyVersion}'.`,
  )
}

/**
 * The modern transport mirrors body fields into headers so intermediaries can
 * route without parsing the body. If the two disagree, one of them is lying —
 * reject rather than guess which.
 */
function validateModernHeaders(
  request: Request,
  message: JsonRpcRequest,
  headerVersion: string | null,
): JsonRpcResponse | null {
  const id = message.id ?? null
  const mismatch = (detail: string) => failure(id, JSON_RPC_ERRORS.headerMismatch, detail)

  if (!headerVersion) return mismatch('Missing required header: MCP-Protocol-Version.')

  const method = request.headers.get('mcp-method')
  if (!method) return mismatch('Missing required header: Mcp-Method.')
  if (method !== message.method) {
    return mismatch(`Header mismatch: Mcp-Method '${method}' does not match body value '${message.method}'.`)
  }

  // `Mcp-Name` mirrors params.name / params.uri where the method has one.
  const named = message.method === 'tools/call' || message.method === 'prompts/get' || message.method === 'resources/read'
  if (named) {
    const expected = (message.params?.name ?? message.params?.uri) as string | undefined
    const provided = decodeHeaderValue(request.headers.get('mcp-name'))
    if (!provided) return mismatch('Missing required header: Mcp-Name.')
    if (expected !== undefined && provided !== expected) {
      return mismatch(`Header mismatch: Mcp-Name '${provided}' does not match body value '${expected}'.`)
    }
  }

  return null
}

export { SUPPORTED_VERSIONS }
