/**
 * `angus seed` — run a project's seed script.
 *
 * A convention rather than a framework: `seed.ts` exports a function, and this
 * opens the database and calls it. That is deliberately less than a fixtures
 * format — a JSON fixture cannot express "make an author, then twenty posts
 * belonging to them", which is what seeding is almost always for. A script can,
 * using the same factories the tests use.
 */

import { resolve } from 'node:path'
import type { LoadedProject } from '../../core/config.ts'
import { createApp } from '../../core/project.ts'
import { atomic } from '../../db/transaction.ts'
import { cyan, dim, info, success } from '../ui.ts'

const TEMPLATE = `import { factory } from 'angusjs/testing'
// import { Post } from './apps/blog/models.ts'

/**
 * Seeds the database. Run with \`angus seed\`.
 *
 * Everything here runs in one transaction, so a failure halfway leaves the
 * database as it was rather than half-populated.
 */
export default async function seed() {
  // const posts = factory(Post, (n) => ({ title: \`Post \${n}\`, slug: \`post-\${n}\` }))
  // await posts.createMany(20)
  console.log('Nothing to seed yet — edit seed.ts.')
}
`

export async function seed(project: LoadedProject, args: string[]): Promise<number> {
  const path = resolve(project.root, 'seed.ts')

  if (args.includes('--init')) {
    if (await Bun.file(path).exists()) throw new Error('seed.ts already exists.')
    await Bun.write(path, TEMPLATE)
    success('Created seed.ts')
    info(dim('  Edit it, then run `angus seed`.'))
    return 0
  }

  if (!(await Bun.file(path).exists())) {
    throw new Error('No seed.ts in this project. Create one with `angus seed --init`.')
  }

  await createApp(project.settings)

  const module = (await import(path)) as { default?: () => Promise<void> | void; seed?: () => Promise<void> | void }
  const run = module.default ?? module.seed
  if (typeof run !== 'function') {
    throw new Error('seed.ts must default-export a function.')
  }

  info(`Seeding from ${cyan('seed.ts')}`)

  // One transaction: a seed that fails halfway is worse than one that did
  // nothing, because the database is then in a state nobody designed.
  if (args.includes('--no-transaction')) {
    await run()
  } else {
    await atomic(async () => {
      await run()
    })
  }

  success('Seeded.')
  return 0
}
