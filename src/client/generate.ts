/**
 * Typed client generation.
 *
 * The generated file is **self-contained**: it declares its own types, its own
 * error class and its own fetch wrapper, and imports nothing. A frontend should
 * not have to install the backend framework — or Bun, or Drizzle — to call the
 * API, and dropping one file into a web app is a much lower bar than adopting a
 * dependency.
 *
 * ## Why not Eden
 *
 * Elysia's Eden is the natural first answer, and the governing rule says to
 * prefer it. It works by importing the server's *type* (`treaty<typeof app>`),
 * which needs the client to compile against the server's source — fine in a
 * monorepo, impossible across repos or teams.
 *
 * More decisively, it cannot see Angus routes at all. Angus builds routes as
 * data and mounts them through `app.route()`, which is what makes `angus
 * routes`, the OpenAPI document and MCP tools possible — and it erases the
 * per-route types Eden reads. Generating from the same route data keeps one
 * source of truth and works anywhere.
 */

import type { OpenApiDocument } from '../openapi/generate.ts'

export interface ClientGenerateOptions {
  /** Exported factory name. Defaults to `createClient`. */
  name?: string
  /** Baked-in default base URL. */
  baseUrl?: string
  /** Emitted at the top of the file. */
  header?: string
}

// ---------------------------------------------------------------------------
// JSON Schema -> TypeScript
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Names the generated file already uses, either from its own runtime or from
 * the platform types that runtime depends on. A model called `Response` would
 * otherwise shadow the DOM type in `ApiError.response`, and a model called
 * `ClientOptions` would collide outright.
 */
const RESERVED = new Set([
  'ApiError', 'ClientOptions', 'RequestOptions', 'CallInput', 'Client',
  'Response', 'Request', 'Headers', 'RequestCredentials', 'AbortSignal',
  'URLSearchParams', 'Error', 'Promise', 'Record', 'Array', 'Date',
])

/** Renames a schema whose name would clash with something already in scope. */
function safeName(name: string): string {
  return RESERVED.has(name) ? `${name}Model` : name
}

function quoteKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key)
}

function refName(ref: string): string {
  return safeName(ref.replace('#/components/schemas/', ''))
}

/** Renders a JSON Schema node as a TypeScript type expression. */
export function typeOf(schema: any, indent = ''): string {
  if (!schema || typeof schema !== 'object') return 'unknown'

  if (schema.$ref) return refName(schema.$ref)
  if (schema.const !== undefined) return JSON.stringify(schema.const)

  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value: unknown) => JSON.stringify(value)).join(' | ')
  }

  const union = schema.anyOf ?? schema.oneOf
  if (Array.isArray(union)) {
    const parts = union.map((entry: any) => typeOf(entry, indent))
    // `anyOf: [string-with-integer-format, integer]` is Elysia's coercing
    // numeric. On the wire it is always the number, so the string branch would
    // only make every caller write `Number(...)`.
    const deduped = [...new Set(parts)]
    const numeric = deduped.filter((part) => part !== 'string')
    return (numeric.length > 0 && deduped.includes('number') ? numeric : deduped).join(' | ')
  }

  if (Array.isArray(schema.type)) {
    return schema.type.map((entry: string) => primitive(entry)).join(' | ')
  }

  if (schema.type === 'array') {
    const item = typeOf(schema.items, indent)
    return item.includes(' ') ? `Array<${item}>` : `${item}[]`
  }

  if (schema.type === 'object' || schema.properties) {
    if (schema.properties) return objectType(schema, indent)
    const additional = schema.additionalProperties
    if (additional && typeof additional === 'object') return `Record<string, ${typeOf(additional, indent)}>`
    return 'Record<string, unknown>'
  }

  return primitive(schema.type)
}

function primitive(type: string | undefined): string {
  switch (type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    default:
      return 'unknown'
  }
}

