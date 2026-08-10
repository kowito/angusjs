/**
 * `angus generate` — scaffold within an existing app.
 *
 * `startapp` creates the folder; this adds to it. The distinction matters
 * because the second and third model of an app are the common case, and having
 * to copy the first one by hand is where consistency starts to drift.
 *
 * Generated code is appended to existing files rather than overwriting them, so
 * running it twice cannot silently discard work.
 */

import { resolve } from 'node:path'
import type { LoadedProject } from '../../core/config.ts'
import { bold, cyan, dim, info, success, warn } from '../ui.ts'

const FIELD_TYPES: Record<string, string> = {
  string: 'f.char({ maxLength: 200 })',
  text: 'f.text({ blank: true, default: \'\' })',
  int: 'f.integer({ default: 0 })',
  float: 'f.float({ default: 0 })',
  decimal: 'f.decimal()',
  bool: 'f.boolean({ default: false })',
  date: 'f.date()',
  datetime: 'f.datetime()',
  email: 'f.email()',
  slug: 'f.slug({ unique: true })',
  url: 'f.url()',
  uuid: 'f.uuid()',
  json: 'f.json()',
  file: 'f.file({ null: true })',
  image: 'f.image({ null: true })',
}

const pascal = (value: string) =>
  value.replace(/(^|[-_\s]+)([a-z])/g, (_, __, char: string) => char.toUpperCase())

const camel = (value: string) => {
  const upper = pascal(value)
  return upper.charAt(0).toLowerCase() + upper.slice(1)
}

/** `title:string status:bool author:fk=User` -> field declarations. */
function parseFields(specs: string[]): { lines: string[]; imports: Set<string> } {
  const lines: string[] = []
  const imports = new Set<string>()

  for (const spec of specs) {
    const [name, rawType = 'string'] = spec.split(':')
    if (!name) continue

    if (rawType.startsWith('fk=')) {
      const target = pascal(rawType.slice(3))
      imports.add(target)
      lines.push(`    ${camel(name)}: f.foreignKey(() => ${target}),`)
      continue
    }

    const declaration = FIELD_TYPES[rawType]
    if (!declaration) {
      throw new Error(
        `Unknown field type "${rawType}" for "${name}". ` +
          `Known: ${Object.keys(FIELD_TYPES).join(', ')}, or fk=Model.`,
      )
    }

    lines.push(`    ${camel(name)}: ${declaration},`)
  }

  return { lines, imports }
}

/**
 * Adds named imports to a file, merging into an existing import from the same
 * module rather than adding a second one.
 *
 * Appending code without this is the whole failure mode of a generator: the
 * file grows a reference to something it never imported, and the project stops
 * compiling at exactly the moment the tool reported success.
 */
async function ensureImport(path: string, names: string[], from: string): Promise<void> {
  const file = Bun.file(path)
  if (!(await file.exists())) return

  let source = await file.text()
  const existing = new RegExp(`^import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${from.replace('.', '\\.')}['"]`, 'm')
  const match = existing.exec(source)

  if (match) {
    const current = match[1]!.split(',').map((name) => name.trim()).filter(Boolean)
    const merged = [...new Set([...current, ...names])].sort()
    if (merged.length === current.length) return
    source = source.replace(match[0], `import { ${merged.join(', ')} } from '${from}'`)
  } else {
    const line = `import { ${[...new Set(names)].sort().join(', ')} } from '${from}'`
    const lastImport = [...source.matchAll(/^import .*$/gm)].pop()
    source = lastImport
      ? source.slice(0, lastImport.index! + lastImport[0].length) +
        `\n${line}` +
        source.slice(lastImport.index! + lastImport[0].length)
      : `${line}\n${source}`
  }

  await Bun.write(path, source)
}

/**
 * Adds the model to the app's `models` map.
 *
 * `appModels(settings.apps)` is what `makemigrations` reads, so a model missing
 * from here gets no table — and nothing complains until the first query.
 */
async function registerWithApp(appDir: string, appName: string, Model: string): Promise<void> {
  const path = resolve(appDir, 'app.ts')
  const file = Bun.file(path)
  if (!(await file.exists())) return

  const source = await file.text()
  const models = /models:\s*\{([^}]*)\}/.exec(source)

  if (!models) {
    warn(`Could not find a \`models\` map in apps/${appName}/app.ts — add ${Model} to it yourself.`)
    return
  }

  const current = models[1]!.split(',').map((name) => name.trim()).filter(Boolean)
  if (current.includes(Model)) return

  const merged = [...current, Model].join(', ')
  await Bun.write(path, source.replace(models[0], `models: { ${merged} }`))
  await ensureImport(path, [Model], './models.ts')
}

/** Appends to a file, or creates it with `header` when absent. */
async function append(path: string, header: string, body: string): Promise<'created' | 'appended'> {
  const file = Bun.file(path)

  if (!(await file.exists())) {
    await Bun.write(path, `${header}${body}`)
    return 'created'
  }

  const existing = await file.text()
  await Bun.write(path, `${existing.trimEnd()}\n${body}`)
  return 'appended'
}

