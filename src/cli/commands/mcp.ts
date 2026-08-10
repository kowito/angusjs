/**
 * `angus mcp` — serves the project's tools over stdio.
 *
 * This is the transport agent runners launch as a subprocess (Claude Desktop,
 * Claude Code, editors). The HTTP endpoint is mounted automatically by
 * `runserver`; this command is for local, credential-free access.
 */

import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import type { LoadedProject } from '../../core/config.ts'
import { createApp, mcpIdentity, projectTools } from '../../core/project.ts'
import { resolveSettings, type McpSettings } from '../../core/settings.ts'
import { jsonlAuditSink, type AuditSink } from '../../mcp/audit.ts'
import { needsConfirmation } from '../../mcp/policy.ts'
import { serveStdio, log } from '../../mcp/stdio.ts'
import { SUPPORTED_VERSIONS } from '../../mcp/protocol.ts'
import { dim, info, success, warn } from '../ui.ts'

export async function mcp(project: LoadedProject, args: string[]): Promise<number> {
  const settings = resolveSettings(project.settings)
  const mcpSettings = settings.mcp === false ? {} : (settings.mcp ?? {})

  if (args[0] === 'install') return install(project, args.slice(1))

  if (args.includes('--list')) {
    // Human-readable inventory. Safe to print to stdout: no stream to corrupt.
    const tools = projectTools(project.settings)
    for (const tool of tools) {
      const inputs = Object.keys((tool.inputSchema.properties ?? {}) as object)
      console.log(`${tool.name}\n  ${tool.route.method.toUpperCase()} ${tool.route.path}`)
      console.log(`  args: ${inputs.length > 0 ? inputs.join(', ') : '(none)'}`)
      // Worth seeing at a glance which tools an agent cannot fire off alone.
      if (needsConfirmation(tool, mcpSettings.policy)) console.log('  needs confirmation')
    }
    console.log(`\n${tools.length} tool(s)`)
    return 0
  }

  // Everything the server prints must go to stderr — stdout carries the
  // protocol, and a stray log line would corrupt the stream.
  const app = await createApp(project.settings)
  const tools = projectTools(project.settings)
  const identity = mcpIdentity(project.settings)

  log(`angus mcp: ${identity.name} v${identity.version}`)
  log(`  protocol  ${SUPPORTED_VERSIONS.join(', ')}`)
  log(`  tools     ${tools.length}`)
  if (settings.database) log(`  database  ${settings.database.url} (${settings.database.dialect})`)

  await serveStdio({
    app,
    tools,
    identity,
    // The same policy the HTTP endpoint enforces. A local agent is not a
    // trusted one: it is the one most likely to be pointed at production data.
    policy: mcpSettings.policy,
    audit: mcpSettings.audit === undefined ? undefined : resolveCliAuditSink(mcpSettings.audit),
    origin: 'http://mcp.local',
  })

  log('angus mcp: client disconnected')
  return 0
}

/** The stdio server cannot log to the console — stdout carries the protocol. */
function resolveCliAuditSink(audit: NonNullable<McpSettings['audit']>): AuditSink | undefined {
  if (audit === false) return undefined
  if (typeof audit === 'function') return audit
  return jsonlAuditSink(typeof audit === 'string' ? audit : 'mcp-audit.jsonl')
}

/**
 * `angus mcp install` — registers this project with an agent client.
 *
 * The step it removes is small but reliably annoying: finding the client's
 * config file, getting the JSON shape right, and remembering the absolute path
 * of a project you are standing in. Getting any of the three wrong produces a
 * client that silently lists no tools.
 */
async function install(project: LoadedProject, args: string[]): Promise<number> {
  const client = args.find((arg) => !arg.startsWith('-')) ?? 'claude-code'
  const name = flagValue(args, '--name') ?? basename(project.root)

  const entry = {
    command: 'bun',
    // `angus` resolves through the project's own node_modules, so the client
    // launches the version this project depends on rather than a global one.
    args: ['run', 'angus', 'mcp'],
    cwd: project.root,
  }

  const target = CLIENT_CONFIGS[client]
  if (!target) {
    warn(`Unknown client "${client}".`)
    info(`  Known: ${Object.keys(CLIENT_CONFIGS).join(', ')}`)
    info('')
    info('For anything else, add this to its MCP configuration:')
    console.log(JSON.stringify({ mcpServers: { [name]: entry } }, null, 2))
    return 1
  }

  const path = target.path(project.root)

  // Merged rather than written: this file usually already lists other servers,
  // and replacing it would quietly remove them.
  let config: Record<string, any> = {}
  const file = Bun.file(path)
  if (await file.exists()) {
    try {
      config = JSON.parse(await file.text())
    } catch {
      warn(`${path} is not valid JSON. Fix or move it, then run this again.`)
      return 1
    }
  }

  const servers = (config[target.key] ??= {})
  const replacing = name in servers
  servers[name] = entry

  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`)

  success(`${replacing ? 'Updated' : 'Added'} "${name}" in ${path}`)
  info(dim(`  Restart ${target.label} to pick it up.`))
  return 0
}

const CLIENT_CONFIGS: Record<string, { label: string; key: string; path: (root: string) => string }> = {
  'claude-code': {
    label: 'Claude Code',
    key: 'mcpServers',
    // Project-scoped, so it travels with the repository.
    path: (root) => resolve(root, '.mcp.json'),
  },
  cursor: {
    label: 'Cursor',
    key: 'mcpServers',
    path: (root) => resolve(root, '.cursor', 'mcp.json'),
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    key: 'mcpServers',
    path: () =>
      process.platform === 'darwin'
        ? resolve(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json')
        : resolve(homedir(), '.config/Claude/claude_desktop_config.json'),
  },
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
