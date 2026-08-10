/**
 * Minimal HTML templating, shared by the admin and the API docs.
 *
 * Escaping is the default and safety is opt-out: an interpolation is escaped
 * unless it is explicitly marked `raw`. That ordering is deliberate — the
 * failure mode of forgetting to escape is XSS, and the failure mode of
 * forgetting to mark something raw is visible the moment you look at the page.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes a value for interpolation into HTML text or an attribute. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]!)
}

/** Marks a string as already-safe HTML so `html` won't escape it again. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

export const raw = (value: string): Html => new Html(value)

/**
 * Tagged template that escapes every interpolation unless it is `Html`.
 * Arrays are joined, so `${rows.map(renderRow)}` works.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1]!
  }
  return new Html(out)
}

function render(value: unknown): string {
  if (value instanceof Html) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  if (value === null || value === undefined || value === false) return ''
  return esc(value)
}

/** An HTML response with the right content type. */
export function page(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/** A redirect that browsers follow with GET after a form POST. */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } })
}
