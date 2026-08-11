# Contributing

## Getting set up

```bash
bun install
bun test
bun run typecheck
```

Bun 1.2 or newer. No other toolchain — no build step, no bundler, no compiler between changing a file and running it.

## Running the tests

```bash
bun test                    # SQLite, the default
bun run test:postgres       # against a Postgres you are running
bun test src/db             # one area
```

**Run the Postgres suite before sending anything that touches the ORM.** SQLite is permissive: it accepts a bare column in a grouped query, stores anything in a text column, and reports constraint failures differently. The first time this suite ran on Postgres it found three real bugs that had been passing on SQLite for weeks.

```bash
bun run test:postgres
# expects ANGUS_TEST_DATABASE_URL, e.g.
ANGUS_TEST_DATABASE_URL=postgres://postgres@localhost:5432/angus_test bun test
```

## Where things go

| Path | What lives there |
| --- | --- |
| `src/<area>/` | Library code, with its unit tests beside it |
| `tests/` | Cross-cutting suites that exercise several areas at once |
| `docs/` | The documentation site source |
| `examples/` | Runnable projects |
| `scripts/` | Development tooling |

Unit tests sit next to the code they test. Tests that span areas — the plugin surface, dialect conformance, the production audit — live in `tests/`, which also keeps them out of the published package.

The dependency direction is strictly downward: `core` may import `routing`, `routing` may import `db`, and `db` imports nothing from Angus except the top-level leaves. [ARCHITECTURE.md](ARCHITECTURE.md) explains why, and a change that inverts it will look fine and break the thing the architecture exists to protect.

## What a good change looks like

**Tests assert behaviour, not implementation.** A test named for the bug it prevents is worth three that restate the code.

**Comments explain why, not what.** If a line looks wrong but is right, say what would break otherwise. Most comments in this codebase exist because something failed in a way that was not obvious.

**Verify rather than assume.** Several bugs in this project's history came from believing something about a dependency without checking. If you are asserting how Elysia, Drizzle or Bun behaves, probe it — [UPSTREAM.md](UPSTREAM.md) is a record of three such assumptions that turned out to be wrong.

**New field types need four consumers updated**, not one: the Drizzle bridge, the TypeBox schemas, the admin widgets and the MCP tools. That is the cost of the property that keeps the surfaces from drifting.

## Before opening a pull request

```bash
bun run typecheck
bun test
bun run test:postgres
```

CI runs all three plus a scaffold smoke test that generates a project and typechecks it.

## Commit messages

Explain why the change is right, not what the diff shows. If you fixed a bug, say what it did and how it was found — that is the part nobody can reconstruct later.
