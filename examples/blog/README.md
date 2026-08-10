# blog example

Three related models, a view set each, and a couple of hand-written views.

Run it from the repository root (the example resolves `angusjs` through the root
`tsconfig.json` paths, so no install step is needed):

```bash
cd examples/blog
bun ../../src/cli/index.ts migrate
bun ../../src/cli/index.ts runserver
```

Then:

```bash
curl -X POST localhost:8000/api/authors \
  -H 'content-type: application/json' \
  -d '{"name":"Grace Hopper","email":"grace@example.com"}'

curl -X POST localhost:8000/api/posts \
  -H 'content-type: application/json' \
  -d '{"title":"On Compilers","slug":"on-compilers","body":"...","status":"published","author":1}'

curl 'localhost:8000/api/posts?status=published&ordering=-views&pageSize=5'
curl localhost:8000/api/posts/by-slug/on-compilers   # increments the view counter
curl localhost:8000/api/stats

open localhost:8000/docs      # API reference
curl localhost:8000/openapi.json
open localhost:8000/admin     # the admin interface
```

The same routes are exposed to agents over MCP:

```bash
bun ../../src/cli/index.ts mcp --list        # 17 tools

# Streamable HTTP, while the server runs
curl -X POST localhost:8000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# or over stdio, the way an agent runner launches it
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"blog-stats","arguments":{}}}' \
  | bun ../../src/cli/index.ts mcp
```

Worth reading in order:

- `apps/blog/models.ts` — three models, two foreign keys, one of them nullable
- `apps/blog/serializers.ts` — a nested relation and two computed fields
- `apps/blog/urls.ts` — three view sets plus two hand-written views
- `apps/blog/admin.ts` — registers the models with the admin
- `admin.ts` / `angus.config.ts` — the admin site and the whole project in one file
