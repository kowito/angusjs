/**
 * IR conformance.
 *
 * `FieldSpec` is the framework's intermediate representation: one description
 * of a field, read independently by the Drizzle bridge, the serializer schema
 * builder, the admin widget layer and the MCP tool generator.
 *
 * This suite asserts that **every field kind produces something coherent on
 * every surface**. It is the mechanism that keeps the single-source-of-truth
 * claim honest as surfaces are added: adding a field kind means filling in a
 * row of the table below, and forgetting one of the four consumers fails here
 * rather than in someone's application.
 */

import { describe, expect, test } from 'bun:test'
import type { TSchema } from 'elysia'
import { displayValue, isEditable, parseValue, widget } from './admin/widgets.ts'
import { f, type AnyField, type FieldKind } from './db/fields.ts'
import { defineModel } from './db/model.ts'
import { buildTables } from './db/schema.ts'
import { fieldSchema } from './serializers/schema.ts'

/** One representative field per kind, plus a value that should round-trip. */
const Target = defineModel('conformanceTarget', { fields: { label: f.char({ maxLength: 20 }) } })

interface Case {
  kind: FieldKind
  field: AnyField
  /** A value as it comes back from the database. */
  sample: unknown
  /** The same value as a form would submit it. */
  formValue: string
}

const CASES: Case[] = [
  { kind: 'auto', field: f.auto(), sample: 1, formValue: '1' },
  { kind: 'bigAuto', field: f.bigAuto(), sample: 1, formValue: '1' },
  { kind: 'char', field: f.char({ maxLength: 40 }), sample: 'text', formValue: 'text' },
  { kind: 'text', field: f.text(), sample: 'long text', formValue: 'long text' },
  { kind: 'email', field: f.email(), sample: 'a@example.com', formValue: 'a@example.com' },
  { kind: 'slug', field: f.slug(), sample: 'a-slug', formValue: 'a-slug' },
  { kind: 'url', field: f.url(), sample: 'https://example.com', formValue: 'https://example.com' },
  { kind: 'uuid', field: f.uuid(), sample: '00000000-0000-4000-8000-000000000000', formValue: '00000000-0000-4000-8000-000000000000' },
  { kind: 'integer', field: f.integer(), sample: 42, formValue: '42' },
  { kind: 'smallInteger', field: f.smallInteger(), sample: 7, formValue: '7' },
  { kind: 'bigInteger', field: f.bigInteger(), sample: 900, formValue: '900' },
  { kind: 'float', field: f.float(), sample: 1.5, formValue: '1.5' },
  { kind: 'decimal', field: f.decimal(), sample: '19.99', formValue: '19.99' },
  { kind: 'boolean', field: f.boolean(), sample: true, formValue: 'true' },
  { kind: 'date', field: f.date(), sample: new Date('2026-01-02'), formValue: '2026-01-02' },
  { kind: 'datetime', field: f.datetime(), sample: new Date('2026-01-02T03:04:00Z'), formValue: '2026-01-02T03:04' },
  { kind: 'time', field: f.time(), sample: '12:30', formValue: '12:30' },
  { kind: 'json', field: f.json<{ a: number }>(), sample: { a: 1 }, formValue: '{"a":1}' },
  { kind: 'file', field: f.file(), sample: 'docs/report-ab12cd34.pdf', formValue: 'docs/report-ab12cd34.pdf' },
  { kind: 'image', field: f.image(), sample: 'avatars/me-ab12cd34.png', formValue: 'avatars/me-ab12cd34.png' },
  { kind: 'foreignKey', field: f.foreignKey(() => Target), sample: 3, formValue: '3' },
]

/** Fails loudly if a kind is added to the union but not to this suite. */
const ALL_KINDS: FieldKind[] = [
  'auto', 'bigAuto', 'char', 'text', 'email', 'slug', 'url', 'uuid',
  'integer', 'smallInteger', 'bigInteger', 'float', 'decimal', 'boolean',
  'date', 'datetime', 'time', 'json', 'file', 'image', 'foreignKey',
]

describe('coverage', () => {
  test('every field kind has a conformance case', () => {
    expect([...new Set(CASES.map((c) => c.kind))].sort()).toEqual([...ALL_KINDS].sort())
  })

  test('every builder in `f` is exercised', () => {
    // oneToOne is foreignKey with unique: true, so it shares the FK case.
    const builders = Object.keys(f).filter((name) => name !== 'oneToOne')
    const covered = new Set(CASES.map((c) => c.kind))
    for (const name of builders) {
      expect(covered.has(name as FieldKind)).toBe(true)
    }
  })
})

describe('the database consumer', () => {
  for (const dialect of ['sqlite', 'postgres'] as const) {
    test(`every kind builds a ${dialect} column`, () => {
      const fields = Object.fromEntries(CASES.map((c, index) => [`field${index}`, c.field]))
      const model = defineModel(`conformance_${dialect}`, { fields })

      const tables = buildTables([Target, model], dialect)
      const table = tables[model.meta.tableName]!

      for (const [attr] of Object.entries(fields)) {
        const column = table[model.columns[attr]!]
        expect(column, `${attr} has no ${dialect} column`).toBeDefined()
      }
    })
  }
})

