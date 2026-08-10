/**
 * OpenAPI generation.
 *
 * The router is a data structure before it is a server, so the spec is built
 * from route definitions directly rather than scraped off a running Elysia
 * instance. That means `angus openapi` works without binding a port, and the
 * document is identical whether it is served or written to a file.
 *
 * Targets OpenAPI 3.1, which uses JSON Schema 2020-12 natively — exactly what
 * TypeBox produces, so schemas pass through without translation.
 */

import type { TSchema } from 'elysia'
import type { RouteDefinition } from '../routing/router.ts'

export interface ServerInfo {
  url: string
  description?: string
}

export interface OpenApiOptions {
  title?: string
  version?: string
  description?: string
  servers?: ServerInfo[]
}

export interface OpenApiDocument {
  openapi: string
  info: { title: string; version: string; description?: string }
  servers?: ServerInfo[]
  paths: Record<string, Record<string, unknown>>
  components: { schemas: Record<string, unknown> }
  tags?: { name: string }[]
}

/** `/posts/:id` -> `/posts/{id}`, and the names that were substituted. */
export function templatePath(path: string): { path: string; params: string[] } {
  const params: string[] = []
  const templated = path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    params.push(name)
    return `{${name}}`
  })
  return { path: templated, params }
}

/** Strips TypeBox's symbol-keyed metadata and gives us a mutable copy. */
function plain(schema: unknown): any {
  return schema === undefined ? undefined : JSON.parse(JSON.stringify(schema))
}

/**
 * Lifts every schema carrying a `title` into `components/schemas` and replaces
 * it with a `$ref`, so `Post` appears once rather than inline on six routes.
 */
class Components {
  readonly schemas: Record<string, unknown> = {}
  /** Serialized schema -> component name, so identical schemas share a ref. */
  private readonly byShape = new Map<string, string>()

  hoist(schema: any): any {
    if (schema === null || typeof schema !== 'object') return schema

    if (Array.isArray(schema)) return schema.map((entry) => this.hoist(entry))

    // Recurse first so nested named schemas become refs inside the parent.
    const walked: any = {}
    for (const [key, value] of Object.entries(schema)) {
      walked[key] =
        key === 'properties' || key === 'patternProperties'
          ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, this.hoist(v)]))
          : key === 'items' || key === 'additionalProperties' || key === 'not'
            ? this.hoist(value)
            : key === 'anyOf' || key === 'allOf' || key === 'oneOf' || key === 'prefixItems'
              ? (value as unknown[]).map((entry) => this.hoist(entry))
              : value
    }

    const title = typeof walked.title === 'string' ? walked.title : undefined
    // Only object and enum-like schemas are worth naming; a bare string with a
    // title would produce a component per field.
    if (!title || (walked.type !== 'object' && !walked.anyOf && !walked.enum)) return walked

    const shape = JSON.stringify(walked)
    const existing = this.byShape.get(shape)
    if (existing) return { $ref: `#/components/schemas/${existing}` }

    const name = this.uniqueName(title)
    this.byShape.set(shape, name)
    this.schemas[name] = walked
    return { $ref: `#/components/schemas/${name}` }
  }

  private uniqueName(title: string): string {
    const base = title.replace(/[^A-Za-z0-9_.-]/g, '_')
    if (!(base in this.schemas)) return base
    let counter = 2
    while (`${base}${counter}` in this.schemas) counter++
    return `${base}${counter}`
  }
}

/** Turns an object schema's properties into OpenAPI parameter objects. */
function parameters(schema: TSchema | undefined, location: 'path' | 'query', components: Components): unknown[] {
  const source = plain(schema)
  if (!source?.properties) return []

  const required: string[] = source.required ?? []
  return Object.entries(source.properties as Record<string, any>).map(([name, property]) => ({
    name,
    in: location,
    // Path parameters are always required, whatever the schema says.
    required: location === 'path' ? true : required.includes(name),
    description: property.description,
    schema: components.hoist(property),
  }))
}

function responses(route: RouteDefinition, components: Components): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  const attach = (status: string, schema: TSchema) => {
    result[status] = {
      description: status.startsWith('2') ? 'Success' : 'Error',
      content: { 'application/json': { schema: components.hoist(plain(schema)) } },
    }
  }

  if (route.response && typeof route.response === 'object' && !('type' in route.response) && !('$ref' in route.response) && !('anyOf' in route.response)) {
    // A `{ 201: schema }` map rather than a bare schema.
    for (const [status, schema] of Object.entries(route.response as Record<number, TSchema>)) {
      attach(String(status), schema)
    }
  } else if (route.response) {
    attach(route.method === 'post' ? '201' : '200', route.response as TSchema)
  }

  if (Object.keys(result).length === 0) {
    result[route.method === 'delete' ? '204' : '200'] = { description: 'Success' }
  }

  // Every route can fail the same way, so the error shape is declared once.
  result.default = {
    description: 'Error',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  }

  return result
}

/** `GET /api/posts/:id` -> `get_api_posts_by_id`, when a route has no name. */
function fallbackOperationId(route: RouteDefinition): string {
  const slug = route.path
    .replace(/:([A-Za-z0-9_]+)/g, 'by_$1')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  return `${route.method}${slug ? `_${slug}` : ''}`
}

export function operationId(route: RouteDefinition): string {
  return route.name ? route.name.replace(/[^A-Za-z0-9_.-]/g, '_') : fallbackOperationId(route)
}

const ERROR_SCHEMA = {
  type: 'object',
  title: 'Error',
  properties: {
    error: { type: 'string' },
    detail: { type: 'string' },
    code: { type: 'string' },
    errors: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
      description: 'Field name to the problems with it.',
    },
  },
  required: ['error', 'detail'],
}

/** Routes that make no sense in an API document — the admin's HTML pages. */
export function isDocumentable(route: RouteDefinition): boolean {
  return !route.hidden
}

export function generateOpenApi(routes: RouteDefinition[], options: OpenApiOptions = {}): OpenApiDocument {
  const components = new Components()
  components.schemas.Error = ERROR_SCHEMA

  const paths: Record<string, Record<string, unknown>> = {}
  const tags = new Set<string>()

  for (const route of routes.filter(isDocumentable)) {
    const { path } = templatePath(route.path)
    const operation: Record<string, unknown> = {
      operationId: operationId(route),
      summary: route.summary,
      description: route.description,
      tags: route.tags,
      parameters: [
        ...parameters(route.params, 'path', components),
        ...parameters(route.query, 'query', components),
      ],
      responses: responses(route, components),
    }

    if (route.tags) for (const tag of route.tags) tags.add(tag)

    if (route.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: components.hoist(plain(route.body)) } },
      }
    }

    // Permissions aren't modelled as OpenAPI security schemes yet, but a reader
    // still benefits from knowing an endpoint is gated.
    if (route.permissions?.length) {
      operation.description = [operation.description, '_Requires authentication._']
        .filter(Boolean)
        .join('\n\n')
    }

    if ((operation.parameters as unknown[]).length === 0) delete operation.parameters
    for (const key of Object.keys(operation)) {
      if (operation[key] === undefined) delete operation[key]
    }

    paths[path] ??= {}
    paths[path]![route.method] = operation
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'angusjs API',
      version: options.version ?? '0.1.0',
      description: options.description,
    },
    ...(options.servers?.length ? { servers: options.servers } : {}),
    paths,
    components: { schemas: components.schemas },
    ...(tags.size > 0 ? { tags: [...tags].sort().map((name) => ({ name })) } : {}),
  }
}
