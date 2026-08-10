/**
 * Tracing without OpenTelemetry installed must be free and invisible; with it
 * installed, the span tree has to survive both success and failure. A fake
 * tracer stands in for the SDK, which is the only way to assert the shape of
 * what would be exported.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { initTracing, trace, traceQuery, traceService, tracingActive, _setTracer } from './tracing.ts'

interface Recorded {
  name: string
  attributes: Record<string, unknown>
  ended: boolean
  status?: { code: number; message?: string }
  exceptions: unknown[]
}

/** Records what an SDK would have exported, including nesting order. */
function fakeTracer() {
  const spans: Recorded[] = []

  return {
    spans,
    startActiveSpan<T>(name: string, options: any, fn: (span: any) => T): T {
      const recorded: Recorded = { name, attributes: options?.attributes ?? {}, ended: false, exceptions: [] }
      spans.push(recorded)

      return fn({
        setAttribute: (key: string, value: unknown) => (recorded.attributes[key] = value),
        setStatus: (status: any) => (recorded.status = status),
        recordException: (error: unknown) => recorded.exceptions.push(error),
        end: () => (recorded.ended = true),
      })
    },
  }
}

afterEach(() => {
  _setTracer(null)
})

describe('without the package', () => {
  test('initTracing reports that tracing is off rather than throwing', async () => {
    // @opentelemetry/api is not a dependency of this project, which is the
    // situation most applications are in.
    expect(await initTracing({})).toBe(false)
    expect(tracingActive()).toBe(false)
  })

  test('a traced call still returns its value', () => {
    expect(trace('anything', {}, () => 42)).toBe(42)
  })

  test('a traced call still propagates its error', () => {
    expect(() => trace('anything', {}, () => {
      throw new Error('boom')
    })).toThrow('boom')
  })

  test('an async traced call is not wrapped in an extra promise', () => {
    // The no-tracer path returns fn() directly, so an application without
    // OpenTelemetry pays one comparison rather than a promise per call.
    const promise = Promise.resolve(1)
    expect(trace('anything', {}, () => promise)).toBe(promise)
  })

  test('enabling explicitly warns rather than failing the boot', async () => {
    const warnings: unknown[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args[0])

    expect(await initTracing({ enabled: true })).toBe(false)
    console.warn = original

    // Silence here is the failure mode: empty traces with no explanation.
    expect(String(warnings[0])).toMatch(/@opentelemetry\/api is not installed/)
  })

  test('disabling explicitly does not even try to load it', async () => {
    expect(await initTracing({ enabled: false })).toBe(false)
  })
})

describe('with a tracer', () => {
  test('a query span is named by operation and table, not by SQL', () => {
    const tracer = fakeTracer()
    _setTracer(tracer)

    traceQuery('select', 'posts', 'select * from posts', () => null)

    // A trace UI groups by span name; a distinct name per query makes the
    // grouping useless exactly when it is needed.
    expect(tracer.spans[0]!.name).toBe('db.select posts')
    expect(tracer.spans[0]!.attributes['db.sql.table']).toBe('posts')
  })

  test('SQL is withheld unless asked for', async () => {
    const tracer = fakeTracer()
    await initTracing({ enabled: false })
    _setTracer(tracer)

    traceQuery('select', 'posts', 'select secret from posts', () => null)

    // Parameterised SQL carries no values, but table and column names still
    // describe the schema to a wider audience than the database has.
    expect(tracer.spans[0]!.attributes['db.statement']).toBeUndefined()
  })

  test('SQL is recorded when it is', async () => {
    await initTracing({ enabled: false })
    const tracer = fakeTracer()
    _setTracer(tracer)

    // initTracing stores the options even when it cannot load the SDK.
    await initTracing({ enabled: false, recordStatements: true })
    _setTracer(tracer)

    traceQuery('select', 'posts', 'select 1', () => null)
    expect(tracer.spans[0]!.attributes['db.statement']).toBe('select 1')
  })

  test('a service span names the operation in the application’s vocabulary', () => {
    const tracer = fakeTracer()
    _setTracer(tracer)

    traceService('publishPost', () => null)
    expect(tracer.spans[0]!.name).toBe('service publishPost')
  })

  test('a synchronous span ends', () => {
    const tracer = fakeTracer()
    _setTracer(tracer)

    trace('work', {}, () => 1)
    expect(tracer.spans[0]!.ended).toBe(true)
  })

  test('an async span stays open until the work finishes', async () => {
    const tracer = fakeTracer()
    _setTracer(tracer)

    const promise = trace('work', {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return 'done'
    })

    // The bug this guards: ending the span when the function returns rather
    // than when its promise settles reports every async call as instant.
    expect(tracer.spans[0]!.ended).toBe(false)
    expect(await promise).toBe('done')
    expect(tracer.spans[0]!.ended).toBe(true)
  })

  test('a failure is recorded on the span and still thrown', () => {
    const tracer = fakeTracer()
    _setTracer(tracer)

    expect(() => trace('work', {}, () => {
      throw new Error('nope')
    })).toThrow('nope')

    expect(tracer.spans[0]!.status?.code).toBe(2)
    expect(tracer.spans[0]!.exceptions).toHaveLength(1)
    expect(tracer.spans[0]!.ended).toBe(true)
  })

  test('an async failure is recorded and still rejects', async () => {
    const tracer = fakeTracer()
    _setTracer(tracer)

    await expect(trace('work', {}, async () => {
      throw new Error('async nope')
    })).rejects.toThrow('async nope')

    expect(tracer.spans[0]!.status?.code).toBe(2)
    expect(tracer.spans[0]!.ended).toBe(true)
  })

  test('a span is not ended twice', async () => {
    const tracer = fakeTracer()
    _setTracer(tracer)

    let ends = 0
    const counting = {
      startActiveSpan<T>(_name: string, _options: any, fn: (span: any) => T): T {
        return fn({
          setAttribute: () => {},
          setStatus: () => {},
          recordException: () => {},
          end: () => ends++,
        })
      },
    }
    _setTracer(counting)

    await trace('work', {}, async () => 'done')
    expect(ends).toBe(1)
  })
})

