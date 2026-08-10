/**
 * `angus mcp` — serves the project's tools over stdio.
 *
 * This is the transport agent runners launch as a subprocess (Claude Desktop,
 * Claude Code, editors). The HTTP endpoint is mounted automatically by
 * `runserver`; this command is for local, credential-free access.
 */

import type { LoadedProject } from '../../core/config.ts'
import { createApp, mcpIdentity, projectTools } from '../../core/project.ts'
import { resolveSettings } from '../../core/settings.ts'
import { serveStdio, log } from '../../mcp/stdio.ts'
import { SUPPORTED_VERSIONS } from '../../mcp/protocol.ts'

export async function mcp(project: LoadedProject, args: string[]): Promise<number> {
  const settings = resolveSettings(project.settings)

  if (args.includes('--list')) {
    // Human-readable inventory. Safe to print to stdout: no stream to corrupt.
    const tools = projectTools(project.settings)
    for (const tool of tools) {
      const inputs = Object.keys((tool.inputSchema.properties ?? {}) as object)
      console.log(`${tool.name}\n  ${tool.route.method.toUpperCase()} ${tool.route.path}`)
      console.log(`  args: ${inputs.length > 0 ? inputs.join(', ') : '(none)'}`)
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

  await serveStdio({ app, tools, identity, origin: 'http://mcp.local' })

  log('angus mcp: client disconnected')
  return 0
}