function objectType(schema: any, indent: string): string {
  const required = new Set<string>(schema.required ?? [])
  const inner = `${indent}  `

  const lines = Object.entries(schema.properties as Record<string, any>).map(([key, property]) => {
    const optional = required.has(key) ? '' : '?'
    const doc = property.description ? `${inner}/** ${property.description} */\n` : ''
    return `${doc}${inner}${quoteKey(key)}${optional}: ${typeOf(property, inner)}`
  })

  return `{\n${lines.join('\n')}\n${indent}}`
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface Operation {
  method: string
  path: string
  name: string
  summary?: string
  description?: string
  params?: { name: string; type: string; required: boolean }[]
  query?: { name: string; type: string; required: boolean }[]
  bodyType?: string
  responseType: string
}

/** `post-list` / `get_api_stats` -> `postList` / `getApiStats`. */
export function methodName(operationId: string): string {
  const cleaned = operationId.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) =>
    next ? next.toUpperCase() : '',
  )
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

function successResponse(responses: Record<string, any>): string {
  const entry = Object.entries(responses).find(([status]) => status.startsWith('2'))
  if (!entry) return 'void'
  const schema = entry[1]?.content?.['application/json']?.schema
  return schema ? typeOf(schema) : 'void'
}

function collect(spec: OpenApiDocument): Operation[] {
  const operations: Operation[] = []

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, raw] of Object.entries(methods as Record<string, any>)) {
      const operation = raw as any
      if (!operation?.operationId) continue

      const parameters = (operation.parameters ?? []) as any[]
      const params = parameters
        .filter((parameter) => parameter.in === 'path')
        .map((parameter) => ({ name: parameter.name, type: typeOf(parameter.schema), required: true }))
      const query = parameters
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => ({
          name: parameter.name,
          type: typeOf(parameter.schema),
          required: Boolean(parameter.required),
        }))

      const bodySchema = operation.requestBody?.content?.['application/json']?.schema

      operations.push({
        method,
        path,
        name: methodName(operation.operationId),
        summary: operation.summary,
        description: operation.description,
        params: params.length > 0 ? params : undefined,
        query: query.length > 0 ? query : undefined,
        bodyType: bodySchema ? typeOf(bodySchema) : undefined,
        responseType: successResponse(operation.responses ?? {}),
      })
    }
  }

  return operations.sort((left, right) => left.name.localeCompare(right.name))
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const RUNTIME = `
export interface ClientOptions {
  /**
   * Origin of the server, without a trailing slash — \`https://api.example.com\`.
   *
   * Do **not** include the API prefix: the paths below already carry it, so
   * adding it here produces \`/api/api/...\`.
   */
  baseUrl?: string
  /** Sent on every request. A function is called per request, for tokens that rotate. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /** Swap in a custom fetch — for retries, tracing, or a test double. */
  fetch?: typeof fetch
  /** Sends cookies on cross-origin requests. */
  credentials?: RequestCredentials
  /** Last chance to adjust the outgoing request. */
  onRequest?: (request: Request) => Request | Promise<Request>
  /** Observes every response, including failures. */
  onResponse?: (response: Response) => void | Promise<void>
}

/** Thrown for any non-2xx response. Carries the API's error contract. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: string
  /** Field name to the problems with it, on a validation failure. */
  readonly errors?: Record<string, string[]>
  readonly response: Response

  constructor(response: Response, body: unknown) {
    const shaped = (body ?? {}) as { error?: string; detail?: string; code?: string; errors?: Record<string, string[]> }
    super(shaped.detail ?? \`Request failed with status \${response.status}\`)
    this.name = shaped.error ?? 'ApiError'
    this.status = response.status
    this.code = shaped.code ?? 'unknown'
    this.detail = shaped.detail ?? this.message
    this.errors = shaped.errors
    this.response = response
  }

  /** True when the failure is the caller's to fix. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500
  }
}

export interface RequestOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
}

interface CallInput {
  params?: Record<string, string | number>
  query?: Record<string, unknown>
  body?: unknown
}

async function call<T>(
  options: ClientOptions,
  method: string,
  template: string,
  input: CallInput,
  perCall: RequestOptions,
): Promise<T> {
  const doFetch = options.fetch ?? globalThis.fetch

  let path = template
  for (const [key, value] of Object.entries(input.params ?? {})) {
    path = path.replace(\`{\${key}}\`, encodeURIComponent(String(value)))
  }

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const entry of value) search.append(key, String(entry))
    else search.set(key, String(value))
  }

  const base = (options.baseUrl ?? '').replace(/\\/$/, '')
  const url = \`\${base}\${path}\${search.size > 0 ? \`?\${search}\` : ''}\`

  const configured = typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {})
  const headers: Record<string, string> = { ...configured, ...perCall.headers }
  if (input.body !== undefined) headers['content-type'] ??= 'application/json'

  let outgoing = new Request(url, {
    method,
    headers,
    credentials: options.credentials,
    signal: perCall.signal,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })
  if (options.onRequest) outgoing = await options.onRequest(outgoing)

  const response = await doFetch(outgoing)
  await options.onResponse?.(response)

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    if (!response.ok) throw new ApiError(response, undefined)
    return undefined as T
  }

  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = text
  }

  if (!response.ok) throw new ApiError(response, body)
  return body as T
}
`.trim()

