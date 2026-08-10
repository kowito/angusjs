/**
 * MCP JSON-RPC dispatch, transport-independent.
 *
 * The protocol changed shape in revision 2026-07-28: sessions and the
 * `initialize` handshake were replaced by per-request metadata plus a mandatory
 * `server/discover`. Most clients in the wild still speak the handshake, so
 * this server is *dual-era* — it answers both, and decides which one a caller
 * means from how they open:
 *
 *   - a request carrying `_meta['io.modelcontextprotocol/protocolVersion']`
 *     (or the `MCP-Protocol-Version` header) is served as modern
 *   - an `initialize` request selects legacy semantics
 */

import type { Elysia } from 'elysia'
import { emitAudit, fingerprint, redact, type AuditEvent, type AuditSink } from './audit.ts'
import { checkConfirmation, needsConfirmation, type ToolPolicy } from './policy.ts'
import { readResource, toResourceDefinition, type Resource } from './resources.ts'
import { callTool, toDefinition, type Tool } from './tools.ts'

export const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
export const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo'
export const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'

/** Newest first. The first entry is what we advertise by default. */
export const MODERN_VERSIONS = ['2026-07-28'] as const
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const
export const SUPPORTED_VERSIONS: string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS]

/** A client that sends no version header predates the header's introduction. */
const ASSUMED_LEGACY_VERSION = '2025-03-26'

export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** MCP-defined: headers disagree with the body, or a required one is missing. */
  headerMismatch: -32020,
  /** MCP-defined: the requested protocol version isn't implemented. */
  unsupportedProtocolVersion: -32022,
} as const

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: JsonRpcError
}

export function isNotification(message: JsonRpcRequest): boolean {
  return message.id === undefined || message.id === null
}

export function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value }
}

export function failure(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }
}

export interface ServerIdentity {
  name: string
  version: string
  /** Natural-language guidance handed to the model alongside the tool list. */
  instructions?: string
}

export interface DispatchContext {
  /** The app tool calls are dispatched through. */
  app: Elysia<any, any>
  /** The tools this server serves — already filtered by policy. */
  tools: Tool[]
  /**
   * What this agent may do. Exposure is applied when the tool list is built,
   * so what remains here is the confirmation requirement.
   */
  policy?: ToolPolicy
  /** Where the record of each call goes. */
  audit?: AuditSink
  /** What the agent may read before it acts. */
  resources?: Resource[]
  identity: ServerIdentity
  /** Origin used to build the synthetic request URL. */
  origin?: string
  /** Incoming headers, so credentials can be forwarded to the API. */
  headers?: Headers
}

/** Which era a message belongs to, and the version it declared. */
export interface Era {
  modern: boolean
  version: string
}

export function resolveEra(message: JsonRpcRequest, headerVersion?: string | null): Era | JsonRpcError {
  const meta = (message.params?._meta ?? {}) as Record<string, unknown>
  const declared = (meta[PROTOCOL_VERSION_KEY] as string | undefined) ?? headerVersion ?? undefined

  if (declared === undefined) {
    // No version anywhere: an `initialize` handshake, or a pre-header client.
    return { modern: false, version: ASSUMED_LEGACY_VERSION }
  }

  if (!SUPPORTED_VERSIONS.includes(declared)) {
    return {
      code: JSON_RPC_ERRORS.unsupportedProtocolVersion,
      message: 'Unsupported protocol version',
      data: { supported: SUPPORTED_VERSIONS, requested: declared },
    }
  }

  return { modern: (MODERN_VERSIONS as readonly string[]).includes(declared), version: declared }
}

const CAPABILITIES = {
  tools: { listChanged: false },
  // Subscriptions would need a server-to-client channel the stateless POST
  // transport does not have; the resources themselves are generated per read,
  // so they are never stale anyway.
  resources: { listChanged: false, subscribe: false },
}

/**
 * Handles one JSON-RPC message. Returns `null` for notifications, which have no
 * response by definition.
 */