export async function generate(project: LoadedProject, args: string[]): Promise<number> {
  const [what, appName, modelName, ...fieldSpecs] = args

  if (what !== 'crud' && what !== 'model') {
    info(`${bold('angus generate')}\n`)
    info(`  ${cyan('angus generate model <app> <Name> [field:type ...]')}`)
    info(`  ${cyan('angus generate crud  <app> <Name> [field:type ...]')}`)
    info('')
    info(`Types: ${dim(Object.keys(FIELD_TYPES).join(', '))}, ${dim('fk=Model')}`)
    info(`Example: ${dim('angus generate crud blog Comment body:text approved:bool post:fk=Post')}`)
    return what === undefined ? 0 : 1
  }

  if (!appName || !modelName) {
    throw new Error(`Usage: angus generate ${what} <app> <Name> [field:type ...]`)
  }

  const appDir = resolve(project.root, 'apps', appName)
  if (!(await Bun.file(resolve(appDir, 'app.ts')).exists())) {
    throw new Error(`No app at apps/${appName}/. Create it first with \`angus startapp ${appName}\`.`)
  }

  const Model = pascal(modelName)
  const model = camel(modelName)
  const { lines, imports } = parseFields(fieldSpecs)

  const fieldBlock =
    lines.length > 0
      ? lines.join('\n')
      : `    name: f.char({ maxLength: 200 }),\n    createdAt: f.datetime({ autoNowAdd: true }),`

  // --- model ---------------------------------------------------------------

  const modelSource = `
export const ${Model} = defineModel(${JSON.stringify(model)}, {
  fields: {
${fieldBlock}
  },
  meta: {
    ordering: ['-id'],
  },
})
`

  const modelsPath = resolve(appDir, 'models.ts')
  const modelStatus = await append(modelsPath, `import { defineModel, f } from 'angusjs/db'\n`, modelSource)
  info(`${modelStatus === 'created' ? 'created' : 'updated'}  apps/${appName}/models.ts`)

  // A relation target normally lives in this same file, so no import is added.
  // If it does not, say so rather than emitting one that points at the wrong
  // module — the developer knows where their model actually is.
  const modelsSource = await Bun.file(modelsPath).text()
  for (const target of imports) {
    if (!new RegExp(`\\bexport const ${target}\\b`).test(modelsSource)) {
      warn(`"${target}" is not defined in apps/${appName}/models.ts — import it there yourself.`)
    }
  }

  // Registering the model with its app is what makes migrations see it. Left
  // out, the code compiles, the routes appear, and the table is never created —
  // a failure that only shows up at the first request.
  await registerWithApp(appDir, appName, Model)

  if (what === 'model') {
    success(`Added the ${Model} model.`)
    info(dim('  Run `angus makemigrations` to create the table.'))
    return 0
  }

  // --- serializer ----------------------------------------------------------

  const serializerStatus = await append(
    resolve(appDir, 'serializers.ts'),
    `import { serializer } from 'angusjs/serializers'\nimport { ${Model} } from './models.ts'\n`,
    `
export const ${Model}Serializer = serializer(${Model}, {
  readOnly: ['id'],
})
`,
  )
  await ensureImport(resolve(appDir, 'serializers.ts'), [Model], './models.ts')
  info(`${serializerStatus === 'created' ? 'created' : 'updated'}  apps/${appName}/serializers.ts`)

  // --- routes --------------------------------------------------------------

  const routeSource = `
routes.include(
  '/${model}s',
  modelViewSet({
    model: ${Model},
    serializer: ${Model}Serializer,
    tags: [${JSON.stringify(appName)}],
  }),
)
`

  const urlsPath = resolve(appDir, 'urls.ts')
  if (await Bun.file(urlsPath).exists()) {
    // The scaffolded urls.ts exports a router expression directly, which cannot
    // be appended to. Say so rather than corrupting the file.
    const source = await Bun.file(urlsPath).text()
    if (source.includes('const routes = router()')) {
      const updated = source.replace(/\nexport default routes\n?$/, `${routeSource}\nexport default routes\n`)
      await Bun.write(urlsPath, updated)

      await ensureImport(urlsPath, [Model], './models.ts')
      await ensureImport(urlsPath, [`${Model}Serializer`], './serializers.ts')
      info(`updated  apps/${appName}/urls.ts`)
    } else {
      warn(`apps/${appName}/urls.ts is not in the appendable shape; add this yourself:`)
      info(dim(routeSource))
    }
  }

  // --- admin ---------------------------------------------------------------

  const adminStatus = await append(
    resolve(appDir, 'admin.ts'),
    `import admin from '../../admin.ts'\nimport { ${Model} } from './models.ts'\n`,
    `
admin.register(${Model}, {
  listDisplay: [${['id', ...lines.map((line) => line.trim().split(':')[0]!)].slice(0, 5).map((n) => JSON.stringify(n)).join(', ')}],
})
`,
  )
  await ensureImport(resolve(appDir, 'admin.ts'), [Model], './models.ts')
  info(`${adminStatus === 'created' ? 'created' : 'updated'}  apps/${appName}/admin.ts`)

  success(`Generated CRUD for ${bold(Model)}.`)
  info('')
  info(`  ${cyan('angus makemigrations')}  ${dim('# create the table')}`)
  info(`  ${cyan('angus migrate')}`)
  info(`  ${cyan('angus routes')}          ${dim('# see the six new endpoints')}`)
  return 0
}