/** Builds the client source from an OpenAPI document. */
export function generateClient(spec: OpenApiDocument, options: ClientGenerateOptions = {}): string {
  const factory = options.name ?? 'createClient'
  const operations = collect(spec)

  const parts: string[] = []

  parts.push(
    options.header ??
      `/**
 * ${spec.info.title} — generated client, v${spec.info.version}.
 *
 * Generated by \`angus client\`. Do not edit: regenerate instead.
 * Self-contained — no runtime dependencies.
 */`,
  )
  parts.push('')
  parts.push('/* eslint-disable */')
  parts.push('')

  // Component schemas become exported interfaces.
  for (const [rawName, schema] of Object.entries(spec.components.schemas)) {
    const name = safeName(rawName)
    const rendered = typeOf(schema)
    const note = name === rawName ? '' : `/** Named \`${rawName}\` in the API; renamed to avoid a clash. */\n`
    parts.push(
      rendered.startsWith('{')
        ? `${note}export interface ${name} ${rendered}\n`
        : `${note}export type ${name} = ${rendered}\n`,
    )
  }

  parts.push(RUNTIME)
  parts.push('')

  // The factory.
  parts.push(`export function ${factory}(options: ClientOptions${options.baseUrl ? ' = {}' : ''}) {`)
  if (options.baseUrl) {
    parts.push(`  const config = { baseUrl: ${JSON.stringify(options.baseUrl)}, ...options }`)
  } else {
    parts.push('  const config = options')
  }
  parts.push('')
  parts.push('  return {')

  for (const operation of operations) {
    const inputFields: string[] = []
    if (operation.params) {
      inputFields.push(
        `      params: { ${operation.params.map((p) => `${quoteKey(p.name)}: ${p.type}`).join('; ')} }`,
      )
    }
    if (operation.query) {
      inputFields.push(
        `      query?: { ${operation.query
          .map((q) => `${quoteKey(q.name)}${q.required ? '' : '?'}: ${q.type}`)
          .join('; ')} }`,
      )
    }
    if (operation.bodyType) inputFields.push(`      body: ${operation.bodyType}`)

    // Everything optional means the whole argument can be omitted.
    const allOptional = !operation.params && !operation.bodyType
    const inputType = inputFields.length > 0 ? `{\n${inputFields.join('\n')}\n    }` : 'Record<string, never>'
    const inputArg =
      inputFields.length === 0
        ? 'input?: Record<string, never>'
        : `input${allOptional ? '?' : ''}: ${inputType}`

    const doc = [operation.summary, operation.description].filter(Boolean).join('\n     * ')
    if (doc) parts.push(`    /**\n     * ${doc}\n     */`)

    parts.push(
      `    ${operation.name}: (${inputArg}, init: RequestOptions = {}): Promise<${operation.responseType}> =>`,
    )
    parts.push(
      `      call<${operation.responseType}>(config, ${JSON.stringify(operation.method.toUpperCase())}, ` +
        `${JSON.stringify(operation.path)}, (input ?? {}) as any, init),`,
    )
    parts.push('')
  }

  parts.push('  }')
  parts.push('}')
  parts.push('')
  parts.push(`export type Client = ReturnType<typeof ${factory}>`)
  parts.push('')

  return parts.join('\n')
}
