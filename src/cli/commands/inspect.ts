/**
 * `routes`, `models`, `check`, `shell` — the introspection commands.
 *
 * These all work without binding a port, which is the point: the router is a
 * data structure before it is a server.
 */

import { appModels } from '../../core/app.ts'
import type { LoadedProject } from '../../core/config.ts'
import { projectRouter } from '../../core/project.ts'
import { resolveSettings } from '../../core/settings.ts'
import { connect } from '../../db/connection.ts'
import type { FieldMap } from '../../db/model.ts'
import { bold, cyan, dim, green, info, magenta, success, table, warn, yellow } from '../ui.ts'

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

/** Validates the project without starting it — the pre-flight check. */
export async function check(project: LoadedProject): Promise<number> {
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
