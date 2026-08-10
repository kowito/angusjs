/**
 * `routes`, `models`, `check`, `shell` — the introspection commands.
 *
 * These all work without binding a port, which is the point: the router is a
 * data structure before it is a server.
 */

import { resolve } from 'node:path'
import { appModels } from '../../core/app.ts'
import type { LoadedProject } from '../../core/config.ts'
import { projectRouter, projectSpec } from '../../core/project.ts'
import { deployChecks, hasBlockingFindings, type Finding } from '../../core/deploy.ts'
import { resolveSettings } from '../../core/settings.ts'
import { connect } from '../../db/connection.ts'
import type { FieldMap } from '../../db/model.ts'
import { bold, cyan, dim, green, info, magenta, red, success, table, warn, yellow } from '../ui.ts'

const METHOD_COLOURS: Record<string, (text: string) => string> = {
  GET: green,
  POST: cyan,
  PUT: yellow,
  PATCH: yellow,
  DELETE: magenta,
}

export async function routes(project: LoadedProject): Promise<number> {
  const settings = resolveSettings(project.settings)
  const flattened = projectRouter(settings.apps, settings.prefix).flatten()

  if (flattened.length === 0) {
    warn('No routes. Add an app with `urls` to your settings.')
    return 0
  }

  const rows = flattened
    .sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method))
    .map((route) => {
      const method = route.method.toUpperCase()
      const colour = METHOD_COLOURS[method] ?? ((text: string) => text)
      return [
        colour(method),
        route.path,
        route.name ?? dim('—'),
        route.permissions?.length ? dim(`${route.permissions.length} permission(s)`) : dim('public'),
      ]
    })

  table(rows, { head: ['METHOD', 'PATH', 'NAME', 'ACCESS'] })
  info('')
  info(dim(`${flattened.length} route${flattened.length === 1 ? '' : 's'} across ${settings.apps.length} app(s)`))
  return 0
}

/**
 * Writes the OpenAPI document to stdout, or to a file with `--out`.
 * Nothing else is printed to stdout so `angus openapi > api.json` works.
 */
export async function openapi(project: LoadedProject, args: string[]): Promise<number> {
  const spec = projectSpec(project.settings)
  const json = args.includes('--compact') ? JSON.stringify(spec) : JSON.stringify(spec, null, 2)

  const outIndex = args.indexOf('--out')
  if (outIndex === -1) {
    console.log(json)
    return 0
  }

  const target = args[outIndex + 1]
  if (!target) throw new Error('`--out` needs a file path.')
  await Bun.write(resolve(project.root, target), `${json}\n`)

  const operations = Object.values(spec.paths).reduce((total, methods) => total + Object.keys(methods).length, 0)
  success(`Wrote ${operations} operation(s) to ${target}`)
  return 0
}

export async function models(project: LoadedProject): Promise<number> {
  const settings = resolveSettings(project.settings)

  for (const app of settings.apps) {
    const owned = Object.values(app.models)
    if (owned.length === 0) continue

    info(`\n${bold(app.name)} ${dim(`(${app.prefix})`)}`)
    for (const model of owned) {
      info(`  ${cyan(model.name)} ${dim(`→ ${model.meta.tableName}`)}`)
      const rows = Object.entries(model.fields as FieldMap).map(([attr, field]) => {
        const spec = field.spec
        const flags = [
          spec.primaryKey && 'pk',
          spec.unique && !spec.primaryKey && 'unique',
          spec.null && 'null',
          spec.index && 'index',
          spec.hasDefault && 'default',
        ].filter(Boolean) as string[]
        return [
          `    ${attr}`,
          dim(spec.kind + (spec.kind === 'foreignKey' ? ` → ${spec.to?.().name ?? '?'}` : '')),
          dim(model.columns[attr] ?? ''),
          dim(flags.join(', ')),
        ]
      })
      table(rows)
    }
  }

  const total = appModels(settings.apps).length
  info('')
  info(dim(`${total} model${total === 1 ? '' : 's'}`))
  return 0
}

const SEVERITY_STYLE: Record<Finding['severity'], (text: string) => string> = {
  error: red,
  warning: yellow,
  info: cyan,
}

