---
title: Realtime
section: Interfaces
order: 3
---

# Realtime

Elysia already provides WebSockets. What a channel adds is the part that is not about sockets: what the event means, and who is allowed to hear it.

```ts
export const orderEvents = defineChannel<OrderEvent>('orders', {
  authorize: (user) => Boolean(user),
  filter: (event, user) => (event.customerId === user.id ? event : null),
})

await orderEvents.publish({ customerId: 12, status: 'shipped' })
```

Publishing is a plain function call, so a view, a job and a model hook all reach it the same way. The sockets are a consumer of the event rather than the place it lives.

## Enabling the transports

```ts
realtime: { path: '/events' }
```

| Transport | Address | For |
| --- | --- | --- |
| WebSocket | `/events` | Two-way; send `{ action: 'subscribe', channel }` |
| SSE | `/events/stream?channel=orders` | Receive-only; reconnects on its own |

SSE is worth keeping on. It passes through proxies that mishandle upgrades and is enough for the many cases that only need to receive.

## Authorization

Channels are registered by name because clients subscribe with a string. Letting clients name arbitrary topics would leave the authorization question with nowhere to be answered.

An undeclared channel and a forbidden one are refused in the same words, so a client cannot map out what exists by watching which names come back differently.

`filter` narrows a payload per subscriber, or drops it by returning `null` — for the common case where one channel carries events about many rows and each listener should only see their own.

## Model events

```ts
broadcastOnWrite(Order, orderEvents)
```

Publishes on create, update and delete. Not awaited: a write must not wait on delivery, and a broker that is slow or down is not a reason to fail the transaction that caused the event.

> The obvious trap is putting whole rows on a public channel. A model's fields were chosen for the database, not for whoever is listening — so a channel carrying rows needs `authorize` or `filter`, the same decision a serializer makes for HTTP.

## Brokers

The default broker is in-process. That is correct for one server and wrong for two: a second instance has its own bus, so a client connected to instance B never hears what instance A published.

```ts
setBroker(myRedisBroker())
```

The seam exists precisely so scaling out does not touch application code. Bun's SQL client has no `LISTEN`, so a Postgres broker is not buildable here today.
