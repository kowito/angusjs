/**
 * Application events, and the transports that deliver them.
 *
 * Elysia already provides WebSockets, so this is not a transport: it is the
 * layer above one. What an application actually wants to say is "this order
 * moved to shipped, and the people allowed to know are the customer and the
 * warehouse" — which is a statement about the domain, not about sockets. Left
 * to the transport, that logic ends up written once per connection handler and
 * once more for every other way the same event needs to go out.
 *
 * A channel names an event and decides who may listen. Publishing is a function
 * call from anywhere — a view, a job, a model hook — and the sockets are a
 * consumer of it rather than the place it lives.
 */

import type { Elysia } from 'elysia'
import type { AnyModel } from '../db/model.ts'
import { onModelAny } from '../db/hooks.ts'

// ---------------------------------------------------------------------------
// Brokers
// ---------------------------------------------------------------------------

/**
 * Where published events go before they reach subscribers.
 *
 * The seam exists because the default cannot survive a second process, and
 * being able to swap it is the difference between a demo and a deployment.
 */
export interface Broker {
  publish(topic: string, payload: unknown): void | Promise<void>
  subscribe(topic: string, handler: (payload: unknown) => void): () => void
  close?(): void | Promise<void>
}

/**
 * In-process delivery.
 *
 * Correct for a single server and nothing more: a second instance has its own
 * bus, so a client connected to instance B never hears what instance A
 * published. That is fine for development and for a single-container
 * deployment, and it is wrong the moment you scale horizontally — at which
 * point a Redis or NATS broker drops in here without any application code
 * changing, because publishing is already indirect.
 */
export function memoryBroker(): Broker {
  const topics = new Map<string, Set<(payload: unknown) => void>>()

  return {
    publish(topic, payload) {
      for (const handler of topics.get(topic) ?? []) {
        // One bad subscriber must not stop the others from being told.
        try {
          handler(payload)
        } catch (error) {
          console.error(`[realtime] subscriber for "${topic}" failed:`, error)
        }
      }
    },
    subscribe(topic, handler) {
      const handlers = topics.get(topic) ?? new Set()
      handlers.add(handler)
      topics.set(topic, handlers)

      return () => {
        handlers.delete(handler)
        if (handlers.size === 0) topics.delete(topic)
      }
    },
    close() {
      topics.clear()
    },
  }
}

let broker: Broker = memoryBroker()

export function setBroker(next: Broker): void {
  broker = next
}

