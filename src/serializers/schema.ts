/**
 * Field spec -> TypeBox schema.
 *
 * The schemas produced here are handed straight to Elysia, so one declaration
 * gives request validation, response validation, and OpenAPI documentation.
 * Elysia's `t` is TypeBox plus coercing types (`t.Date`, `t.Numeric`), which is
 * exactly what you want for query strings and JSON bodies.
 */

import { t } from 'elysia'
import { Type, type TSchema } from '@sinclair/typebox'
import type { FieldSpec } from '../db/fields.ts'

export type SchemaMode = 'read' | 'write'

interface Annotations {
  description?: string
  title?: string
}

function annotate(spec: FieldSpec): Annotations {
  const notes: Annotations = {}
  if (spec.helpText) notes.description = spec.helpText
  if (spec.verboseName) notes.title = spec.verboseName
  return notes
}

/** Choices become a literal union, so OpenAPI shows the allowed values. */
function choiceSchema(spec: FieldSpec, notes: Annotations): TSchema {
  const literals = spec.choices!.map((choice) => t.Literal(choice))
  return literals.length === 1 ? literals[0]! : t.Union(literals, notes)
}

function baseSchema(spec: FieldSpec, mode: SchemaMode): TSchema {
  const notes = annotate(spec)
  if (spec.choices?.length) return choiceSchema(spec, notes)

  switch (spec.kind) {
    case 'foreignKey':
      if (mode === 'read') return Type.Integer(notes)
      // Accepts a bare id or an object carrying one, mirroring what the ORM
      // takes. That also lets a client PATCH back a response body whose
      // relation was serialised as a nested object.
      return t.Union(
        [t.Numeric(), t.Object({ id: t.Numeric() }, { additionalProperties: true })],
        notes,
      )

    case 'auto':
    case 'bigAuto':
    case 'integer':
    case 'smallInteger':
    case 'bigInteger':
      // Reads use plain TypeBox: Elysia's `t.Integer` is a *coercing* type that
      // serialises to `anyOf: [string, integer]`, which is right for input but
      // would make a client generated from the spec type the field
      // `string | number`. Writes keep the coercion so `"3"` from a form or
      // query string is accepted rather than rejected.
      return mode === 'read'
        ? Type.Integer({ ...notes, minimum: spec.min, maximum: spec.max })
        : t.Numeric({ ...notes, minimum: spec.min, maximum: spec.max })

    case 'float':
      return mode === 'read'
        ? Type.Number({ ...notes, minimum: spec.min, maximum: spec.max })
        : t.Numeric({ ...notes, minimum: spec.min, maximum: spec.max })

    case 'boolean':
      return t.Boolean(notes)

    case 'char':
    case 'text':
      return t.String({ ...notes, maxLength: spec.maxLength, minLength: spec.minLength })

    case 'email':
      return t.String({ ...notes, format: 'email', maxLength: spec.maxLength })

    case 'url':
      return t.String({ ...notes, format: 'uri', maxLength: spec.maxLength })

    case 'uuid':
      return t.String({ ...notes, format: 'uuid' })

    case 'slug':
      return t.String({ ...notes, pattern: '^[-a-zA-Z0-9_]+$', maxLength: spec.maxLength })

    case 'decimal':
      // Kept as a string end to end so precision survives the JSON round trip.
      return t.String({ ...notes, pattern: '^-?\\d+(\\.\\d+)?$' })

    case 'time':
      return t.String({ ...notes, pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' })

    case 'date':
    case 'datetime':
      // Reads emit ISO strings; writes accept a string and coerce to a Date.
      return mode === 'read'
        ? t.String({ ...notes, format: spec.kind === 'date' ? 'date' : 'date-time' })
        : t.Date(notes)

    case 'file':
    case 'image':
      // The wire value is the storage key. A client uploads separately and
      // sends the key back, which keeps JSON endpoints free of multipart.
      return t.String({
        ...notes,
        maxLength: spec.maxLength,
        description: notes.description ?? `Storage key for the uploaded ${spec.kind}.`,
      })

    case 'json':
      // `t.Any()` alone serialises to `{}`, which is valid JSON Schema but
      // tells an OpenAPI reader or an agent nothing at all. A description
      // costs nothing and makes the field self-documenting.
      return t.Any({ description: 'Arbitrary JSON.', ...notes })
  }
}

/** Wraps a base schema with the nullability and optionality the spec implies. */
export function fieldSchema(spec: FieldSpec, mode: SchemaMode): TSchema {
  let schema = baseSchema(spec, mode)

  if (spec.null) schema = t.Union([schema, t.Null()])

  if (mode === 'write') {
    // Anything the database can fill in, or that's explicitly blankable, may be
    // left out of the request body.
    const optional = spec.auto || spec.hasDefault || spec.null || spec.blank || spec.primaryKey
    if (optional) schema = t.Optional(schema)
  }

  return schema
}
