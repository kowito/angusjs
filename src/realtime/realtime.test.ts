/**
 * Exercised against a real listening server: a WebSocket cannot be driven
 * through `app.handle`, and the parts most likely to break — upgrade,
 * disconnect cleanup, streaming — are exactly the parts a synthetic Request
 * would skip.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import {
  broadcastOnWrite,
  defineChannel,
  getBroker,
  memoryBroker,
  realtime,
  setBroker,
  _resetChannels,
  type Channel,
  type ModelEvent,
} from './index.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { _resetHooks } from '../db/hooks.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'

interface User {
  id: number
  role: string
}

const Note = defineModel('rtNote', {
  fields: { body: f.char({ maxLength: 80 }) },
  meta: { tableName: 'rt_notes' },
})

let db: TestDatabase
let server: { port: number; stop: () => void }
let ticker: Channel<{ n: number }>
let staffOnly: Channel<{ secret: string }>
let mine: Channel<{ owner: number; body: string }>
let noteEvents: Channel<ModelEvent>

beforeAll(async () => {
  db = await testDatabase({ models: [Note] })

  ticker = defineChannel('ticker')
  staffOnly = defineChannel('staff', { authorize: (user) => (user as User)?.role === 'staff' })
  mine = defineChannel('mine', {
    filter: (payload, user) => (payload.owner === (user as User)?.id ? payload : null),
  })
  noteEvents = defineChannel<ModelEvent>('notes')

  const app = new Elysia()
    .use(
      realtime({
        // The header stands in for a session cookie; what matters here is that
        // the connection resolves a user before any subscription is judged.
        authenticate: (request) => {
          const role = request.headers.get('x-role')
          const id = Number(request.headers.get('x-user') ?? 0)
          return role ? { id, role } : null
        },
      }),
    )
    .listen(0)

  server = { port: app.server!.port!, stop: () => app.stop() }
})

afterAll(async () => {
  server.stop()
  await db.close()
  _resetChannels()
})

afterEach(() => {
  _resetHooks()
})

// --- helpers ---------------------------------------------------------------

/**
 * Opens a socket and queues messages, so a test can await the one it wants.
 *
 * Consumed by index rather than by handing each message to a waiting promise:
 * a message that arrives before the test gets round to asking for it must still
 * be delivered, or every assertion becomes a race with the network.
 */
function connect(headers: Record<string, string> = {}) {
  const socket = new WebSocket(`ws://localhost:${server.port}/events`, { headers } as any)
  const received: any[] = []
  let cursor = 0

  socket.addEventListener('message', (event) => {
    received.push(JSON.parse(String(event.data)))
  })

  return {
    socket,
    received,
    open: () =>
      new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve())
        socket.addEventListener('error', reject)
      }),
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    /** The next unread message, with a bound so a hung test fails rather than hangs. */
    next: (timeout = 1000) =>
      new Promise<any>((resolve, reject) => {
        const deadline = Date.now() + timeout
        const poll = () => {
          if (cursor < received.length) return resolve(received[cursor++])
          if (Date.now() > deadline) return reject(new Error('no message within timeout'))
          setTimeout(poll, 5)
        }
        poll()
      }),
    close: () => socket.close(),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

// --- tests -----------------------------------------------------------------

describe('channels', () => {
  test('a second channel with the same name is refused', () => {
    // Two definitions would mean two authorization rules for one subscription,
    // and which one applied would depend on import order.
    expect(() => defineChannel('ticker')).toThrow(/already defined/)
  })

  test('publish reaches an in-process subscriber', async () => {
    const seen: unknown[] = []
    const stop = ticker.subscribe((payload) => seen.push(payload))

    await ticker.publish({ n: 1 })
    expect(seen).toEqual([{ n: 1 }])

    stop()
    await ticker.publish({ n: 2 })
    expect(seen).toHaveLength(1)
  })

  test('one failing subscriber does not stop the others being told', async () => {
    const seen: unknown[] = []
    const stopBad = ticker.subscribe(() => {
      throw new Error('subscriber is broken')
    })
    const stopGood = ticker.subscribe((payload) => seen.push(payload))

    await ticker.publish({ n: 3 })
    expect(seen).toEqual([{ n: 3 }])

    stopBad()
    stopGood()
  })
})

