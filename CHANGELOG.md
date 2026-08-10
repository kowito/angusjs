# Changelog

All notable changes to Angus are recorded here. Pre-1.0, minor versions may
contain breaking changes; those are listed first in each entry.

## Unreleased

### Added

**Application services** — the fourth primitive, alongside models, serializers
and view sets. A service declares its input schema, output schema, permissions
and transaction boundary; REST, OpenAPI, MCP and the CLI all read that one
declaration rather than re-implementing the operation.

```ts
export const approveInvoice = service({
  name: 'approve-invoice',
  input: t.Object({ invoiceId: t.Numeric() }),
  output: InvoiceSerializer.read,
  permissions: [isStaff],
  async handler({ input, actor }) { /* ... */ },
})

router().post('/invoices/:invoiceId/approve', fromService(approveInvoice, {
  params: t.Object({ invoiceId: t.Numeric() }),
}))
```

Mounting is the only adapter: OpenAPI and MCP already read the route table, so
a mounted service reaches every surface with no second registration and no
second place for them to disagree. Also callable as `angus run approve-invoice
--invoiceId 3`.

**Identity and authorization** (`angusjs/auth`) — one security model consumed by
REST, the admin and MCP alike.

- `User`, `Session` and `VerificationToken` models. Sessions cover browser
  logins and API tokens, which differ only in how the secret travels.
- argon2id password hashing via `Bun.password` — no dependency added.
- Endpoints: login, logout, register (opt-in), `me`, API token issue/list/revoke,
  password change, password reset request and confirm.
- Bearer tokens and `HttpOnly` session cookies resolve to the same identity.
- Permissions: `isAuthenticated`, `isStaff`, `isSuperuser`, `hasRole`,
  `hasScope`, `isOwner`, `all`, `any`, and `ownedBy` for row-level scoping.
- **Admin login** (`adminAuthApp()`), so the admin is no longer development-only.

**Transactions** — `atomic()` with savepoint nesting, and `rollbackAfter()`.
Ambient via `AsyncLocalStorage`, so a query several frames deep inside a service
joins the transaction without a handle being threaded through.

**F-expressions** — `update({ views: F('views').add(1) })` compiles to
`SET views = views + 1`, which the database applies atomically. Also usable to
compare two columns in a filter: `filter({ price__lt: F('cost') })`.

**Testing utilities** (`angusjs/testing`) — `testDatabase()` creating tables
directly from model definitions, `transactional()` cases that roll back,
`TestClient` driving the app with no port, and `factory()` for fixtures.

**Elysia plugin surface** (`angusjs/plugin`) — `angus()`, `mount()`,
`openapi()`, `mcp()` and `admin()` as ordinary Elysia plugins, so an existing
Elysia application can adopt one piece without adopting the conventions.

**Error contract** (`ERROR_CODES`) — a stable machine-readable `code` on every
error response, so clients branch on a code rather than matching a message.
Shared by REST, the admin, MCP and OpenAPI.

**IR conformance suite** — asserts that every field kind produces a coherent
result on all four consumers (Drizzle column, TypeBox schema, admin widget, MCP
tool parameter). Adding a field kind now means filling in a table row; omitting
a consumer fails here rather than in an application.

### Fixed

- **`atomic()` does not use Drizzle's `bun-sqlite` transaction**, which is
  synchronous and silently commits when its callback is async — a thrown error
  did not roll back. Angus issues `BEGIN`/`SAVEPOINT` itself on SQLite; Postgres
  keeps the driver's own transaction because its connection is pooled.
- `json` fields serialised to an empty `{}` schema, telling OpenAPI readers and
  agents nothing. Found by the conformance suite.
- A permission may now short-circuit with a `Response`, which is what lets the
  admin redirect an anonymous browser to a login page instead of returning 403.
- `./http` was exported without a barrel file and failed to resolve.
- `./testing` pointed at a file that did not exist; it now has an implementation.

### Added — housekeeping

- `LICENSE` (MIT), which `package.json` had claimed without shipping.
- GitHub Actions CI: typecheck, tests, and a scaffold smoke test that catches a
  broken generator — invisible to unit tests, fatal to every new user.
- This changelog.

## 0.1.0

Initial release: models, migrations, QuerySets with typed lookups, serializers,
views and view sets, permissions, admin, OpenAPI 3.1, MCP (dual-era), and the
`angus` CLI.