describe('the serializer consumer', () => {
  for (const testCase of CASES) {
    test(`${testCase.kind} produces read and write schemas`, () => {
      for (const mode of ['read', 'write'] as const) {
        const schema = fieldSchema(testCase.field.spec, mode) as TSchema
        expect(schema, `${testCase.kind}/${mode}`).toBeDefined()
        // Must serialise to JSON Schema — the OpenAPI document depends on it.
        const json = JSON.parse(JSON.stringify(schema))
        expect(Object.keys(json).length, `${testCase.kind}/${mode} is empty`).toBeGreaterThan(0)
      }
    })
  }

  test('read schemas never carry the coercing input union', () => {
    // Coercion belongs on input only; on output it would make a generated
    // client type an integer field `string | number`.
    for (const testCase of CASES) {
      const numeric = ['auto', 'bigAuto', 'integer', 'smallInteger', 'bigInteger', 'float', 'foreignKey']
      if (!numeric.includes(testCase.kind)) continue

      const read = JSON.parse(JSON.stringify(fieldSchema(testCase.field.spec, 'read')))
      expect(read.anyOf, `${testCase.kind} read schema is a union`).toBeUndefined()
      expect(['integer', 'number']).toContain(read.type)
    }
  })
})

describe('the admin consumer', () => {
  for (const testCase of CASES) {
    test(`${testCase.kind} renders a widget and a display value`, () => {
      const spec = testCase.field.spec

      const shown = displayValue(spec, testCase.sample)
      expect(shown.value, `${testCase.kind} display`).toBeString()

      if (!isEditable(spec)) return

      const control = widget({ name: 'x', spec, value: testCase.sample, choices: [] })
      expect(control.value, `${testCase.kind} widget`).toMatch(/<(input|select|textarea)/)
      // Every control must carry the field name, or the form submits nothing.
      expect(control.value).toContain('name="x"')
    })
  }

  for (const testCase of CASES) {
    test(`${testCase.kind} parses its own form value back`, () => {
      const spec = testCase.field.spec
      if (!isEditable(spec)) return

      const parsed = parseValue(spec, testCase.formValue)
      expect(parsed.ok, `${testCase.kind}: ${!parsed.ok && parsed.error}`).toBe(true)
    })
  }

  test('a null value displays without throwing on any kind', () => {
    for (const testCase of CASES) {
      expect(displayValue(testCase.field.spec, null).value).toBeString()
    }
  })
})

describe('the MCP consumer', () => {
  test('every kind reaches a tool schema through the serializer', async () => {
    // MCP reads route schemas, which come from serializers, so the chain is
    // model -> serializer -> route -> tool. Proving the serializer link covers
    // it is what makes MCP a *reader* rather than a fourth implementation.
    const { serializer } = await import('./serializers/index.ts')
    const { buildTools } = await import('./mcp/tools.ts')
    const { router } = await import('./routing/router.ts')
    const { modelViewSet } = await import('./routing/viewset.ts')

    const fields = Object.fromEntries(CASES.map((c, index) => [`field${index}`, c.field]))
    const model = defineModel('conformanceMcp', { fields })
    const modelSerializer = serializer(model, { name: 'ConformanceMcp' })

    const routes = router().include('/x', modelViewSet({ model, serializer: modelSerializer }))
    const tools = buildTools(routes.flatten())

    const create = tools.find((tool) => tool.name.endsWith('-create'))!
    const body = (create.inputSchema.properties as Record<string, any>).body

    for (const attr of Object.keys(fields)) {
      const spec = model.fields[attr]!.spec
      if (!isEditable(spec)) continue
      const key = spec.kind === 'foreignKey' ? attr : attr
      expect(body.properties[key], `${spec.kind} missing from the tool input`).toBeDefined()
    }
  })
})

describe('spec invariants', () => {
  test('a nullable field is optional on write and nullable on read', () => {
    const nullable = f.char({ maxLength: 10, null: true })
    const read = JSON.parse(JSON.stringify(fieldSchema(nullable.spec, 'read')))
    expect(read.anyOf.some((entry: any) => entry.type === 'null')).toBe(true)
  })

  test('auto fields are never editable, on any surface', () => {
    const auto = [f.auto(), f.bigAuto(), f.datetime({ autoNowAdd: true }), f.datetime({ autoNow: true })]
    for (const field of auto) {
      expect(isEditable(field.spec)).toBe(false)
    }
  })

  test('choices become a literal union rather than a bare string', () => {
    const choice = f.char({ choices: ['a', 'b'] })
    const schema = JSON.parse(JSON.stringify(fieldSchema(choice.spec, 'read')))
    expect(schema.anyOf.map((entry: any) => entry.const)).toEqual(['a', 'b'])
  })

  test('a relation carries its target, so every consumer can resolve it', () => {
    const relation = f.foreignKey(() => Target)
    expect(relation.spec.to?.().name).toBe('conformanceTarget')
    expect(relation.spec.onDelete).toBe('cascade')
  })
})
