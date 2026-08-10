/**
 * Routes -> MCP tools.
 *
 * The same route definitions that produce the OpenAPI document produce the tool
 * list, so an agent sees exactly the endpoints a human reads about. Tools are
 * executed by dispatching a real HTTP request through the Elysia app, which
 * means validation, permissions, serialization and error mapping all apply —
 * the MCP layer adds no way around them.
 */

import type { Elysia, TSchema } from 'elysia'
import { isDocumentable, operationId, templatePath } from '../openapi/generate.ts'
import type { RouteDefinition } from '../routing/router.ts'

export interface ToolDefinition {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface Tool extends ToolDefinition {
  route: RouteDefinition
  /** Path parameter names, in the order they appear. */
  pathParams: string[]
  queryParams: string[]
}

function plain(schema: unknown): any {
  return schema === undefined ? undefined : JSON.parse(JSON.stringify(schema))
}

/** MCP tool names must be stable and header-safe; keep to a conservative set. */
export function toolName(route: RouteDefinition): string {
  return operationId(route).replace(/[^A-Za-z0-9_-]/g, '_')
}

function describe(route: RouteDefinition): string {
  const lines = [route.summary ?? `${route.method.toUpperCase()} ${route.path}`]
  if (route.description) lines.push(route.description)
  lines.push(`Calls ${route.method.toUpperCase()} ${route.path} on this API.`)
  if (route.permissions?.length) lines.push('Requires an authenticated caller.')
  return lines.join('\n\n')
}

/**
 * Path and query parameters go in at the top level; the request body goes under
 * `body`. Flattening the body too would read better but risks a body field
 * colliding with a query parameter of the same name, which would silently drop
 * one of them.
 */
function inputSchema(route: RouteDefinition): {
  schema: Record<string, unknown>
  pathParams: string[]
  queryParams: string[]
} {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  const params = plain(route.params)
  const { params: pathParams } = templatePath(route.path)

  for (const name of pathParams) {
    properties[name] = params?.properties?.[name] ?? { type: 'string' }
    required.push(name)
  }

  const query = plain(route.query)
  const queryParams: string[] = []
  if (query?.properties) {
    const queryRequired: string[] = query.required ?? []
    for (const [name, property] of Object.entries(query.properties as Record<string, unknown>)) {
      if (name in properties) continue
      properties[name] = property
      queryParams.push(name)
      if (queryRequired.includes(name)) required.push(name)
    }
  }

  const body = plain(route.body)
  if (body) {
    properties.body = { ...body, description: 'Request body.' }
    required.push('body')
  }

  return {
    schema: {
      type: 'object',
      properties,
      required,
      // Agents do better with a closed schema: an invented parameter fails
      // loudly rather than being silently dropped.
      additionalProperties: false,
    },
    pathParams,
    queryParams,
  }
}

function outputSchema(route: RouteDefinition): Record<string, unknown> | undefined {
  const response = route.response
  if (!response) return undefined

  // A `{ 201: schema }` map: use the success entry.
  if (typeof response === 'object' && !('type' in response) && !('anyOf' in response) && !('$ref' in response)) {
    const entries = Object.entries(response as Record<string, TSchema>)
    const success = entries.find(([status]) => status.startsWith('2'))
    if (!success) return undefined
    return wrapOutput(plain(success[1]))
  }

  return wrapOutput(plain(response))
}

/**
 * MCP requires `structuredContent` to be a JSON object, so a response that is
 * an array (an unpaginated list) is wrapped rather than returned bare.
 */
function wrapOutput(schema: any): Record<string, unknown> | undefined {
  if (!schema) return undefined
  if (schema.type === 'object') return schema
  return { type: 'object', properties: { result: schema }, required: ['result'] }
}

const READ_METHODS = new Set(['get', 'head', 'options'])

export function buildTool(route: RouteDefinition): Tool {
  const { schema, pathParams, queryParams } = inputSchema(route)

  return {
    name: toolName(route),
    title: route.summary,
    description: describe(route),
    inputSchema: schema,
    outputSchema: outputSchema(route),
    annotations: {
      readOnlyHint: READ_METHODS.has(route.method),
      destructiveHint: route.method === 'delete',
      idempotentHint: route.method !== 'post',
      // Every tool here talks to this API and nothing else.
      openWorldHint: false,
    },
    route,
    pathParams,
    queryParams,
  }
}

export interface ToolFilter {
  /** Only expose these tool names. */
  include?: readonly string[]
  /** Never expose these tool names. */
  exclude?: readonly string[]
  /** Expose only safe methods. Defaults to false. */
  readOnly?: boolean
}

export function buildTools(routes: RouteDefinition[], filter: ToolFilter = {}): Tool[] {
  const include = filter.include ? new Set(filter.include) : undefined
  const exclude = new Set(filter.exclude ?? [])

  const tools: Tool[] = []
  const seen = new Set<string>()

  for (const route of routes.filter(isDocumentable)) {
    if (filter.readOnly && !READ_METHODS.has(route.method)) continue

    const tool = buildTool(route)
    if (include && !include.has(tool.name)) continue
    if (exclude.has(tool.name)) continue

    // Two routes producing the same tool name would make one unreachable.
    if (seen.has(tool.name)) {
      let counter = 2
      while (seen.has(`${tool.name}_${counter}`)) counter++
      tool.name = `${tool.name}_${counter}`
    }
    seen.add(tool.name)
    tools.push(tool)
  }

  return tools
}

/** What `tools/list` returns — the route internals are dropped. */
export function toDefinition(tool: Tool): ToolDefinition {
  const { route: _route, pathParams: _pathParams, queryParams: _queryParams, ...definition } = tool
  return definition
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface CallResult {
  status: number
  body: unknown
  text: string
}

/** Headers worth carrying from the MCP request through to the API request. */
const FORWARDED = ['authorization', 'cookie', 'accept-language']

/**
 * Runs a tool by dispatching a request through the app. Going the long way
 * round — rather than calling the route handler directly — is what keeps the
 * MCP surface identical to the HTTP surface, permissions included.
 */
export async function callTool(
  app: Elysia<any, any>,
  tool: Tool,
  args: Record<string, unknown>,
  options: { origin?: string; headers?: Headers } = {},
): Promise<CallResult> {
  let path = tool.route.path
  for (const name of tool.pathParams) {
    const value = args[name]
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter "${name}".`)
    }
    path = path.replace(`:${name}`, encodeURIComponent(String(value)))
  }

  const query = new URLSearchParams()
  for (const name of tool.queryParams) {
    const value = args[name]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const entry of value) query.append(name, String(entry))
    } else {
      query.set(name, String(value))
    }
  }

  const origin = options.origin ?? 'http://mcp.local'
  const url = `${origin}${path}${query.size > 0 ? `?${query}` : ''}`

  const headers = new Headers({ accept: 'application/json' })
  for (const name of FORWARDED) {
    const value = options.headers?.get(name)
    if (value) headers.set(name, value)
  }

  const hasBody = 'body' in args && args.body !== undefined && args.body !== null
  if (hasBody) headers.set('content-type', 'application/json')

  const response = await app.handle(
    new Request(url, {
      method: tool.route.method.toUpperCase(),
      headers,
      body: hasBody ? JSON.stringify(args.body) : undefined,
    }),
  )

  const text = await response.text()
  let body: unknown = undefined
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  return { status: response.status, body, text }
}
