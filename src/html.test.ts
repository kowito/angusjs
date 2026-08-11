/**
 * The XSS surface of the HTML helpers.
 *
 * `esc()` handles the text and attribute cases; `safeUrl()` handles the one
 * escaping cannot — a scheme like `javascript:` has no HTML-special characters,
 * so it passes through `esc()` untouched and executes when a link is clicked.
 */

import { describe, expect, test } from 'bun:test'
import { displayValue } from './admin/widgets.ts'
import { f } from './db/fields.ts'
import { esc, html, raw, safeUrl } from './html.ts'

describe('esc', () => {
  test('neutralises the HTML metacharacters, quotes included', () => {
    expect(esc(`<script>`)).toBe('&lt;script&gt;')
    // Both quote styles, so neither can break out of an attribute.
    expect(esc(`a" onfocus="x`)).toBe('a&quot; onfocus=&quot;x')
    expect(esc(`a' onfocus='x`)).toContain('&#39;')
  })

  test('renders arrays and skips nullish, but never trusts a bare string', () => {
    expect(html`<b>${'<i>'}</b>`.value).toBe('<b>&lt;i&gt;</b>')
    expect(html`${['<a>', '<b>']}`.value).toBe('&lt;a&gt;&lt;b&gt;')
    expect(html`${raw('<hr>')}`.value).toBe('<hr>')
  })
})

describe('safeUrl', () => {
  test('passes through the schemes a link legitimately uses', () => {
    expect(safeUrl('https://example.com/x?y=1')).toBe('https://example.com/x?y=1')
    expect(safeUrl('/relative/path')).toBe('/relative/path')
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c')
  })

  test('defuses schemes that execute or smuggle a document', () => {
    // Each of these runs in the page's origin — for the admin, a staff session.
    expect(safeUrl('javascript:alert(document.cookie)')).toBe('#')
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('#')
    expect(safeUrl('vbscript:msgbox(1)')).toBe('#')
    expect(safeUrl('file:///etc/passwd')).toBe('#')
  })

  test('is not fooled by leading whitespace or case', () => {
    // Browsers strip leading control characters before parsing the scheme.
    expect(safeUrl('  javascript:alert(1)')).toBe('#')
    expect(safeUrl('JaVaScRiPt:alert(1)')).toBe('#')
    expect(safeUrl('\t\njavascript:alert(1)')).toBe('#')
  })

  test('empty and nullish become an inert anchor, never blank', () => {
    expect(safeUrl('')).toBe('#')
    expect(safeUrl(null)).toBe('#')
    expect(safeUrl(undefined)).toBe('#')
  })
})

describe('the admin url widget', () => {
  const urlSpec = f.url().spec

  test('a javascript URL cannot reach the href', () => {
    // The vulnerability: a lower-privileged user stores this on any url field,
    // and it fires in the session of the staff user who opens the admin.
    const rendered = displayValue(urlSpec, 'javascript:alert(document.cookie)').value

    expect(rendered).not.toContain('href="javascript:')
    expect(rendered).toContain('href="#"')
    // The raw value still shows as text, so nothing is silently hidden.
    expect(rendered).toContain('javascript:alert(document.cookie)')
  })

  test('an ordinary URL is untouched', () => {
    const rendered = displayValue(urlSpec, 'https://example.com').value
    expect(rendered).toContain('href="https://example.com"')
  })

  test('a quote in a URL cannot break out of the attribute', () => {
    const rendered = displayValue(urlSpec, 'https://x/"><script>alert(1)</script>').value
    expect(rendered).not.toContain('"><script>')
    expect(rendered).toContain('&quot;')
  })
})
