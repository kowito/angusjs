/**
 * `angus client` — write a typed API client.
 *
 * Generated from the same route definitions that produce the OpenAPI document,
 * so the client cannot describe an endpoint the server doesn't have.
 */

import { resolve } from 'node:path'
import type { LoadedProject } from '../../core/config.ts'
import { projectSpec } from '../../core/project.ts'
import { generateClient } from '../../client/generate.ts'
import { dim, info, success } from '../ui.ts'

export async function client(project: LoadedProject, args: string[]): Promise<number> {
  const spec = projectSpec(project.settings)

  const nameIndex = args.indexOf('--name')
  const baseIndex = args.indexOf('--base-url')

  const source = generateClient(spec, {
    name: nameIndex === -1 ? undefined : args[nameIndex + 1],
    baseUrl: baseIndex === -1 ? undefined : args[baseIndex + 1],
  })

  const outIndex = args.indexOf('--out')
  if (outIndex === -1) {
    // Nothing else goes to stdout, so `angus client > api.ts` works.
    console.log(source)
    return 0
  }

  const target = args[outIndex + 1]
  if (!target) throw new Error('`--out` needs a file path.')

  await Bun.write(resolve(project.root, target), source)

  const operations = Object.values(spec.paths).reduce((total, methods) => total + Object.keys(methods).length, 0)
  success(`Wrote a client for ${operations} operation(s) to ${target}`)
  info(dim('  The file is self-contained — it imports nothing.'))
  info(dim("  createClient({ baseUrl: 'https://api.example.com' })  — the origin only;"))
  info(dim('  the generated paths already include your project prefix.'))
  return 0
}
