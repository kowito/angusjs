/**
 * `startproject` and `startapp` — the scaffolding that makes a new project
 * runnable in one command, the way `django-admin startproject` does.
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LoadedProject } from '../../core/config.ts'
import { bold, cyan, dim, info, success } from '../ui.ts'

const VALID_NAME = /^[a-z][a-z0-9_-]*$/i

function assertName(kind: string, name: string | undefined): asserts name is string {
  if (!name) throw new Error(`Usage: angus start${kind} <name>`)
  if (!VALID_NAME.test(name)) {
    throw new Error(`"${name}" is not a valid ${kind} name — start with a letter, then letters, digits, - or _.`)
  }
}

async function writeFile(path: string, contents: string): Promise<void> {
  if (await Bun.file(path).exists()) {
    throw new Error(`${path} already exists — refusing to overwrite it.`)
  }
  await Bun.write(path, contents)
}

// ---------------------------------------------------------------------------
// startproject
// ---------------------------------------------------------------------------

export async function startproject(args: string[]): Promise<number> {
  const name = args[0]
  assertName('project', name)

  const root = resolve(process.cwd(), name)
  if (await Bun.file(resolve(root, 'angus.config.ts')).exists()) {
    throw new Error(`${name}/angus.config.ts already exists.`)
  }

  await mkdir(resolve(root, 'apps'), { recursive: true })

  await writeFile(
    resolve(root, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version: '0.1.0',
        type: 'module',
        private: true,
        scripts: {
          dev: 'angus runserver',
          migrate: 'angus migrate',
          makemigrations: 'angus makemigrations',
          typecheck: 'tsc --noEmit',
        },
        dependencies: {
          angusjs: '^0.1.0',
          // drizzle-kit resolves drizzle-orm from the project root, so it has
          // to be a direct dependency even though angusjs re-exports it.
          'drizzle-orm': '^0.45.2',
          elysia: '^1.4.29',
        },
        devDependencies: {
          '@elysiajs/openapi': '^1.4.15',
          '@types/bun': 'latest',
          'drizzle-kit': '^0.31.10',
          typescript: '^5.9.2',
        },
      },
      null,
      2,
    )}\n`,
  )

  await writeFile(
    resolve(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ESNext'],
          target: 'ESNext',
          module: 'Preserve',
          moduleDetection: 'force',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          types: ['bun-types'],
        },
        include: ['.'],
      },
      null,
      2,
    )}\n`,
  )

  await writeFile(
    resolve(root, 'admin.ts'),
    `import { adminSite } from 'angusjs/admin'

/**
 * The project's admin site. Each app registers its own models into it from
 * \`apps/<name>/admin.ts\`.
 *
 * With no \`permissions\` configured the admin serves in development and refuses
 * to serve in production. Before deploying, give it a real check:
 *
 *   adminSite({ title: ${JSON.stringify(`${name} admin`)}, permissions: [isStaff] })
 */
export default adminSite({ title: ${JSON.stringify(`${name} admin`)} })
`,
  )

  await writeFile(
    resolve(root, 'angus.config.ts'),
    `import { defineSettings } from 'angusjs'
import admin from './admin.ts'

export default defineSettings({
  // Every app the project serves. \`angus startapp <name>\` creates one.
  // The admin mounts at /admin, outside the \`prefix\` below.
  apps: [admin.app()],

  database: {
    dialect: 'sqlite',
    url: 'db.sqlite',
  },

  // Mounted in front of every app's own prefix.
  prefix: '/api',

  server: {
    port: 8000,
  },

  openapi: {
    title: ${JSON.stringify(name)},
    version: '0.1.0',
  },
})
`,
  )

  await writeFile(
    resolve(root, 'main.ts'),
    `import { runServer } from 'angusjs'
import settings from './angus.config.ts'

