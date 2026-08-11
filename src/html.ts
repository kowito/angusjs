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

/**
 * Schemes that execute script or smuggle a document, and so must never reach an
 * `href`. `data:` is included because `data:text/html,<script>…` runs in the
 * page's origin, which for the admin is an authenticated staff session.
 */
const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file):/i

/**
 * Makes a value safe to place in an `href`.
 *
 * HTML-escaping is not enough here: `javascript:alert(document.cookie)` has no
 * HTML-special characters, so it survives `esc()` untouched and runs the moment
 * a staff user clicks the link. A URL field is caller-supplied — a profile
 * link, a webhook target — so a lower-privileged user can store one that fires
 * in an admin's session, which is admin account takeover, not merely defacement.
 *
 * The check is on the sink rather than the write path on purpose: data reaches
 * a column through bulk import, seeds and raw ORM writes that never touch a
 * serializer, so validating on the way in would leave those routes open.
 * Anything not clearly a safe link becomes `#`.
 */
export function safeUrl(value: unknown): string {
  if (value === null || value === undefined) return '#'
  const url = String(value).trim()
  if (url === '' || DANGEROUS_SCHEME.test(url)) return '#'
  return url
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
