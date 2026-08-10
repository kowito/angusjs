/**
 * `angus worker` — run background jobs.
 *
 * Separate from `runserver` on purpose: a web process and a worker process
 * scale differently, and a job that pins the CPU should not slow down requests.
 */

import type { LoadedProject } from '../../core/config.ts'
import { createApp } from '../../core/project.ts'
import { pruneJobs, queueStats, registeredJobs, runSchedules, startWorker } from '../../jobs/index.ts'
import { registeredSchedules } from '../../jobs/schedule.ts'
import { bold, cyan, dim, green, info, red, success, table } from '../ui.ts'

export async function worker(project: LoadedProject, args: string[]): Promise<number> {
  // Building the app opens the database and imports every app, which is what
  // registers the jobs.
  await createApp(project.settings)

  if (args.includes('--list')) {
    const jobs = registeredJobs()
    const schedules = registeredSchedules()

    if (jobs.length === 0) {
      info('No jobs defined. Create one with `job({ ... })` and import it from your app.')
      return 0
    }

    info(bold('Jobs'))
    table(jobs.map((definition) => [`  ${cyan(definition.name)}`, dim(`${definition.maxAttempts} attempts`)]))

    if (schedules.length > 0) {
      info(`\n${bold('Schedules')}`)
      table(
        schedules.map((entry) => [`  ${cyan(entry.name)}`, dim(`every ${entry.everySeconds}s → ${entry.job.name}`)]),
      )
    }
    return 0
  }

  if (args.includes('--stats')) {
    const stats = await queueStats()
    table(
      Object.entries(stats).map(([key, value]) => [`  ${key}`, String(value)]),
      { head: ['STATE', 'COUNT'] },
    )
    return 0
  }

  if (args.includes('--prune')) {
    const daysIndex = args.indexOf('--days')
    const days = daysIndex === -1 ? 7 : Number(args[daysIndex + 1])
    success(`Removed ${await pruneJobs(days)} finished job(s) older than ${days} day(s).`)
    return 0
  }

  const concurrencyIndex = args.indexOf('--concurrency')
  const concurrency = concurrencyIndex === -1 ? 1 : Number(args[concurrencyIndex + 1])
  const once = args.includes('--once')

  info(`${bold('angus worker')} ${dim(`· ${registeredJobs().length} job(s), concurrency ${concurrency}`)}`)

  // Schedules are ticked from the worker rather than a separate process; the
  // unique key per slot means running several workers is safe.
  const schedules = registeredSchedules()
  const ticker =
    schedules.length === 0 || once
      ? undefined
      : setInterval(() => {
          runSchedules().catch((error) => console.error('angus worker: schedule tick failed', error))
        }, 5_000)

  if (schedules.length > 0 && !once) await runSchedules()

  const running = startWorker({
    concurrency,
    maxJobs: once ? 1 : undefined,
    onResult: (result) => {
      const mark = result.status === 'succeeded' ? green('✓') : red('✗')
      info(`${mark} ${result.job.task} ${dim(`#${result.job.id} ${result.status}`)}`)
      if (result.error) info(dim(`   ${result.error}`))
    },
  })

  const stop = () => {
    info(dim('\nFinishing the current job, then stopping.'))
    if (ticker) clearInterval(ticker)
    running.stop()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await running.done
  if (ticker) clearInterval(ticker)
  return 0
}