// \`angus runserver\` uses this too; running it directly works for deployment.
const server = await runServer(settings)
console.log(\`Listening on \${server.url}\`)
`,
  )

  await writeFile(
    resolve(root, '.gitignore'),
    `node_modules/
.angus/
*.sqlite
*.sqlite-shm
*.sqlite-wal
.env
`,
  )

  await Bun.write(resolve(root, 'apps/.gitkeep'), '')

  success(`Created project ${bold(name)}`)
  info('')
  info('Next:')
  info(`  ${cyan(`cd ${name}`)}`)
  info(`  ${cyan('bun install')}`)
  info(`  ${cyan('angus startapp blog')}       ${dim('# create your first app')}`)
  info(`  ${cyan('angus makemigrations')}      ${dim('# generate the schema')}`)
  info(`  ${cyan('angus migrate')}             ${dim('# apply it')}`)
  info(`  ${cyan('angus runserver')}`)
  return 0
}

// ---------------------------------------------------------------------------
// startapp
// ---------------------------------------------------------------------------

export async function startapp(project: LoadedProject, args: string[]): Promise<number> {
  const name = args[0]
  assertName('app', name)

  const appDir = resolve(project.root, 'apps', name)
  if (await Bun.file(resolve(appDir, 'app.ts')).exists()) {
    throw new Error(`apps/${name}/app.ts already exists.`)
  }
  await mkdir(appDir, { recursive: true })

  const Model = name.charAt(0).toUpperCase() + name.slice(1).replace(/s$/, '')
  const modelName = Model.toLowerCase()

  await writeFile(
    resolve(appDir, 'models.ts'),
    `import { defineModel, f } from 'angusjs/db'

export const ${Model} = defineModel(${JSON.stringify(modelName)}, {
  fields: {
    title: f.char({ maxLength: 200 }),
    body: f.text({ blank: true, default: '' }),
    published: f.boolean({ default: false }),
    createdAt: f.datetime({ autoNowAdd: true }),
    updatedAt: f.datetime({ autoNow: true }),
  },
  meta: {
    ordering: ['-createdAt'],
  },
})
`,
  )

  await writeFile(
    resolve(appDir, 'serializers.ts'),
    `import { serializer } from 'angusjs/serializers'
import { ${Model} } from './models.ts'

export const ${Model}Serializer = serializer(${Model}, {
  readOnly: ['id', 'createdAt', 'updatedAt'],
})
`,
  )

  await writeFile(
    resolve(appDir, 'urls.ts'),
    `import { modelViewSet, router } from 'angusjs/routing'
import { ${Model} } from './models.ts'
import { ${Model}Serializer } from './serializers.ts'

export default router().include(
  '/${name}',
  modelViewSet({
    model: ${Model},
    serializer: ${Model}Serializer,
    filterFields: ['published'],
    searchFields: ['title', 'body'],
    orderingFields: ['createdAt', 'title'],
    tags: [${JSON.stringify(name)}],
  }),
)
`,
  )

  await writeFile(
    resolve(appDir, 'admin.ts'),
    `import admin from '../../admin.ts'
import { ${Model} } from './models.ts'

admin.register(${Model}, {
  listDisplay: ['id', 'title', 'published', 'createdAt'],
  listFilter: ['published'],
  searchFields: ['title', 'body'],
  readonlyFields: ['createdAt', 'updatedAt'],
})
`,
  )

  await writeFile(
    resolve(appDir, 'app.ts'),
    `import { defineApp } from 'angusjs'
import { ${Model} } from './models.ts'
import urls from './urls.ts'
// Imported for its side effect: registers this app's models with the admin.
import './admin.ts'

export default defineApp({
  name: ${JSON.stringify(name)},
  prefix: '/',
  models: { ${Model} },
  urls,
})
`,
  )

  success(`Created app ${bold(name)} in apps/${name}/`)
  info('')
  info(`Now register it in ${cyan('angus.config.ts')}:`)
  info('')
  info(dim(`  import ${name} from './apps/${name}/app.ts'`))
  info(dim('  export default defineSettings({'))
  info(dim(`    apps: [admin.app(), ${name}],`))
  info(dim('    ...'))
  info(dim('  })'))
  info('')
  info(`Then ${cyan('angus makemigrations')} and ${cyan('angus migrate')}.`)
  info(dim(`Its models are already registered with the admin at /admin.`))
  return 0
}