/**
 * `--deploy` adds the production audit: settings that are harmless in
 * development and dangerous in production.
 */
async function deploy(project: LoadedProject, args: string[]): Promise<number> {
  const findings = deployChecks(project.settings, { production: args.includes('--production') })

  if (findings.length === 0) {
    success('No deployment issues found.')
    return 0
  }

  const counts = { error: 0, warning: 0, info: 0 }
  for (const finding of findings) counts[finding.severity]++

  for (const severity of ['error', 'warning', 'info'] as const) {
    const group = findings.filter((finding) => finding.severity === severity)
    if (group.length === 0) continue

    info('')
    for (const finding of group) {
      info(`${SEVERITY_STYLE[severity](severity.toUpperCase())}  ${finding.message}`)
      info(`       ${dim(finding.id)}`)
      if (finding.hint) info(`       ${dim(finding.hint)}`)
    }
  }

  info('')
  info(
    `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} note(s). ` +
      dim('Silence one with deployChecks({ silence: [id] }).'),
  )

  return hasBlockingFindings(findings) ? 1 : 0
}

/** Validates the project without starting it — the pre-flight check. */
export async function check(project: LoadedProject, args: string[] = []): Promise<number> {
  if (args.includes('--deploy')) return deploy(project, args)

  const problems: string[] = []
  const settings = resolveSettings(project.settings)

  if (settings.apps.length === 0) problems.push('No apps installed.')
  if (!settings.database) problems.push('No `database` configured; the ORM will not work.')

  const allModels = appModels(settings.apps)
  const tableNames = new Map<string, string>()
  for (const model of allModels) {
    const existing = tableNames.get(model.meta.tableName)
    if (existing) {
      problems.push(
        `Models "${existing}" and "${model.name}" both map to table "${model.meta.tableName}". ` +
          'Set `meta.tableName` on one of them.',
      )
    }
    tableNames.set(model.meta.tableName, model.name)
  }

  // A foreign key pointing at a model that isn't installed would produce a
  // table with a dangling reference.
  const installed = new Set(allModels.map((model) => model.name))
  for (const model of allModels) {
    for (const [attr, field] of Object.entries(model.fields as FieldMap)) {
      if (field.spec.kind !== 'foreignKey') continue
      const target = field.spec.to?.()
      if (!target) {
        problems.push(`"${model.name}.${attr}" has an unresolvable foreign key target.`)
      } else if (!installed.has(target.name)) {
        problems.push(
          `"${model.name}.${attr}" points at model "${target.name}", which no installed app lists in \`models\`.`,
        )
      }
    }
  }

  const paths = new Set<string>()
  for (const route of projectRouter(settings.apps, settings.prefix).flatten()) {
    const key = `${route.method} ${route.path}`
    if (paths.has(key)) problems.push(`Duplicate route: ${key}`)
    paths.add(key)
  }

  if (problems.length === 0) {
    success(`No issues found (${settings.apps.length} app(s), ${allModels.length} model(s), ${paths.size} route(s)).`)
    return 0
  }

  for (const problem of problems) warn(problem)
  return 1
}

/**
 * An interactive REPL with the project's models in scope. Bun's repl is
 * launched as a subprocess with a preamble that imports everything.
 */
export async function shell(project: LoadedProject): Promise<number> {
  const settings = resolveSettings(project.settings)
  const allModels = appModels(settings.apps)

  if (settings.database) {
    await connect(settings.database, allModels)
    info(dim(`Connected to ${settings.database.url} (${settings.database.dialect})`))
  }

  info(`${bold('angus shell')} — models in scope: ${allModels.map((m) => cyan(m.name)).join(', ')}`)
  info(dim('Example: await post.objects.filter({ published: true }).limit(5)'))
  info(dim('Ctrl-D to exit.\n'))

  // Bun's REPL can't be embedded, so expose the models globally and hand over.
  const scope = globalThis as Record<string, unknown>
  for (const model of allModels) scope[model.name] = model
  scope.settings = settings

  const { default: repl } = await import('node:repl')
  const server = repl.start({ prompt: '>>> ' })
  for (const model of allModels) server.context[model.name] = model
  server.context.settings = settings

  await new Promise<void>((done) => server.on('exit', () => done()))
  return 0
}
