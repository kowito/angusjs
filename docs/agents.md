---
title: Agents and MCP
section: Interfaces
order: 2
---

# Agents and MCP

The MCP endpoint is not a plugin bolted onto Angus. It is generated from the same route definitions that become the HTTP API and the OpenAPI document, which is why an agent sees exactly the endpoints a human reads about.

It is served at `/mcp` by default, and over stdio with `angus mcp`.

## How tool calls execute

A tool call dispatches a real `Request` back through the same Elysia app rather than calling handlers directly. That indirection is deliberate: validation, permissions, serialization and error mapping all apply, and there is no second code path that could drift out of agreement with the first.

An agent therefore has exactly the authority the HTTP API grants, and no more.

## Policy

Route permissions decide what the *person* may do. What the *agent* may do is usually narrower, and that is what `policy` says.

```ts
mcp: {
  policy: {
    allow: ['order-*', 'customer-detail'],
    deny: ['order-destroy'],
    confirm: ['order-refund'],
  },
  audit: true,
}
```

Two mechanisms, deliberately separate.

**Exposure** decides which tools exist. A tool that is not exposed never appears in `tools/list` and answers "unknown tool" when called by name — indistinguishable from one that was never built, so a model cannot be talked into using it. Deny beats allow. An empty `allow` list means nothing rather than everything, which is the reading that fails safe when permissions are revoked.

**Confirmation** keeps a tool available but makes its effect two steps. A destructive tool takes a `confirm: true` argument, declared in its schema, and is refused without it *before* the call reaches the database.

> Deletes require confirmation by default. Set `confirm: []` to opt out.

The requirement lives in the schema rather than in an elicitation handshake because the modern protocol has no server-to-client channel on a stateless POST — there is nothing to elicit through. This way every client already supports it.

## Audit

```ts
mcp: { audit: 'mcp-audit.jsonl' }   // or true, or a sink of your own
```

One tool call becomes one API request, so the access log describes the same event without knowing the tool's name, the arguments the model chose, or that a call was refused before it was ever dispatched.

Values under secret-looking keys are dropped, and the caller is recorded as a digest rather than a live bearer token sitting in a file that outlives it. Writes are fire-and-forget: a logging outage is not a reason to stop serving.

## Resources

Tools say what an agent may do. They say little about the shape of the data behind them, and an agent holding only tools learns the domain by trying things — which on a write endpoint means learning by causing failures.

`resources/list` and `resources/read` offer:

| URI | Contents |
| --- | --- |
| `angus://models` | Every model, with fields, types, constraints and relations |
| `angus://models/{name}` | One model |
| `angus://routes` | Every endpoint, and whether it is guarded |
| `angus://openapi` | The full OpenAPI document |

A field is reported as required only when the caller is the one who has to supply it — not nullable, not defaulted, not generated, and actually writable. That is the distinction agents get wrong first.

The route resource says a route is guarded without saying how. Knowing something is protected is useful; knowing what protects it is a map of what to attack.

## Connecting a client

```bash
bun run angus mcp install              # Claude Code, into .mcp.json
bun run angus mcp install cursor
bun run angus mcp install claude-desktop
```

Merges into the existing config rather than replacing the other servers listed in it.

```bash
bun run angus mcp --list               # what an agent would see
```

## Protocol versions

The server speaks the current protocol (2026-07-28) and the three before it. The modern era removed sessions, the GET stream and the initialize handshake; the older ones did not, and both are handled from the same dispatcher.