export async function dispatch(
  context: DispatchContext,
  message: JsonRpcRequest,
  era: Era,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null

  if (message.jsonrpc !== '2.0') {
    return failure(id, JSON_RPC_ERRORS.invalidRequest, 'Only JSON-RPC 2.0 is supported.')
  }

  switch (message.method) {
    // --- modern -----------------------------------------------------------
    case 'server/discover':
      return result(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        instructions: context.identity.instructions,
        _meta: {
          [SERVER_INFO_KEY]: { name: context.identity.name, version: context.identity.version },
        },
      })

    // --- legacy handshake -------------------------------------------------
    case 'initialize': {
      const requested = (message.params?.protocolVersion as string | undefined) ?? ASSUMED_LEGACY_VERSION
      // Echo the client's version when we speak it, otherwise offer our newest
      // legacy version — a legacy client has no way to negotiate upward.
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0]
      return result(id, {
        protocolVersion: version,
        capabilities: CAPABILITIES,
        serverInfo: { name: context.identity.name, version: context.identity.version },
        instructions: context.identity.instructions,
      })
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return result(id, {})

    // --- tools ------------------------------------------------------------
    case 'tools/list':
      return result(id, { tools: context.tools.map(toDefinition) })

    case 'tools/call':
      return callToolMessage(context, message, id)

    case 'resources/list':
      return result(id, { resources: (context.resources ?? []).map(toResourceDefinition) })

    case 'resources/read': {
      const uri = message.params?.uri as string | undefined
      try {
        const contents = await readResource(context.resources ?? [], String(uri))
        return result(id, { contents: [contents] })
      } catch (error) {
        // An unreadable resource is a bad request, not a failed operation:
        // unlike a tool call, there is no result for the model to learn from.
        return failure(id, JSON_RPC_ERRORS.invalidParams, error instanceof Error ? error.message : String(error))
      }
    }

    default:
      return failure(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${message.method}`)
  }
}

async function callToolMessage(
  context: DispatchContext,
  message: JsonRpcRequest,
  id: string | number | null,
): Promise<JsonRpcResponse> {
  const name = message.params?.name as string | undefined
  const args = (message.params?.arguments ?? {}) as Record<string, unknown>

  const tool = context.tools.find((candidate) => candidate.name === name)
  if (!tool) {
    // An unknown tool is a protocol error, not a tool failure. A tool the
    // policy withheld is indistinguishable from one that never existed, which
    // is the intent: an agent cannot probe for what it is not allowed to see.
    return failure(id, JSON_RPC_ERRORS.invalidParams, `Unknown tool: ${String(name)}`)
  }

  const started = performance.now()
  const actor = fingerprint(context.headers)
  const record = (outcome: AuditEvent['outcome'], status: number | null, detail?: string) =>
    emitAudit(context.audit, {
      at: new Date().toISOString(),
      tool: tool.name,
      args: redact(args) as Record<string, unknown>,
      status,
      outcome,
      duration: Math.round(performance.now() - started),
      actor,
      ...(detail ? { detail } : {}),
    })

  // Checked before dispatch, so an unconfirmed destructive call never reaches
  // the database at all.
  if (needsConfirmation(tool, context.policy)) {
    const refusal = checkConfirmation(tool, args)
    if (refusal) {
      context.policy?.onRefusal?.({ tool: tool.name, reason: 'unconfirmed', detail: refusal })
      record('refused', null, refusal)
      return result(id, { content: [{ type: 'text', text: refusal }], isError: true })
    }
  }

  try {
    const call = await callTool(context.app, tool, args, { origin: context.origin, headers: context.headers })

    // A non-2xx from the API is a *tool execution* error: the model should see
    // it and adapt, not have the whole RPC fail.
    if (call.status >= 400) {
      const detail = describeFailure(call.status, call.body, call.text)
      record('error', call.status, detail)
      return result(id, { content: [{ type: 'text', text: detail }], isError: true })
    }

    record('ok', call.status)

    const text = call.text === '' ? `${call.status} No Content` : call.text
    const payload: Record<string, unknown> = {
      content: [{ type: 'text', text }],
      isError: false,
    }

    // `structuredContent` must be an object; arrays and empty bodies are wrapped
    // to match the declared output schema.
    if (tool.outputSchema && call.body !== undefined) {
      payload.structuredContent =
        call.body !== null && typeof call.body === 'object' && !Array.isArray(call.body)
          ? call.body
          : { result: call.body }
    }

    return result(id, payload)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    record('error', null, detail)
    return result(id, { content: [{ type: 'text', text: detail }], isError: true })
  }
}

/** Turns an API error body into something a model can act on. */
function describeFailure(status: number, body: unknown, text: string): string {
  if (body && typeof body === 'object') {
    const shaped = body as { detail?: string; error?: string; errors?: Record<string, string[]> }
    const lines = [`HTTP ${status}${shaped.error ? ` ${shaped.error}` : ''}`]
    if (shaped.detail) lines.push(shaped.detail)
    if (shaped.errors) {
      for (const [field, messages] of Object.entries(shaped.errors)) {
        lines.push(`- ${field}: ${messages.join(', ')}`)
      }
    }
    return lines.join('\n')
  }
  return `HTTP ${status}\n${text}`.trim()
}
