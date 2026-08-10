/**
 * A reference page rendered from the generated spec.
 *
 * Self-contained on purpose: no CDN script, no build step, works offline and
 * under a strict CSP. It is a reference, not an API explorer — point Scalar,
 * Redoc or Swagger UI at `/openapi.json` if you want "try it out".
 */

import { esc, html, raw, type Html } from '../html.ts'
import type { OpenApiDocument } from './generate.ts'

const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --bg: #f4f5f7; --surface: #fff; --surface-2: #fafbfc; --border: #dfe1e6;
  --text: #172b4d; --muted: #6b778c; --accent: #0b6bcb;
  --get: #216e4e; --post: #0b6bcb; --put: #a54800; --patch: #a54800; --delete: #c9372c;
  --radius: 6px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b; --surface: #1c2026; --surface-2: #22272e; --border: #333b45;
    --text: #dee4ea; --muted: #93a1b0; --accent: #579dff;
    --get: #7ee2b8; --post: #579dff; --put: #f5cd47; --patch: #f5cd47; --delete: #f87168;
  }
}
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
header.top { background: var(--surface); border-bottom: 1px solid var(--border); padding: 22px 24px; }
header.top h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: -.02em; }
header.top p { margin: 0; color: var(--muted); }
header.top .meta { margin-top: 10px; display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; }
main { max-width: 940px; margin: 0 auto; padding: 24px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  margin: 28px 0 10px; }
details.op { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  margin-bottom: 8px; overflow: hidden; }
details.op > summary { padding: 10px 14px; cursor: pointer; display: flex; gap: 12px;
  align-items: baseline; list-style: none; }
details.op > summary::-webkit-details-marker { display: none; }
details.op[open] > summary { border-bottom: 1px solid var(--border); background: var(--surface-2); }
.method { font-weight: 700; font-size: 11px; letter-spacing: .06em; min-width: 52px; }
.method.get { color: var(--get); } .method.post { color: var(--post); }
.method.put, .method.patch { color: var(--put); } .method.delete { color: var(--delete); }
.path { font-family: ui-monospace, Menlo, monospace; }
.path .var { color: var(--accent); }
summary .summary { color: var(--muted); margin-left: auto; font-size: 13px; text-align: right; }
.body { padding: 14px; }
.body h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
  margin: 0 0 8px; }
.body section + section { margin-top: 18px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
tr:last-child td { border-bottom: 0; }
td.name { font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
td.type { color: var(--muted); font-family: ui-monospace, Menlo, monospace; }
.req { color: var(--delete); }
pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 10px 12px; overflow-x: auto; margin: 0; }
.status { display: inline-block; min-width: 46px; font-family: ui-monospace, Menlo, monospace; }
.gated { color: var(--muted); font-size: 12px; }
.empty { color: var(--muted); }
`

/** A short human description of a JSON Schema node. */
function typeName(schema: any, depth = 0): string {
  if (!schema || typeof schema !== 'object') return 'any'
  if (schema.$ref) return String(schema.$ref).replace('#/components/schemas/', '')
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(' | ')
  if (schema.anyOf || schema.oneOf) {
    const parts = (schema.anyOf ?? schema.oneOf).map((entry: any) => typeName(entry, depth + 1))
    return [...new Set(parts)].join(' | ')
  }
  if (schema.type === 'array') return `${typeName(schema.items, depth + 1)}[]`
  if (schema.type === 'object' && depth > 0) return 'object'
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  return schema.type ?? 'any'
}

function parameterTable(parameters: any[], location: string): Html {
  const rows = parameters.filter((parameter) => parameter.in === location)
  if (rows.length === 0) return raw('')

  return html`<section>
    <h3>${location === 'path' ? 'Path parameters' : 'Query parameters'}</h3>
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead>
      <tbody>
        ${rows.map(
          (parameter) => html`<tr>
            <td class="name">${parameter.name}${parameter.required ? raw('<span class="req">*</span>') : ''}</td>
            <td class="type">${typeName(parameter.schema)}</td>
            <td>${parameter.description ?? ''}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </section>`
}

/** Renders an object schema as a field table, falling back to raw JSON. */
function schemaBlock(schema: any, spec: OpenApiDocument): Html {
  const resolved =
    schema?.$ref && typeof schema.$ref === 'string'
      ? (spec.components.schemas as Record<string, any>)[schema.$ref.replace('#/components/schemas/', '')]
      : schema

  if (!resolved?.properties) {
    return html`<pre>${JSON.stringify(schema, null, 2)}</pre>`
  }

  const required: string[] = resolved.required ?? []
  return html`<table>
    <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
    <tbody>
      ${Object.entries(resolved.properties as Record<string, any>).map(
        ([name, property]) => html`<tr>
          <td class="name">${name}${required.includes(name) ? raw('<span class="req">*</span>') : ''}</td>
          <td class="type">${typeName(property)}</td>
          <td>${property.description ?? ''}</td>
        </tr>`,
      )}
    </tbody>
  </table>`
}

function operationBlock(path: string, method: string, operation: any, spec: OpenApiDocument): Html {
  const requestSchema = operation.requestBody?.content?.['application/json']?.schema
  const templated = raw(
    esc(path).replace(/\{([^}]+)\}/g, (_, name: string) => `<span class="var">{${esc(name)}}</span>`),
  )

  return html`<details class="op">
    <summary>
      <span class="method ${method}">${method.toUpperCase()}</span>
      <span class="path">${templated}</span>
      <span class="summary">${operation.summary ?? ''}</span>
    </summary>
    <div class="body">
      ${operation.description ? html`<p>${operation.description}</p>` : ''}
      <p class="gated"><code>${operation.operationId}</code></p>
      ${parameterTable(operation.parameters ?? [], 'path')}
      ${parameterTable(operation.parameters ?? [], 'query')}
      ${
        requestSchema
          ? html`<section><h3>Request body</h3>${schemaBlock(requestSchema, spec)}</section>`
          : ''
      }
      <section>
        <h3>Responses</h3>
        <table>
          <tbody>
            ${Object.entries(operation.responses as Record<string, any>).map(
              ([status, response]) => html`<tr>
                <td class="name"><span class="status">${status}</span></td>
                <td class="type">${
                  response.content?.['application/json']?.schema
                    ? typeName(response.content['application/json'].schema)
                    : '—'
                }</td>
                <td>${response.description ?? ''}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </section>
    </div>
  </details>`
}

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

export function renderDocs(spec: OpenApiDocument, specUrl: string): string {
  // Group by the operation's first tag so related endpoints sit together.
  const groups = new Map<string, Html[]>()

  for (const [path, methods] of Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b))) {
    for (const method of METHOD_ORDER) {
      const operation = (methods as Record<string, any>)[method]
      if (!operation) continue
      const group = operation.tags?.[0] ?? 'Endpoints'
      groups.set(group, [...(groups.get(group) ?? []), operationBlock(path, method, operation, spec)])
    }
  }

  const body = html`<header class="top">
      <h1>${spec.info.title}</h1>
      ${spec.info.description ? html`<p>${spec.info.description}</p>` : ''}
      <div class="meta">
        <span>Version ${spec.info.version}</span>
        <span>OpenAPI ${spec.openapi}</span>
        <a href="${specUrl}">${specUrl}</a>
      </div>
    </header>
    <main>
      ${
        groups.size === 0
          ? html`<p class="empty">No documented endpoints.</p>`
          : [...groups]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([group, operations]) => html`<h2>${group}</h2>${operations}`)
      }
    </main>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.info.title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body.value}
</body>
</html>`
}
