---
title: CLI
section: Running it
order: 2
---

# CLI

```bash
bun run angus <command>
```

## Projects and apps

| Command | What it does |
| --- | --- |
| `startproject <name>` | Create a project |
| `startapp <name>` | Scaffold an app inside it |
| `generate crud <app> <Name> [field:type ...]` | Add a model with its API and admin |
| `seed` | Run the project's `seed.ts` in a transaction |

`generate` appends rather than overwrites, manages the imports, and registers the model with its app — that last one is what makes migrations see it.

```bash
angus generate crud blog Comment body:text approved:bool post:fk=Post
```

Field types: `string`, `text`, `int`, `float`, `decimal`, `bool`, `date`, `datetime`, `email`, `slug`, `url`, `uuid`, `json`, `file`, `image`, and `fk=Model`.

## Database

| Command | What it does |
| --- | --- |
| `makemigrations` | Generate SQL from the models |
| `migrate` | Apply pending migrations |
| `migrate --check` | Exit non-zero if any are pending — for CI |
| `shell` | REPL with the models and connection loaded |

## Inspection

| Command | What it does |
| --- | --- |
| `routes` | The URL table, without booting a server |
| `models` | Every model and its fields |
| `openapi` | Write the OpenAPI document |
| `check` | Look for problems before they are deployed |

## Running

| Command | What it does |
| --- | --- |
| `runserver` | Development server |
| `worker` | Background job worker |
| `run <service>` | Invoke an application service from the shell |

## Clients and agents

| Command | What it does |
| --- | --- |
| `client` | Generate a typed TypeScript client |
| `mcp` | Serve MCP over stdio |
| `mcp --list` | What an agent would see |
| `mcp install [client]` | Register with Claude Code, Cursor or Claude Desktop |

The typed client is generated from the route table rather than from the server's type, because mounting routes as data erases the type Eden would need.
