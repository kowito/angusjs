import { describe, expect, test } from 'bun:test'
import { t } from 'elysia'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { Router, router } from '../routing/router.ts'
import { view } from '../routing/view.ts'
import { serializer } from '../serializers/index.ts'
import { generateOpenApi, templatePath } from './generate.ts'

const Gadget = defineModel('gadget', {
  fields: {
    name: f.char({ maxLength: 60 }),
    price: f.integer({ min: 0 }),
    kind: f.char({ choices: ['tool', 'toy'], default: 'tool' }),
  },
})

const GadgetSerializer = serializer(Gadget, { readOnly: ['id'] })

const routes: Router = router()
  .get(
    '/health',
    view({
      response: t.Object({ ok: t.Boolean() }),
      summary: 'Health check',
      name: 'health',
      tags: ['meta'],
      handler: () => ({ ok: true }),
    }),
  )
  .get('/secret', () => ({}), { hidden: true, name: 'secret' })
  .include(
    '/gadgets',
    modelViewSet({ model: Gadget, serializer: GadgetSerializer, filterFields: ['kind'], tags: ['gadgets'] }),
  )

const spec = generateOpenApi(routes.flatten('/api'), { title: 'Test API', version: '2.0.0' })

const operation = (path: string, method: string): any => (spec.paths[path] as any)?.[method]

describe('document shape', () => {
  test('targets OpenAPI 3.1, which uses JSON Schema natively', () => {
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info).toEqual({ title: 'Test API', version: '2.0.0', description: undefined })
  })

  test('collects tags', () => {
    expect(spec.tags).toEqual([{ name: 'gadgets' }, { name: 'meta' }])
  })
})

describe('paths', () => {
  test('converts :param to {param}', () => {
    expect(templatePath('/posts/:id/comments/:slug')).toEqual({
      path: '/posts/{id}/comments/{slug}',
      params: ['id', 'slug'],
    })
    expect(spec.paths['/api/gadgets/{id}']).toBeDefined()
  })

  test('applies the project prefix', () => {
    expect(spec.paths['/api/health']).toBeDefined()
    expect(spec.paths['/health']).toBeUndefined()
  })

  test('excludes hidden routes', () => {
    expect(spec.paths['/api/secret']).toBeUndefined()
  })

  test('uses the route name as the operationId', () => {
    expect(operation('/api/health', 'get').operationId).toBe('health')
    expect(operation('/api/gadgets', 'get').operationId).toBe('gadget-list')
  })
})

describe('parameters', () => {
  test('path parameters are required', () => {
    const parameters = operation('/api/gadgets/{id}', 'get').parameters
    const id = parameters.find((parameter: any) => parameter.name === 'id')
    expect(id.in).toBe('path')
    expect(id.required).toBe(true)
  })

  test('query parameters are optional and include filters', () => {
    const parameters = operation('/api/gadgets', 'get').parameters
    const names = parameters.map((parameter: any) => parameter.name)
    expect(names).toContain('page')
    expect(names).toContain('kind')
    expect(parameters.every((parameter: any) => parameter.in !== 'query' || parameter.required === false)).toBe(true)
  })

  test('routes without parameters omit the key entirely', () => {
    expect(operation('/api/health', 'get').parameters).toBeUndefined()
  })
})

describe('bodies and responses', () => {
  test('a create carries a request body and answers 201', () => {
    const create = operation('/api/gadgets', 'post')
    expect(create.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/GadgetInput')
    expect(create.responses['201']).toBeDefined()
  })

  test('a delete with no response schema documents 204', () => {
    expect(operation('/api/gadgets/{id}', 'delete').responses['204']).toBeDefined()
  })

  test('every operation documents the shared error shape', () => {
    expect(operation('/api/health', 'get').responses.default.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/Error',
    )
    expect(spec.components.schemas.Error).toBeDefined()
  })
})

describe('components', () => {
  test('named schemas are hoisted and referenced', () => {
    expect(spec.components.schemas.Gadget).toBeDefined()
    expect(spec.components.schemas.GadgetInput).toBeDefined()
    expect(spec.components.schemas.GadgetPatch).toBeDefined()
    expect(operation('/api/gadgets/{id}', 'get').responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/Gadget',
    )
  })

  test('a hoisted schema is nested inside the list envelope', () => {
    const list = operation('/api/gadgets', 'get').responses['200'].content['application/json'].schema
    expect(list.properties.results.items.$ref).toBe('#/components/schemas/Gadget')
  })

  test('component names are PascalCase, since they become client type names', () => {
    expect(Object.keys(spec.components.schemas).every((name) => /^[A-Z]/.test(name))).toBe(true)
  })

  test('response integers are plain, not the coercing input union', () => {
    // Elysia's `t.Integer` serialises to anyOf[string, integer] so query strings
    // coerce. That is right for input and wrong for a response: a generated
    // client would type the field `string | number`.
    const gadget = spec.components.schemas.Gadget as any
    expect(gadget.properties.id).toEqual({ type: 'integer' })
    expect(gadget.properties.price.type).toBe('integer')
  })

  test('write schemas keep coercion so form and query values are accepted', () => {
    const input = spec.components.schemas.GadgetInput as any
    expect(input.properties.price.anyOf).toBeDefined()
  })
})

describe('permissions', () => {
  test('a gated route says so in its description', () => {
    const gated = router().get('/private', () => ({}), {
      permissions: [() => false],
      name: 'private',
    })
    const document = generateOpenApi(gated.flatten(), {})
    expect((document.paths['/private'] as any).get.description).toContain('Requires authentication')
  })
})