describe('websocket', () => {
  test('a subscription is acknowledged and then delivers', async () => {
    const client = connect()
    await client.open()

    client.send({ action: 'subscribe', channel: 'ticker' })
    expect(await client.next()).toEqual({ subscribed: 'ticker' })

    const message = client.next()
    await ticker.publish({ n: 7 })
    expect(await message).toEqual({ channel: 'ticker', data: { n: 7 } })

    client.close()
  })

  test('an unauthorized channel is refused', async () => {
    const client = connect({ 'x-role': 'customer' })
    await client.open()

    client.send({ action: 'subscribe', channel: 'staff' })
    expect((await client.next()).error).toMatch(/Cannot subscribe/)

    client.close()
  })

  test('an authorized user gets through', async () => {
    const client = connect({ 'x-role': 'staff' })
    await client.open()

    client.send({ action: 'subscribe', channel: 'staff' })
    expect(await client.next()).toEqual({ subscribed: 'staff' })

    client.close()
  })

  test('a channel that does not exist is refused the same way as one that is forbidden', async () => {
    // Otherwise a client could map out which channels exist by the wording.
    const client = connect({ 'x-role': 'customer' })
    await client.open()

    client.send({ action: 'subscribe', channel: 'no-such-channel' })
    const missing = (await client.next()).error

    client.send({ action: 'subscribe', channel: 'staff' })
    const forbidden = (await client.next()).error

    // Same wording either way: only the name the client already supplied
    // differs, so the reply says nothing about which channels exist.
    expect(missing.replace('no-such-channel', 'X')).toBe(forbidden.replace('staff', 'X'))

    client.close()
  })

  test('filter narrows a shared channel per subscriber', async () => {
    const alice = connect({ 'x-role': 'customer', 'x-user': '1' })
    const bob = connect({ 'x-role': 'customer', 'x-user': '2' })
    await Promise.all([alice.open(), bob.open()])

    alice.send({ action: 'subscribe', channel: 'mine' })
    bob.send({ action: 'subscribe', channel: 'mine' })
    await Promise.all([alice.next(), bob.next()])

    const forAlice = alice.next()
    await mine.publish({ owner: 1, body: 'for alice' })
    expect(await forAlice).toEqual({ channel: 'mine', data: { owner: 1, body: 'for alice' } })

    await settle()
    expect(bob.received.filter((message) => message.channel)).toEqual([])

    alice.close()
    bob.close()
  })

  test('unsubscribe stops delivery', async () => {
    const client = connect()
    await client.open()

    client.send({ action: 'subscribe', channel: 'ticker' })
    await client.next()
    client.send({ action: 'unsubscribe', channel: 'ticker' })
    await client.next()

    await ticker.publish({ n: 99 })
    await settle()
    expect(client.received.filter((message) => message.channel)).toEqual([])

    client.close()
  })

  test('a disconnect releases the subscription', async () => {
    // The leak this would otherwise have: every closed socket leaves a handler
    // in the broker for the life of the process.
    setBroker(memoryBroker())
    const isolated = defineChannel('isolated')

    const client = connect()
    await client.open()
    client.send({ action: 'subscribe', channel: 'isolated' })
    await client.next()

    let delivered = 0
    const probe = isolated.subscribe(() => delivered++)
    await isolated.publish({})
    expect(delivered).toBe(1)

    client.close()
    await settle()

    // Nothing throws on publish to a closed socket, and the handler is gone.
    await isolated.publish({})
    expect(delivered).toBe(2)

    probe()
  })

  test('a connection cannot hold unbounded subscriptions', async () => {
    const app = new Elysia().use(realtime({ path: '/limited', maxSubscriptions: 1 })).listen(0)
    const port = app.server!.port!

    const socket = new WebSocket(`ws://localhost:${port}/limited`)
    const messages: any[] = []
    socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))))
    await new Promise((resolve) => socket.addEventListener('open', resolve))

    socket.send(JSON.stringify({ action: 'subscribe', channel: 'ticker' }))
    socket.send(JSON.stringify({ action: 'subscribe', channel: 'notes' }))
    await settle()

    expect(messages[0]).toEqual({ subscribed: 'ticker' })
    expect(messages[1].error).toMatch(/At most 1 subscription/)

    socket.close()
    app.stop()
  })

  test('a malformed message is answered rather than closing the socket', async () => {
    const client = connect()
    await client.open()

    client.socket.send('not json at all')
    expect((await client.next()).error).toMatch(/action, channel/)

    // Still usable.
    client.send({ action: 'subscribe', channel: 'ticker' })
    expect(await client.next()).toEqual({ subscribed: 'ticker' })

    client.close()
  })
})

describe('server-sent events', () => {
  test('streams published events', async () => {
    const response = await fetch(`http://localhost:${server.port}/events/stream?channel=ticker`)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    const ready = decoder.decode((await reader.read()).value)
    expect(ready).toContain('event: ready')

    const pending = reader.read()
    await settle()
    await ticker.publish({ n: 42 })

    const frame = decoder.decode((await pending).value)
    expect(frame).toContain('event: ticker')
    expect(frame).toContain('"n":42')

    await reader.cancel()
  })

  test('refuses an unauthorized channel before opening the stream', async () => {
    const response = await fetch(`http://localhost:${server.port}/events/stream?channel=staff`, {
      headers: { 'x-role': 'customer' },
    })
    expect(response.status).toBe(403)
  })

  test('asks for a channel rather than streaming nothing', async () => {
    const response = await fetch(`http://localhost:${server.port}/events/stream`)
    expect(response.status).toBe(400)
  })

  test('sets the header that stops proxies buffering the stream', async () => {
    const response = await fetch(`http://localhost:${server.port}/events/stream?channel=ticker`)
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    await response.body!.cancel()
  })
})

describe('model broadcast', () => {
  test('publishes on create, update and delete', async () => {
    await db.reset()
    const events: any[] = []
    const stop = noteEvents.subscribe((payload) => events.push(payload))
    broadcastOnWrite(Note, noteEvents)

    const note = await Note.objects.create({ body: 'first' })
    await Note.objects.filter({ id: note.id }).update({ body: 'second' })
    await Note.objects.filter({ id: note.id }).delete()

    await settle()
    expect(events.map((event) => event.action)).toEqual(['created', 'updated', 'deleted'])
    expect(events[0].model).toBe('rtNote')
    expect(events[0].rows[0].body).toBe('first')

    stop()
  })

  test('a slow broker does not hold up the write', async () => {
    await db.reset()
    const previous = getBroker()
    let published = false

    setBroker({
      publish: () => new Promise((resolve) => setTimeout(() => ((published = true), resolve(undefined)), 200)),
      subscribe: () => () => {},
    })

    const channel = defineChannel<ModelEvent>('slow')
    broadcastOnWrite(Note, channel)

    const started = performance.now()
    await Note.objects.create({ body: 'quick' })
    const elapsed = performance.now() - started

    // The write returns without waiting on delivery.
    expect(elapsed).toBeLessThan(150)
    expect(published).toBe(false)

    setBroker(previous)
  })
})