describe('the request span', () => {
  test('wraps the whole request, so other spans nest beneath it', async () => {
    const { Elysia } = await import('elysia')
    const { httpTracing, traceQuery } = await import('./tracing.ts')

    const spans: { name: string; ended: boolean }[] = []
    const nested: string[] = []

    _setTracer({
      startActiveSpan<T>(name: string, _options: any, fn: (span: any) => T): T {
        const recorded = { name, ended: false }
        spans.push(recorded)
        nested.push(`open:${name}`)

        return fn({
          setAttribute: () => {},
          setStatus: () => {},
          recordException: () => {},
          end: () => {
            recorded.ended = true
            nested.push(`close:${name}`)
          },
        })
      },
    })

    const app: any = new Elysia().use(httpTracing() as any).get('/posts/:id', async () => {
      await traceQuery('select', 'posts', undefined, async () => null)
      return { ok: true }
    })

    const response = await app.handle(new Request('http://localhost/posts/7'))
    expect(response.status).toBe(200)

    // The request span opens first and closes last — that is what makes the
    // query span its child rather than a sibling. It opens before routing, so
    // it is named by path here and renamed to the pattern afterwards.
    expect(nested[0]).toBe('open:GET /posts/7')
    expect(nested[nested.length - 1]).toBe('close:GET /posts/7')
    expect(nested).toContain('open:db.select posts')
  })

  test('is renamed to the route pattern once routing has happened', async () => {
    const { Elysia } = await import('elysia')
    const { httpTracing } = await import('./tracing.ts')

    // A real SDK span supports updateName. The span has to open before routing
    // — `.wrap()` receives the raw Request — so the pattern is applied after.
    const finalNames: string[] = []
    _setTracer({
      startActiveSpan<T>(name: string, _options: any, fn: (span: any) => T): T {
        let current = name
        return fn({
          setAttribute: () => {},
          setStatus: () => {},
          recordException: () => {},
          updateName: (next: string) => (current = next),
          end: () => finalNames.push(current),
        })
      },
    })

    const app: any = new Elysia().use(httpTracing() as any).get('/posts/:id', () => ({ ok: true }))
    await app.handle(new Request('http://localhost/posts/1'))
    await app.handle(new Request('http://localhost/posts/2'))

    // Two ids must not be two operations, or grouping by name is useless.
    expect(finalNames).toEqual(['GET /posts/:id', 'GET /posts/:id'])
  })

  test('falls back to the path when the span cannot be renamed', async () => {
    const { Elysia } = await import('elysia')
    const { httpTracing } = await import('./tracing.ts')

    // updateName is optional on the Span interface, so a minimal stand-in must
    // not break the request.
    const names: string[] = []
    _setTracer({
      startActiveSpan<T>(name: string, _options: any, fn: (span: any) => T): T {
        names.push(name)
        return fn({ setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} })
      },
    })

    const app: any = new Elysia().use(httpTracing() as any).get('/posts/:id', () => ({ ok: true }))
    expect((await app.handle(new Request('http://localhost/posts/1'))).status).toBe(200)
    expect(names).toEqual(['GET /posts/1'])
  })

  test('a 500 marks the span failed, even though Elysia never throws it', async () => {
    const { Elysia } = await import('elysia')
    const { httpTracing } = await import('./tracing.ts')

    let status: { code: number; message?: string } | undefined
    _setTracer({
      startActiveSpan<T>(_name: string, _options: any, fn: (span: any) => T): T {
        return fn({
          setAttribute: () => {},
          setStatus: (next: any) => (status = next),
          recordException: () => {},
          end: () => {},
        })
      },
    })

    const app: any = new Elysia().use(httpTracing() as any).get('/boom', () => {
      throw new Error('boom')
    })

    // Elysia turns the throw into a Response, so the status is the only signal.
    expect((await app.handle(new Request('http://localhost/boom'))).status).toBe(500)
    expect(status?.code).toBe(2)
  })

  test('costs nothing when tracing is off', async () => {
    const { Elysia } = await import('elysia')
    const { httpTracing } = await import('./tracing.ts')

    _setTracer(null)
    const app: any = new Elysia().use(httpTracing() as any).get('/', () => ({ ok: true }))

    expect((await app.handle(new Request('http://localhost/'))).status).toBe(200)
  })
})
