# Upstream: what building Angus found in Elysia

The architectural rule Angus follows:

> If Elysia already solves it well, Angus integrates with it. If Angus discovers that Elysia needs a better primitive to support production applications, improve Elysia rather than rebuilding that primitive inside Angus.

This file is the second half of that sentence being taken seriously. It records what building a full application layer on Elysia 1.4.29 actually turned up — including the two candidates that turned out not to be problems at all.

Everything here was verified by probing the installed version, not recalled. Where a claim was wrong, the correction is kept rather than quietly deleted, because a roadmap that only ever records confirmed suspicions is not evidence of anything.

---

## 1. A WebSocket handler's return value is sent to the client

**Status: a real footgun. Worth reporting.**

An Elysia `ws` message handler's return value is sent as a frame. `ws.send()` returns the number of bytes written. So the natural early-return spelling publishes a meaningless number to whoever is listening:

```ts
new Elysia().ws('/ws', {
  message(ws) {
    return ws.send(JSON.stringify({ real: true }))
  },
})
```

Observed frames: `["{\"real\":true}", "13"]`.

This shipped in Angus's realtime layer and was caught only because a test asserted the *next* message after a malformed one. Nothing about the code looks wrong; `return doThing()` is how early returns are written everywhere else in the same handler.

**What would fix it:** ignore a numeric return from a `message` handler, or — better — do not treat the return value as a frame when the handler has already called `send()`. Failing that, a line in the WebSocket documentation would do most of the work.

**What Angus does meanwhile:** a local `reply()` helper, and a comment explaining why `return ws.send(...)` is never used.

---

## 2. Direction-aware schema types

**Status: a genuine gap, but arguably not Elysia's to fill.**

A field is frequently readable but not writable — an id, a `createdAt`, a computed total. Expressing that with one TypeBox schema is not possible, so a response schema and a request schema have to be built separately and kept consistent by hand.

Angus solves it by deriving both from the field descriptions:

```ts
serializer(Post, { readOnly: ['id', 'createdAt'] })
```

`serializer.read` and `serializer.write` are two TypeBox schemas generated from one declaration, so they cannot drift.

**Why this may not belong upstream:** the gap is in TypeBox rather than in Elysia, and the fix — something like `t.ReadOnly()` that a schema compiler interprets per direction — would be a change to a dependency Elysia shares rather than to Elysia itself. Elysia could grow a convention for it, but a framework that does not model resources has no obvious place to put one.

**Recommendation:** raise with TypeBox, not with Elysia. Angus's derivation stays either way.

---

## 3. Route introspection

**Status: not a gap. The roadmap was wrong about this.**

Angus's roadmap listed route introspection as an upstream candidate. Probing 1.4.29 shows it is already there and already sufficient:

```ts
app.routes  // [{ method, path, hooks: { params, response, detail }, handler, ... }]
```

`hooks` carries the TypeBox schemas and the `detail` block, which is everything an OpenAPI generator needs.

Angus still keeps `Router` as a plain data structure, but for reasons of its own rather than because Elysia lacks something:

- Permissions and view-set metadata are Angus concepts and were never going to live in Elysia's route table.
- `angus routes`, the OpenAPI document and the MCP tool list are produced without constructing a server at all.
- A view set has to be mountable into an Elysia app somebody else owns.

**Recommendation:** remove this from the roadmap. It has been.

---

## 4. Header mutations late in the lifecycle

**Status: could not reproduce. Earlier claim withdrawn.**

An earlier note in this project asserted that Elysia drops header mutations made in `onAfterHandle` and `mapResponse`, and Angus's security headers were moved to `onRequest` on that basis.

Probing 1.4.29 directly:

| Hook | Header present on the response |
| --- | --- |
| `onRequest` | yes |
| `onAfterHandle` | yes |

Both survive. Whatever the original observation was, it was not this — most likely it was specific to a handler returning a `Response` object, which sets its own headers.

**What Angus does:** the headers stay on `onRequest` regardless, because that placement has an independent justification: error responses carry them too, and a security header that is absent exactly when something has gone wrong is the wrong way round. That is a decision, not a workaround.

**Recommendation:** nothing to report upstream until it can be reproduced.

---

## 5. Wrapping a request

**Status: not a gap. Earlier claim withdrawn.**

Angus's tracing module originally stated that Elysia's hooks observe a request but cannot wrap one, and that a root span therefore had to come from external HTTP instrumentation.

That was wrong. `.wrap()` is a higher-order function over the composed handler:

```ts
app.wrap((composed) => async (request) => {
  before()
  const response = await composed(request)
  after()
  return response
})
```

Probed ordering: `wrap:before → onRequest → handler → wrap:after`. It encloses the request.

Two properties worth documenting upstream, because both cost time to discover:

- It receives the **raw `Request`**, not a context, since it runs before routing. The matched route is therefore unavailable at that point.
- Elysia converts a thrown error into a `Response` internally, so a wrapper sees a status rather than an exception. A `try/catch` around `composed()` never fires; a `finally` does.

**Recommendation:** a documentation contribution rather than a code one. `.wrap()` is the right primitive, and it is under-described.

---

## Summary

| Finding | Verdict |
| --- | --- |
| ws return value becomes a frame | Real. Report it. |
| Direction-aware schemas | Real, but belongs to TypeBox. |
| Route introspection | Already solved. Roadmap corrected. |
| Late header mutations | Not reproducible. Claim withdrawn. |
| Wrapping a request | Already solved. Claim withdrawn, and Angus now uses it. |

Three of five candidates evaporated on contact with the actual API, and one of those turned into a feature — the request-level tracing that had been written off as impossible.

That ratio is the argument for probing rather than remembering.
