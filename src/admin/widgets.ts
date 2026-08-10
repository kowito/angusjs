/**
 * Field specs -> form controls, and form submissions -> model values.
 *
 * This is the third consumer of `FieldSpec`, alongside the Drizzle bridge and
 * the serializer schema builder. Declaring a field once really does buy the
 * column, the validation, and the widget.
 */

import type { FieldSpec } from '../db/fields.ts'
import type { AnyModel, FieldMap } from '../db/model.ts'
import { esc, html, raw, type Html } from './render.ts'

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** The field used to label a row in listings and relation dropdowns. */
export function displayField(model: AnyModel, override?: string): string {
  if (override) return override
  const preferred = ['name', 'title', 'label', 'slug', 'email', 'username']
  const fields = model.fields as FieldMap
  for (const candidate of preferred) {
    if (fields[candidate]) return candidate
  }
  // Otherwise the first human-readable text column, else the primary key.
  for (const [attr, field] of Object.entries(fields)) {
    if (['char', 'text', 'email', 'slug', 'url'].includes(field.spec.kind)) return attr
  }
  return model.pk
}

/** A one-line label for a row — `Post #3 (On Compilers)` collapses to the title. */
export function rowLabel(model: AnyModel, row: Record<string, unknown>, override?: string): string {
  const attr = displayField(model, override)
  const value = row[attr]
  if (value === null || value === undefined || value === '') return `${model.name} #${String(row[model.pk])}`
  return String(value)
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** Renders a cell value for the changelist table. */
export function displayValue(spec: FieldSpec, value: unknown): Html {
  if (value === null || value === undefined) return html`<span class="null">—</span>`

  switch (spec.kind) {
    case 'boolean':
      return raw(value ? '✓' : '✗')
    case 'datetime':
      return html`${value instanceof Date ? DATE_FORMAT.format(value) : String(value)}`
    case 'date':
      return html`${value instanceof Date ? value.toISOString().slice(0, 10) : String(value)}`
    case 'json':
      return html`<code>${JSON.stringify(value).slice(0, 80)}</code>`
    case 'url':
      return html`<a href="${String(value)}" rel="noreferrer noopener">${String(value)}</a>`
    case 'email':
      return html`<a href="mailto:${String(value)}">${String(value)}</a>`
    default: {
      if (spec.choices?.length) return html`<span class="pill">${String(value)}</span>`
      const text = String(value)
      return html`${text.length > 90 ? `${text.slice(0, 90)}…` : text}`
    }
  }
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/** Formats a stored value for an input's `value` attribute. */
function inputValue(spec: FieldSpec, value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    // `datetime-local` wants local time without a zone suffix.
    if (spec.kind === 'date') return value.toISOString().slice(0, 10)
    const offset = value.getTimezoneOffset() * 60_000
    return new Date(value.getTime() - offset).toISOString().slice(0, 16)
  }
  if (spec.kind === 'json') return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return String(value)
}

export interface RelationChoice {
  value: number | string
  label: string
}

export interface WidgetOptions {
  name: string
  spec: FieldSpec
  value: unknown
  /** Populated for foreign keys. */
  choices?: RelationChoice[]
  invalid?: boolean
}

/** Renders the control for one field. */
export function widget(options: WidgetOptions): Html {
  const { name, spec, value } = options
  const id = `id_${name}`
  const required = !spec.null && !spec.blank && !spec.hasDefault ? raw(' required') : raw('')

  if (spec.kind === 'foreignKey') {
    const current = value === null || value === undefined ? '' : String(value)
    return html`<select id="${id}" name="${name}"${required}>
      ${spec.null ? html`<option value=""${current === '' ? raw(' selected') : raw('')}>—</option>` : ''}
      ${(options.choices ?? []).map(
        (choice) =>
          html`<option value="${String(choice.value)}"${
            String(choice.value) === current ? raw(' selected') : raw('')
          }>${choice.label}</option>`,
      )}
    </select>`
  }

  if (spec.choices?.length) {
    const current = value === null || value === undefined ? '' : String(value)
    return html`<select id="${id}" name="${name}"${required}>
      ${spec.null ? html`<option value=""${current === '' ? raw(' selected') : raw('')}>—</option>` : ''}
      ${spec.choices.map(
        (choice) =>
          html`<option value="${String(choice)}"${
            String(choice) === current ? raw(' selected') : raw('')
          }>${String(choice)}</option>`,
      )}
    </select>`
  }

  switch (spec.kind) {
    case 'boolean':
      // An unchecked box submits nothing. The form always renders every field,
      // so a missing key unambiguously means false.
      return html`<input type="checkbox" id="${id}" name="${name}" value="true"${value ? raw(' checked') : raw('')}>`

    case 'text':
    case 'json':
      return html`<textarea id="${id}" name="${name}"${required}>${inputValue(spec, value)}</textarea>`

    case 'integer':
    case 'smallInteger':
    case 'bigInteger':
      return html`<input type="number" step="1" id="${id}" name="${name}" value="${inputValue(spec, value)}"${
        spec.min !== undefined ? raw(` min="${esc(spec.min)}"`) : raw('')
      }${spec.max !== undefined ? raw(` max="${esc(spec.max)}"`) : raw('')}${required}>`

    case 'float':
    case 'decimal':
      return html`<input type="number" step="any" id="${id}" name="${name}" value="${inputValue(spec, value)}"${required}>`

    case 'date':
      return html`<input type="date" id="${id}" name="${name}" value="${inputValue(spec, value)}"${required}>`

    case 'datetime':
      return html`<input type="datetime-local" id="${id}" name="${name}" value="${inputValue(spec, value)}"${required}>`

    case 'time':
      return html`<input type="time" id="${id}" name="${name}" value="${inputValue(spec, value)}"${required}>`

    case 'email':
      return html`<input type="email" id="${id}" name="${name}" value="${inputValue(spec, value)}"${
        spec.maxLength ? raw(` maxlength="${esc(spec.maxLength)}"`) : raw('')
      }${required}>`

    case 'url':
      return html`<input type="url" id="${id}" name="${name}" value="${inputValue(spec, value)}"${required}>`

    default:
      return html`<input type="text" id="${id}" name="${name}" value="${inputValue(spec, value)}"${
        spec.maxLength ? raw(` maxlength="${esc(spec.maxLength)}"`) : raw('')
      }${spec.kind === 'slug' ? raw(' pattern="[-a-zA-Z0-9_]+"') : raw('')}${required}>`
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * Converts one submitted form value into what the ORM expects. Everything
 * arrives as a string, so the field's kind is the only thing that knows what it
 * should become.
 */
export function parseValue(spec: FieldSpec, raw: string | null | undefined): ParseResult {
  if (spec.kind === 'boolean') {
    // Absent means an unchecked box, which means false.
    return { ok: true, value: raw === 'true' || raw === 'on' }
  }

  const text = typeof raw === 'string' ? raw.trim() : ''

  if (text === '') {
    if (spec.null) return { ok: true, value: null }
    if (spec.hasDefault) return { ok: true, value: undefined }
    if (spec.blank && ['char', 'text', 'email', 'slug', 'url'].includes(spec.kind)) {
      return { ok: true, value: '' }
    }
    return { ok: false, error: 'This field is required.' }
  }

  switch (spec.kind) {
    case 'integer':
    case 'smallInteger':
    case 'bigInteger':
    case 'foreignKey': {
      const parsed = Number(text)
      if (!Number.isInteger(parsed)) return { ok: false, error: 'Enter a whole number.' }
      if (spec.min !== undefined && parsed < spec.min) return { ok: false, error: `Must be at least ${spec.min}.` }
      if (spec.max !== undefined && parsed > spec.max) return { ok: false, error: `Must be at most ${spec.max}.` }
      return { ok: true, value: parsed }
    }

    case 'float': {
      const parsed = Number(text)
      if (Number.isNaN(parsed)) return { ok: false, error: 'Enter a number.' }
      return { ok: true, value: parsed }
    }

    case 'decimal':
      if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, error: 'Enter a decimal number.' }
      return { ok: true, value: text }

    case 'date':
    case 'datetime': {
      const parsed = new Date(text)
      if (Number.isNaN(parsed.getTime())) return { ok: false, error: 'Enter a valid date.' }
      return { ok: true, value: parsed }
    }

    case 'json':
      try {
        return { ok: true, value: JSON.parse(text) }
      } catch {
        return { ok: false, error: 'Enter valid JSON.' }
      }

    case 'email':
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return { ok: false, error: 'Enter a valid email address.' }
      return { ok: true, value: text }

    case 'slug':
      if (!/^[-a-zA-Z0-9_]+$/.test(text)) {
        return { ok: false, error: 'Use letters, digits, hyphens and underscores only.' }
      }
      return { ok: true, value: text }

    default: {
      if (spec.choices?.length && !spec.choices.map(String).includes(text)) {
        return { ok: false, error: `Choose one of: ${spec.choices.join(', ')}.` }
      }
      if (spec.maxLength && text.length > spec.maxLength) {
        return { ok: false, error: `Keep this to ${spec.maxLength} characters or fewer.` }
      }
      return { ok: true, value: text }
    }
  }
}

/** A field is editable in the admin unless the database owns its value. */
export function isEditable(spec: FieldSpec): boolean {
  return spec.editable && !spec.auto && !spec.primaryKey
}
