/**
 * Locating and loading `angus.config.ts`.
 *
 * The CLI needs the project's settings before anything else exists, so this is
 * deliberately dependency-free: walk up from the working directory until a
 * config turns up, then import it.
 */

import { dirname, resolve } from 'node:path'
import type { Settings } from './settings.ts'

const CONFIG_NAMES = ['angus.config.ts', 'angus.config.js', 'angus.config.mjs']

export interface LoadedProject {
  settings: Settings
  /** Absolute path to the config file. */
  configPath: string
  /** Directory containing the config — the project root. */
  root: string
}

/** Walks up from `start` looking for a config file. */
export async function findConfig(start: string = process.cwd()): Promise<string | null> {
  let directory = resolve(start)

  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = resolve(directory, name)
      if (await Bun.file(candidate).exists()) return candidate
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

export async function loadProject(start?: string): Promise<LoadedProject> {
  const configPath = await findConfig(start)
  if (!configPath) {
    throw new Error(
      'No angus.config.ts found in this directory or any parent.\n' +
        'Run `angus startproject <name>` to create one.',
    )
  }

  const module = (await import(configPath)) as { default?: Settings; settings?: Settings }
  const settings = module.default ?? module.settings

  if (!settings || !Array.isArray(settings.apps)) {
    throw new Error(
      `${configPath} must default-export settings created with defineSettings({ apps: [...] }).`,
    )
  }

  return { settings, configPath, root: dirname(configPath) }
}
