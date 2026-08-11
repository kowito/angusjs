/**
 * HTML rendering for the admin.
 *
 * Server-rendered strings, no build step, no client framework. The admin is a
 * few thousand bytes of HTML and one stylesheet — anything more would make a
 * developer tool heavier than the apps it inspects.
 */

export { esc, html, Html, page, raw, safeUrl, seeOther } from '../html.ts'

import { esc, html, raw, type Html } from '../html.ts'

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * One stylesheet, inlined. Colours are tokens so the dark scheme only has to
 * restate the tokens, not the rules.
 */
export const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #fafbfc;
  --border: #dfe1e6;
  --text: #172b4d;
  --muted: #6b778c;
  --accent: #0b6bcb;
  --accent-text: #ffffff;
  --danger: #c9372c;
  --danger-bg: #ffeceb;
  --ok: #216e4e;
  --ok-bg: #dcfff1;
  --radius: 6px;
  --shadow: 0 1px 2px rgba(9,30,66,.12);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b;
    --surface: #1c2026;
    --surface-2: #22272e;
    --border: #333b45;
    --text: #dee4ea;
    --muted: #93a1b0;
    --accent: #579dff;
    --accent-text: #0b1622;
    --danger: #f87168;
    --danger-bg: #42221f;
    --ok: #7ee2b8;
    --ok-bg: #1f3c31;
    --shadow: 0 1px 2px rgba(0,0,0,.4);
  }
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

header.top {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  display: flex; align-items: center; gap: 16px;
  height: 52px;
  position: sticky; top: 0; z-index: 10;
}
header.top .brand { font-weight: 650; letter-spacing: -.01em; }
header.top .brand a { color: var(--text); }
header.top .spacer { flex: 1; }
header.top .who { color: var(--muted); font-size: 13px; }

main { max-width: 1100px; margin: 0 auto; padding: 20px; }
nav.crumbs { color: var(--muted); font-size: 13px; margin-bottom: 14px; }
nav.crumbs a { color: var(--muted); }
nav.crumbs span { margin: 0 6px; opacity: .6; }

h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -.02em; }
h2 { font-size: 15px; margin: 0 0 10px; }
p.sub { color: var(--muted); margin: 0 0 18px; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
  margin-bottom: 18px;
}
.card > h2 { padding: 12px 16px; margin: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 16px; border-bottom: 1px solid var(--border); }
th { background: var(--surface-2); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; white-space: nowrap; }
th a { color: var(--muted); }
th a.sorted { color: var(--accent); }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-2); }
td.nowrap { white-space: nowrap; color: var(--muted); }
td .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; }
td .null { color: var(--muted); font-style: italic; }

.toolbar { display: flex; gap: 10px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.toolbar form { display: flex; gap: 8px; flex: 1; min-width: 220px; }
.toolbar input[type=search] { flex: 1; }

.layout { display: grid; grid-template-columns: 1fr; gap: 18px; }
@media (min-width: 900px) { .layout.with-filters { grid-template-columns: 1fr 220px; } }
.filters { font-size: 13px; }
.filters .group { margin-bottom: 16px; }
.filters .group > div { font-weight: 600; margin-bottom: 6px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.filters a { display: block; padding: 3px 0; }
.filters a.active { font-weight: 650; }

button, .btn {
  font: inherit; cursor: pointer;
  padding: 6px 12px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
}
button:hover, .btn:hover { background: var(--surface-2); text-decoration: none; }
.btn-primary, button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.btn-primary:hover, button.primary:hover { filter: brightness(1.08); background: var(--accent); }
button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }

input[type=text], input[type=email], input[type=url], input[type=number],
input[type=date], input[type=datetime-local], input[type=time], input[type=search],
select, textarea {
  font: inherit; width: 100%;
  padding: 6px 9px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); color: var(--text);
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
textarea { min-height: 110px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
input[type=checkbox] { width: 16px; height: 16px; }

.field { padding: 14px 16px; border-bottom: 1px solid var(--border); display: grid; gap: 5px; }
.field:last-of-type { border-bottom: 0; }
.field > label { font-weight: 600; }
.field .help { color: var(--muted); font-size: 12px; }
.field .err { color: var(--danger); font-size: 13px; }
.field.invalid input, .field.invalid select, .field.invalid textarea { border-color: var(--danger); }
.field .readonly { color: var(--muted); padding: 6px 0; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
.required::after { content: " *"; color: var(--danger); }

.actions { display: flex; gap: 10px; align-items: center; padding: 14px 16px; background: var(--surface-2); border-top: 1px solid var(--border); }
.actions .spacer { flex: 1; }

.alert { padding: 10px 14px; border-radius: var(--radius); margin-bottom: 16px; border: 1px solid; }
.alert.error { background: var(--danger-bg); border-color: var(--danger); color: var(--danger); }
.alert.ok { background: var(--ok-bg); border-color: var(--ok); color: var(--ok); }

.pager { display: flex; gap: 10px; align-items: center; padding: 12px 16px; color: var(--muted); }
.pager .spacer { flex: 1; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; padding: 16px; }
.grid a.model { display: block; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); color: var(--text); }
.grid a.model:hover { border-color: var(--accent); text-decoration: none; }
.grid a.model strong { display: block; }
.grid a.model span { color: var(--muted); font-size: 12px; }
.empty { padding: 40px 16px; text-align: center; color: var(--muted); }
`

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Crumb {
  label: string
  href?: string
}

export interface LayoutOptions {
  title: string
  siteTitle: string
  root: string
  crumbs?: Crumb[]
  user?: string | null
  body: Html
}

export function layout(options: LayoutOptions): string {
  const crumbs = [{ label: options.siteTitle, href: options.root }, ...(options.crumbs ?? [])]

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(options.title)} | ${esc(options.siteTitle)}</title>
<style>${STYLES}</style>
</head>
<body>
${
  html`<header class="top">
      <div class="brand"><a href="${options.root}">${options.siteTitle}</a></div>
      <div class="spacer"></div>
      ${options.user ? html`<div class="who">${options.user}</div>` : ''}
    </header>
    <main>
      <nav class="crumbs">
        ${crumbs.map((crumb, index) =>
          html`${index > 0 ? raw('<span>/</span>') : ''}${
            crumb.href ? html`<a href="${crumb.href}">${crumb.label}</a>` : html`${crumb.label}`
          }`,
        )}
      </nav>
      ${options.body}
    </main>`
}
</body>
</html>`
}
