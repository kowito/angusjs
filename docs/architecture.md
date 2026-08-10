---
title: Architecture
section: Start here
order: 3
---

# Architecture

The full document lives in [ARCHITECTURE.md](https://github.com/kowito/angusjs/blob/main/ARCHITECTURE.md). This is the shape of it.

## The division

| Elysia owns | Angus owns |
| --- | --- |
| HTTP, routing, route matching | Domain models |
| Request lifecycle and hooks | ORM conventions and QuerySets |
| Validation execution | Migrations pipeline |
| Plugins and composition | Serializers, view sets |
| Transport | Permissions and scoping |
| Context construction | Admin, OpenAPI, MCP |

The rule that decides which side something falls on:

> If it is about moving bytes over a connection, it is Elysia's. If it is about what your application means, it is Angus's.

And when the seam is uncomfortable, the resolution is fixed in advance:

> If Elysia already solves it well, Angus integrates with it. If Angus discovers that Elysia needs a better primitive to support production applications, improve Elysia rather than rebuilding that primitive inside Angus.

The failure mode this prevents is gradual: an awkward seam gets worked around, the workaround grows, and eventually Angus *contains* Elysia rather than extending it.

## The seam

```text
   defineModel()
        │
        ├─ buildTables()  ──────► Drizzle tables ──► drizzle-kit ──► SQL
        │
        ├─ serializer()   ──────► TypeBox schemas
        │                              │
        └─ modelViewSet() ──► Router ──┤
                                │      │
                     ┌──────────┼──────┴──────────┬─────────────┐
                     │          │                 │             │
                flatten()   toElysia()      generateOpenApi()  buildTools()
                     │          │                 │             │
                 route table  Elysia app       OpenAPI       MCP tools
```

Everything Angus knows about HTTP flows through one narrow interface. A `Router` holds route definitions and nothing else; `toElysia()` is the only place it becomes a server.

## Why the surfaces cannot drift

`FieldSpec` is a description, not a column. It names the kind, nullability, constraints and relation target, and stays free of Drizzle, Elysia and TypeBox imports. Four consumers read it independently.

Adding a field type means teaching those four consumers one new case. It does not mean touching four subsystems that each hold their own copy of the schema.

## Accepted constraints

- **Bun only.** `bun:sqlite` and `Bun.SQL` are used directly. A Node layer would cost the performance advantage and double the test matrix.
- **SQLite and Postgres only.** Settled, for the `RETURNING` reason in [Production](production.md#databases).
- **Models register globally at definition time.** This is what lets migrations and the CLI find them without a manifest.
- **One connection in a module slot.** The same trade Django makes with `settings.DATABASES`.

The last two are the only real magic in the framework, and both are load-bearing.