export function getBroker(): Broker {
  return broker
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface ChannelOptions<T> {
  /**
   * Who may listen. Called once when a client subscribes, with whatever
   * `authenticate` put on the connection.
   *
   * Absent means anyone connected may listen, which is only right for genuinely
   * public events. A channel carrying anything user-specific needs this.
   */
  authorize?: (user: unknown, channel: string) => boolean | Promise<boolean>
  /**
   * Narrows a payload per subscriber, or drops it by returning null.
   *
   * For the common case where one channel carries events about many rows and
   * each listener should only see their own.
   */
  filter?: (payload: T, user: unknown) => T | null
}

export interface Channel<T = unknown> {
  readonly name: string
  readonly options: ChannelOptions<T>
  /** Sends to every authorized subscriber. */
  publish(payload: T): Promise<void>
  /** Listens in-process — for a job or another service, not for a client. */
  subscribe(handler: (payload: T) => void): () => void
}

const channels = new Map<string, Channel<any>>()

/**
 * Declares an event and who may hear it.
 *
 * Registering by name is what lets a client subscribe with a string and still
 * be checked against real rules — the alternative, letting clients name
 * arbitrary topics, means the authorization question has no single place to be
 * answered.
 */
export function defineChannel<T = unknown>(name: string, options: ChannelOptions<T> = {}): Channel<T> {
  const existing = channels.get(name)
  if (existing) {
    throw new Error(
      `Channel "${name}" is already defined. Two channels with one name would ` +
        `mean two different authorization rules for the same subscription.`,
    )
  }

  const channel: Channel<T> = {
    name,
    options,
    async publish(payload) {
      await broker.publish(name, payload)
    },
    subscribe(handler) {
      return broker.subscribe(name, handler as (payload: unknown) => void)
    },
  }

  channels.set(name, channel)
  return channel
}

export function getChannel(name: string): Channel | undefined {
  return channels.get(name)
}

export function registeredChannels(): Channel[] {
  return [...channels.values()]
}

/** Mainly for tests, which define channels at module scope. */
export function _resetChannels(): void {
  channels.clear()
}

// ---------------------------------------------------------------------------
// Model events
// ---------------------------------------------------------------------------

export interface ModelEvent {
  model: string
  action: 'created' | 'updated' | 'deleted'
  rows: unknown[]
}

/**
 * Publishes a channel event whenever the model is written.
 *
 * The obvious use is a live list that updates itself. The obvious trap is
 * putting the whole row on a public channel: the model's fields were chosen for
 * the database, not for whoever is listening, so a channel carrying rows should
 * either be authorized or given a `filter` — the same decision a serializer
 * makes for HTTP, made again here because this path does not go through one.
 */
export function broadcastOnWrite(model: AnyModel, channel: Channel<ModelEvent>): () => void {
  return onModelAny(model, ['afterCreate', 'afterUpdate', 'afterDelete'], (context) => {
    const action = context.event === 'afterCreate' ? 'created' : context.event === 'afterUpdate' ? 'updated' : 'deleted'

    // Not awaited: a write must not wait on delivery, and a broker that is
    // slow or down is not a reason to fail the transaction that caused it.
    void channel.publish({ model: model.name, action, rows: context.rows ?? [] })
  })
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface RealtimeOptions {
  /** Where the WebSocket accepts connections. Defaults to `/events`. */
  path?: string
  /**
   * Also serve Server-Sent Events at `${path}/stream`.
   *
   * Worth keeping on: SSE reconnects on its own, passes through proxies that
   * mishandle upgrades, and is enough for the many cases that only need to
   * receive. Defaults to true.
   */
  sse?: boolean
  /** Resolves the user for a connection, for channel authorization. */
  authenticate?: (request: Request) => unknown | Promise<unknown>
  /** Maximum channels one connection may hold. Defaults to 32. */
  maxSubscriptions?: number
}

interface ClientMessage {
  action?: 'subscribe' | 'unsubscribe'
  channel?: string
}

/**
 * Resolves a subscription request against the registered channels.
 *
 * Returns the reason on refusal rather than throwing, because a client asking
 * for something it cannot have is ordinary traffic, not an error.
 */
async function authorizeSubscription(
  name: string,
  user: unknown,
): Promise<{ ok: true; channel: Channel } | { ok: false; reason: string }> {
  const channel = channels.get(name)
  // An undeclared channel and an unauthorized one give the same answer, so a
  // client cannot map out what exists by watching which name it is refused.
  if (!channel) return { ok: false, reason: `Cannot subscribe to "${name}".` }

  const authorize = channel.options.authorize
  if (authorize && !(await authorize(user, name))) return { ok: false, reason: `Cannot subscribe to "${name}".` }

  return { ok: true, channel }
}

function forSubscriber(channel: Channel, payload: unknown, user: unknown): unknown | null {
  const filter = channel.options.filter
  return filter ? filter(payload, user) : payload
}

/**
 * Mounts the realtime endpoints.
 *
 * Elysia owns the socket; this owns what may be said over it. Subscriptions are
 * held per connection so a disconnect releases them, which is the leak this
 * would otherwise have.
 */
export function realtime(options: RealtimeOptions = {}): (app: Elysia<any, any>) => Elysia<any, any> {
  const path = options.path ?? '/events'
  const maxSubscriptions = options.maxSubscriptions ?? 32

  return (app) => {
    const built = app.ws(path, {
      async open(ws: any) {
        const request = ws.data?.request as Request | undefined
        ws.data.user = options.authenticate && request ? await options.authenticate(request) : null
        ws.data.subscriptions = new Map<string, () => void>()
      },

      async message(ws: any, raw: unknown) {
        const message: ClientMessage =
          typeof raw === 'string' ? safeParse(raw) : ((raw ?? {}) as ClientMessage)

        // Never `return ws.send(...)`: Elysia sends a handler's return value to
        // the client, and send() returns a byte count — which arrives as a
        // second, meaningless frame.
        const reply = (payload: unknown) => {
          ws.send(JSON.stringify(payload))
        }

        const name = message.channel
        if (!name) return reply({ error: 'Send { action, channel }.' })

        const subscriptions: Map<string, () => void> = ws.data.subscriptions

        if (message.action === 'unsubscribe') {
          subscriptions.get(name)?.()
          subscriptions.delete(name)
          return reply({ unsubscribed: name })
        }

        if (subscriptions.has(name)) return
        if (subscriptions.size >= maxSubscriptions) {
          return reply({ error: `At most ${maxSubscriptions} subscriptions per connection.` })
        }

        const resolved = await authorizeSubscription(name, ws.data.user)
        if (!resolved.ok) return reply({ error: resolved.reason })

        const unsubscribe = resolved.channel.subscribe((payload) => {
          const visible = forSubscriber(resolved.channel, payload, ws.data.user)
          if (visible === null) return
          ws.send(JSON.stringify({ channel: name, data: visible }))
        })

        subscriptions.set(name, unsubscribe)
        reply({ subscribed: name })
      },

      close(ws: any) {
        // Without this, every disconnect leaves a handler holding a dead socket
        // and the broker's subscriber list grows for the life of the process.
        for (const unsubscribe of (ws.data.subscriptions as Map<string, () => void>)?.values() ?? []) unsubscribe()
        ws.data.subscriptions?.clear()
      },
    })

    if (options.sse === false) return built

    return built.get(`${path}/stream`, async (context: any) => {
      const requested = String(context.query?.channel ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)

      if (requested.length === 0) {
        context.set.status = 400
        return { error: 'Pass ?channel=name, comma-separated for several.' }
      }

      const user = options.authenticate ? await options.authenticate(context.request) : null

      const resolved: Channel[] = []
      for (const name of requested.slice(0, maxSubscriptions)) {
        const outcome = await authorizeSubscription(name, user)
        if (!outcome.ok) {
          context.set.status = 403
          return { error: outcome.reason }
        }
        resolved.push(outcome.channel)
      }

      const encoder = new TextEncoder()
      const releases: (() => void)[] = []

      const stream = new ReadableStream({
        start(controller) {
          const send = (event: string, data: unknown) => {
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
            } catch {
              // The client went away between the publish and the write.
              for (const release of releases) release()
            }
          }

          for (const channel of resolved) {
            releases.push(
              channel.subscribe((payload: unknown) => {
                const visible = forSubscriber(channel, payload, user)
                if (visible !== null) send(channel.name, visible)
              }),
            )
          }

          send('ready', { channels: resolved.map((channel) => channel.name) })
        },
        cancel() {
          for (const release of releases) release()
        },
      })

      context.set.headers['content-type'] = 'text/event-stream'
      context.set.headers['cache-control'] = 'no-cache'
      // Proxies that buffer will hold the whole stream and deliver nothing.
      context.set.headers['x-accel-buffering'] = 'no'
      return new Response(stream, { headers: context.set.headers })
    })
  }
}

function safeParse(raw: string): ClientMessage {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
