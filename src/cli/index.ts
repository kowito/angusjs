#!/usr/bin/env bun
/**
 * The `angus` command.
 *
 * Every command except `startproject` needs the project's settings, so the
 * config is located and loaded once here and passed down.
 */

import { loadProject, type LoadedProject } from '../core/config.ts'
import { runServer } from '../core/project.ts'
import { resolveSettings } from '../core/settings.ts'
import { check, models, openapi, routes, shell } from './commands/inspect.ts'
import { client as clientCommand } from './commands/client.ts'
import { mcp as mcpCommand } from './commands/mcp.ts'
import { generate as generateCommand } from './commands/generate.ts'
import { run as runCommand } from './commands/run.ts'
import { seed as seedCommand } from './commands/seed.ts'
import { worker as workerCommand } from './commands/worker.ts'
import { makemigrations, migrate } from './commands/migrations.ts'
import { startapp, startproject } from './commands/scaffold.ts'
import { bold, cyan, dim, fail, green, info } from './ui.ts'

const VERSION = '0.1.0'

interface Command {
  summary: string
  usage?: string
  /** Commands that scaffold a new project run outside one. */
  standalone?: boolean
  run: (context: { project: LoadedProject | null; args: string[] }) => Promise<number>
}

const COMMANDS: Record<string, Command> = {
  startproject: {
    summary: 'Create a new project directory',
    usage: 'angus startproject <name>',
    standalone: true,
    run: ({ args }) => startproject(args),
  },
  startapp: {
    summary: 'Create a new app inside the current project',
    usage: 'angus startapp <name>',
    run: ({ project, args }) => startapp(project!, args),
  },
  generate: {
    summary: 'Scaffold a model, or a model with its API and admin',
    usage: 'angus generate crud <app> <Name> [field:type ...]',
    run: ({ project, args }) => generateCommand(project!, args),
  },
  seed: {
    summary: "Run the project's seed script",
    usage: 'angus seed [--init] [--no-transaction]',
    run: ({ project, args }) => seedCommand(project!, args),
  },
  runserver: {
    summary: 'Start the development server',
    usage: 'angus runserver [--port 8000] [--host 0.0.0.0]',
    run: ({ project, args }) => runserver(project!, args),
  },
  makemigrations: {
    summary: 'Generate migrations from your models',
    usage: 'angus makemigrations [--name <label>]',
    run: ({ project, args }) => makemigrations(project!, args),
  },
  migrate: {
    summary: 'Apply pending migrations to the database',
    usage: 'angus migrate [--check] [--dry-run]',
    run: ({ project, args }) => migrate(project!, args),
  },
  routes: {
    summary: 'Print the URL table',
    run: ({ project }) => routes(project!),
  },
  models: {
    summary: 'Print every model and its columns',
    run: ({ project }) => models(project!),
  },
  openapi: {
    summary: 'Print the OpenAPI document',
    usage: 'angus openapi [--out openapi.json] [--compact]',
    run: ({ project, args }) => openapi(project!, args),
  },
  client: {
    summary: 'Generate a typed API client',
    usage: 'angus client [--out ../web/src/api.ts] [--name createClient] [--base-url https://api.example.com]',
    run: ({ project, args }) => clientCommand(project!, args),
  },
  mcp: {
    summary: 'Serve the API to agents over MCP (stdio)',
    usage: 'angus mcp [--list]',
    run: ({ project, args }) => mcpCommand(project!, args),
  },
  check: {
    summary: 'Validate the project without starting it',
    usage: 'angus check [--deploy] [--production]',
    run: ({ project, args }) => check(project!, args),
  },
  run: {
    summary: 'Invoke an application service',
    usage: "angus run <service> [--key value] [--json '{...}'] [--list]",
    run: ({ project, args }) => runCommand(project!, args),
  },
  worker: {
    summary: 'Run background jobs',
    usage: 'angus worker [--concurrency 4] [--once] [--list] [--stats] [--prune --days 7]',
    run: ({ project, args }) => workerCommand(project!, args),
  },
  shell: {
    summary: 'Open a REPL with your models loaded',
    run: ({ project }) => shell(project!),
  },
}

async function runserver(project: LoadedProject, args: string[]): Promise<number> {
  const settings = resolveSettings(project.settings)

  const portIndex = args.indexOf('--port')
  const hostIndex = args.indexOf('--host')
  if (portIndex !== -1) settings.server.port = Number(args[portIndex + 1])
  if (hostIndex !== -1) settings.server.hostname = args[hostIndex + 1]!

  const server = await runServer(settings)

  info(`${bold('angusjs')} ${dim(`v${VERSION}`)}`)
  info(`${green('→')} ${bold(server.url)}`)
  if (settings.database) info(dim(`  database  ${settings.database.url} (${settings.database.dialect})`))
  if (settings.openapi !== false) info(dim(`  docs      ${server.url}${settings.openapi?.path ?? '/docs'}`))
  info(dim(`  apps      ${settings.apps.map((app) => app.name).join(', ') || 'none'}`))
  info(dim('\nPress Ctrl-C to stop.'))

  // Resolve only on shutdown so the process stays alive.
  await new Promise<void>((done) => {
    const stop = () => {
      info(dim('\nShutting down.'))
      server.stop().then(() => done())
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })

  return 0
}

function usage(): void {
  info(`${bold('angusjs')} ${dim(`v${VERSION}`)} — Django's ergonomics on ElysiaJS\n`)
  info(`${bold('Usage')}  angus <command> [options]\n`)
  info(bold('Commands'))

  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
  for (const [name, command] of Object.entries(COMMANDS)) {
    info(`  ${cyan(name.padEnd(width))}  ${command.summary}`)
  }
  info(`\nRun ${cyan('angus <command> --help')} for usage of a single command.`)
}

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv

  if (!name || name === '--help' || name === '-h' || name === 'help') {
    usage()
    return 0
  }

  if (name === '--version' || name === '-v') {
    info(VERSION)
    return 0
  }

  const command = COMMANDS[name]
  if (!command) {
    fail(`Unknown command "${name}".`)
    info('')
    usage()
    return 1
  }

  if (args.includes('--help') || args.includes('-h')) {
    info(`${bold(name)} — ${command.summary}`)
    if (command.usage) info(`\n${dim(command.usage)}`)
    return 0
  }

  const project = command.standalone ? null : await loadProject()
  return command.run({ project, args })
}

try {
  process.exit(await main(Bun.argv.slice(2)))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
  if (Bun.env.ANGUS_TRACE) console.error(error)
  process.exit(1)
}
