/**
 * `angus run <service>` — invoke an application service from the terminal.
 *
 * The same declaration that backs the HTTP endpoint and the MCP tool, called
 * with no server running. Useful for backfills, one-off operations and cron.
 */

import type { LoadedProject } from '../../core/config.ts'
import { createApp } from '../../core/project.ts'
import { callService, getService, registeredServices } from '../../services/index.ts'
import { bold, cyan, dim, info, success } from '../ui.ts'

/** `--postId 3 --notify` becomes `{ postId: '3', notify: true }`. */
function parseArgs(args: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {}

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) {
      input[key] = true
    } else {
      input[key] = next
      index++
    }
  }

  return input
}

export async function run(project: LoadedProject, args: string[]): Promise<number> {
  // Importing the settings registers every app, and with it every service.
  const services = registeredServices()

  if (args.length === 0 || args.includes('--list')) {
    if (services.length === 0) {
      info('No services defined. Create one with `service({ ... })` and import it from your app.')
      return 0
    }
    info(bold('Services'))
    for (const definition of services) {
      info(`  ${cyan(definition.name)}${definition.summary ? dim(`  ${definition.summary}`) : ''}`)
    }
    info(`\nRun one with ${dim('angus run <name> --key value')}, or pass ${dim('--json \'{...}\'')}.`)
    return 0
  }

  const [name, ...rest] = args
  const definition = getService(name!)
  if (!definition) {
    throw new Error(
      `No service named "${name}". Available: ${services.map((s) => s.name).join(', ') || '(none)'}.`,
    )
  }

  const jsonIndex = rest.indexOf('--json')
  const input = jsonIndex === -1 ? parseArgs(rest) : JSON.parse(rest[jsonIndex + 1] ?? '{}')

  // Building the app opens the database and runs each app's `ready()`.
  await createApp(project.settings)

  // `system` because a terminal operator has already been trusted by the shell;
  // there is no request identity to check permissions against.
  const result = await callService(definition, input, { system: true })

  success(`${definition.name} completed`)
  if (result !== undefined) console.log(JSON.stringify(result, null, 2))
  return 0
}
