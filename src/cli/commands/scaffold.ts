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

  // Spec at /openapi.json, reference page at /docs.
  openapi: {
    title: ${JSON.stringify(name)},
    version: '0.1.0',
  },

  // The API is also exposed to agents over MCP at /mcp, with one tool per
  // route. Tool calls go through the same routes, so they carry exactly the
  // permissions the HTTP API already grants. Use \`mcp: false\` to remove the
  // endpoint, or \`mcp: { readOnly: true }\` to expose reads only.
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
    resolve(root, 'Dockerfile'),
    `# Multi-stage so the runtime image carries no build tooling.
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Never run as root: a container escape should not start as uid 0.
USER bun

EXPOSE 8000

# Liveness only — it must not touch the database, or a database blip would
# restart every replica at once. See /readyz for readiness.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD bun -e "fetch('http://127.0.0.1:8000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "main.ts"]
`,
  )

  await writeFile(
    resolve(root, '.dockerignore'),
    `node_modules
.angus
*.sqlite
*.sqlite-shm
*.sqlite-wal
.env
.git
.github
**/*.test.ts
`,
  )

  await writeFile(
    resolve(root, '.env.example'),
    `# Copy to .env and fill in. \`angus check --deploy\` verifies the result.
NODE_ENV=development

# Postgres in production; SQLite is the default for local work.
# DATABASE_URL=postgres://user:password@localhost:5432/${name}

PORT=8000
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

// Declared as a variable rather than exported inline so \`angus generate crud\`
// can append further view sets to it.
const routes = router()

routes.include(
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

export default routes
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

  const installed = await installApp(project.root, name)
  if (installed) {
    info(dim(`  installed in angus.config.ts`))
  } else {
    info('')
    info(`Could not edit ${cyan('angus.config.ts')} — add it yourself:`)
    info('')
    info(dim(`  import ${name} from './apps/${name}/app.ts'`))
    info(dim(`    apps: [admin.app(), ${name}],`))
  }

  info('')
  info(`Next: ${cyan('angus makemigrations')} and ${cyan('angus migrate')}.`)
  info(dim(`Its models are already registered with the admin at /admin.`))
  return 0
}

/**
 * Adds the app to `apps` in the project settings.
 *
 * An app that exists on disk but is not installed produces nothing: no tables,
 * no routes, and — worse — no complaint. `angus check` reports a clean project
 * because from its point of view there is nothing there. The generator already
 * registers models with their app for the same reason; this is the same failure
 * one level up.
 */
async function installApp(root: string, name: string): Promise<boolean> {
  const path = resolve(root, 'angus.config.ts')
  const file = Bun.file(path)
  if (!(await file.exists())) return false

  const source = await file.text()
  const apps = /apps:\s*\[([^\]]*)\]/.exec(source)
  if (!apps) return false

  const current = apps[1]!.split(',').map((entry) => entry.trim()).filter(Boolean)
  // Already there — running startapp twice must not install it twice.
  if (current.includes(name)) return true

  // Before admin.app(), so the app's own routes are mounted first and the
  // admin sees its models by the time it builds.
  const merged = [name, ...current].join(', ')

  let updated = source.replace(apps[0]!, `apps: [${merged}]`)

  if (!new RegExp(`^import ${name} from`, 'm').test(updated)) {
    const lastImport = [...updated.matchAll(/^import .*$/gm)].pop()
    const line = `import ${name} from './apps/${name}/app.ts'`
    updated = lastImport
      ? updated.slice(0, lastImport.index! + lastImport[0].length) +
        `\n${line}` +
        updated.slice(lastImport.index! + lastImport[0].length)
      : `${line}\n${updated}`
  }

  await Bun.write(path, updated)
  return true
}
