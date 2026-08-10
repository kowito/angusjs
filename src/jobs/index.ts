/**
 * Background jobs.
 *
 * ```ts
 * export const sendReceipt = job({
 *   name: 'send-receipt',
 *   input: t.Object({ orderId: t.Numeric() }),
 *   async handler({ input }) { ... },
 * })
 *
 * await enqueue(sendReceipt, { orderId: 3 })
 * ```
 *
 * A job is a declaration, like a model or a service — so the worker, the CLI
 * and the admin all read one definition rather than three.
 *
 * The two properties worth knowing:
 *
 * **Enqueueing joins the caller's transaction.** Because the queue is a table,
 * `atomic()` covers the insert too, so a job cannot outlive a rolled-back
 * write. This is the failure a separate broker cannot avoid.
 *
 * **Delivery is at-least-once, never exactly-once.** A worker can succeed and
 * then die before recording it, so the job runs again. Handlers must be
 * idempotent; `uniqueKey` prevents duplicate *enqueues*, not duplicate *runs*.
 * Exactly-once needs a transactional consumer, which nothing here can honestly
 * offer.
 */

import { Value } from '@sinclair/typebox/value'
import type { Static, TSchema } from 'elysia'
import { F } from '../db/expressions.ts'
import { atomic, inTransaction } from '../db/transaction.ts'
import { ValidationError } from '../serializers/index.ts'
import { Job, type JobRow } from './models.ts'

export interface JobContext<I> {
  input: I
  /** The queue row, for logging and for checking which attempt this is. */
  job: JobRow
  /** 1 on the first run. */
  attempt: number
}

export interface JobConfig<Input extends TSchema> {
  name: string
  input: Input
  /** Total attempts before the job is failed for good. Defaults to 3. */
  maxAttempts?: number
  /** Higher runs first. Defaults to 0. */
  priority?: number
  /** Seconds before the first retry; doubles each attempt. Defaults to 10. */
  retryDelaySeconds?: number
  /** Kills a run that exceeds this, so one stuck job can't hold a worker. */
  timeoutSeconds?: number
  handler: (context: JobContext<Static<Input>>) => Promise<unknown> | unknown
}

export interface JobDefinition {
  readonly name: string
  readonly input: TSchema
  readonly maxAttempts: number
  readonly priority: number
  readonly retryDelaySeconds: number
  readonly timeoutSeconds?: number
  readonly handler: (context: JobContext<any>) => Promise<unknown> | unknown
}

const registry = new Map<string, JobDefinition>()

export function registeredJobs(): JobDefinition[] {
  return [...registry.values()]
}

export function getJob(name: string): JobDefinition | undefined {
  return registry.get(name)
}

/** Only for tests. */
export function _resetJobRegistry(): void {
  registry.clear()
}

export function job<Input extends TSchema>(config: JobConfig<Input>): JobDefinition {
  if (registry.has(config.name)) {
    throw new Error(`Job "${config.name}" is already defined. Job names must be unique.`)
  }

  const definition: JobDefinition = {
    name: config.name,
    input: config.input,
    maxAttempts: config.maxAttempts ?? 3,
    priority: config.priority ?? 0,
    retryDelaySeconds: config.retryDelaySeconds ?? 10,
    timeoutSeconds: config.timeoutSeconds,
    handler: config.handler as JobDefinition['handler'],
  }

  registry.set(config.name, definition)
  return definition
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Wait this long before the job becomes eligible. */
  delaySeconds?: number
  /** Or run it at a specific time. */
  runAt?: Date
  priority?: number
  maxAttempts?: number
  /**
   * Prevents a second pending job with the same key. Use it for work that is
   * naturally singular — "rebuild the sitemap" — where two queued copies are
   * always a mistake.
   */
  uniqueKey?: string
}

export async function enqueue(
  definition: JobDefinition,
  input: unknown = {},
  options: EnqueueOptions = {},
): Promise<JobRow | null> {
  if (!Value.Check(definition.input, input)) {
    const errors: Record<string, string[]> = {}
    for (const issue of Value.Errors(definition.input, input)) {
      const field = issue.path.replace(/^\//, '').replace(/\//g, '.') || 'detail'
      ;(errors[field] ??= []).push(issue.message)
    }
    // Rejected at enqueue time, where the stack still points at the caller,
    // rather than failing repeatedly inside a worker hours later.
    throw new ValidationError(errors)
  }

  const runAt = options.runAt ?? new Date(Date.now() + (options.delaySeconds ?? 0) * 1000)

  const create = async () => {
    if (options.uniqueKey) {
      const pending = await Job.objects
        .filter({ uniqueKey: options.uniqueKey, status__in: ['pending', 'running'] } as never)
        .exists()
      if (pending) return null
    }

    return Job.objects.create({
      task: definition.name,
      payload: Value.Decode(definition.input, input) as Record<string, unknown>,
      runAt,
      priority: options.priority ?? definition.priority,
      maxAttempts: options.maxAttempts ?? definition.maxAttempts,
      uniqueKey: options.uniqueKey ?? null,
    })
  }

  // Already inside a transaction: join it, so the job commits with the work
  // that scheduled it. Otherwise the uniqueness check and insert need their own.
  return inTransaction() ? create() : atomic(create)
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface RunResult {
  job: JobRow
  status: 'succeeded' | 'failed' | 'retrying'
  error?: string
}

/** Milliseconds a worker may hold a job before another may reclaim it. */
const DEFAULT_LEASE_MS = 5 * 60_000

/**
 * Claims one eligible job.
 *
 * The read and the lock happen in one transaction, so two workers cannot claim
 * the same row. Jobs whose lease has expired are eligible again — that is what
 * recovers work from a worker that was killed mid-run.
 */
export async function claimJob(workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<JobRow | null> {
  return atomic(async () => {
    const now = new Date()
    const staleBefore = new Date(now.getTime() - leaseMs)

    const candidate = await Job.objects
      .filter({ status: 'pending', runAt__lte: now } as never)
      .orderBy('-priority', 'runAt', 'id')
      .first()

    const reclaimable = candidate
      ? null
      : await Job.objects
          .filter({ status: 'running', lockedAt__lt: staleBefore } as never)
          .orderBy('-priority', 'runAt', 'id')
          .first()

    const chosen = candidate ?? reclaimable
    if (!chosen) return null

    const [locked] = await Job.objects
      .filter({ id: chosen.id, status: chosen.status } as never)
      .update({ status: 'running', lockedAt: now, lockedBy: workerId, attempts: F('attempts').add(1) })

    // Another worker won the race; leave it to them.
    return locked ?? null
  })
}

/** Runs a claimed job and records the outcome. */
export async function runJob(row: JobRow): Promise<RunResult> {
  const definition = getJob(row.task)

  if (!definition) {
    // A job whose code has been deleted must not spin: fail it immediately.
    await Job.objects.filter({ id: row.id }).update({
      status: 'failed',
      lastError: `No job named "${row.task}" is registered.`,
      lockedAt: null,
      lockedBy: null,
      completedAt: new Date(),
    })
    return { job: row, status: 'failed', error: `Unknown job "${row.task}".` }
  }

  try {
    const work = definition.handler({
      input: Value.Decode(definition.input, row.payload ?? {}),
      job: row,
      attempt: row.attempts,
    })

    await (definition.timeoutSeconds ? withTimeout(work, definition.timeoutSeconds, row.task) : work)

    await Job.objects.filter({ id: row.id }).update({
      status: 'succeeded',
      lockedAt: null,
      lockedBy: null,
      completedAt: new Date(),
      lastError: '',
    })

    return { job: row, status: 'succeeded' }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const exhausted = row.attempts >= row.maxAttempts

    // Exponential backoff: a failing dependency is rarely fixed a second later,
    // and retrying immediately turns one outage into a hot loop.
    const backoff = definition.retryDelaySeconds * 2 ** Math.max(0, row.attempts - 1)

    await Job.objects.filter({ id: row.id }).update({
      status: exhausted ? 'failed' : 'pending',
      lastError: message.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      runAt: exhausted ? row.runAt : new Date(Date.now() + backoff * 1000),
      completedAt: exhausted ? new Date() : null,
    })

    return { job: row, status: exhausted ? 'failed' : 'retrying', error: message }
  }
}

function withTimeout<T>(work: Promise<T> | T, seconds: number, task: string): Promise<T> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Job "${task}" exceeded its ${seconds}s timeout.`)), seconds * 1000),
    ),
  ])
}

/** Claims and runs one job. Returns null when the queue is empty. */
export async function runOnce(workerId = 'worker'): Promise<RunResult | null> {
  const claimed = await claimJob(workerId)
  return claimed ? runJob(claimed) : null
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

export interface WorkerOptions {
  /** Jobs run at once. Defaults to 1 — raise it for IO-bound work. */
  concurrency?: number
  /** How long to wait when the queue is empty. Defaults to 1s. */
  pollIntervalMs?: number
  workerId?: string
  /** Stop after this many jobs. For tests and one-shot runs. */
  maxJobs?: number
  onResult?: (result: RunResult) => void
  signal?: AbortSignal
}

export interface Worker {
  /** Resolves when the worker stops. */
  readonly done: Promise<void>
  stop(): Promise<void>
}

/**
 * Polls for jobs until stopped.
 *
 * Polling rather than notification, because the queue is a table. The interval
 * is the latency floor for a job with no delay, which is the price of not
 * running a broker.
 */
export function startWorker(options: WorkerOptions = {}): Worker {
  const concurrency = Math.max(1, options.concurrency ?? 1)
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const workerId = options.workerId ?? `worker-${crypto.randomUUID().slice(0, 8)}`

  let stopping = false
  let processed = 0

  const shouldStop = () =>
    stopping || options.signal?.aborted === true || (options.maxJobs !== undefined && processed >= options.maxJobs)

  const loop = async (): Promise<void> => {
    while (!shouldStop()) {
      const claimed = await claimJob(workerId)

      if (!claimed) {
        // Idle: wait before asking again rather than spinning on the database.
        await Bun.sleep(pollIntervalMs)
        continue
      }

      processed++
      const result = await runJob(claimed)
      options.onResult?.(result)
    }
  }

  const done = Promise.all(Array.from({ length: concurrency }, () => loop())).then(() => undefined)

  return {
    done,
    async stop() {
      stopping = true
      await done
    },
  }
}

// ---------------------------------------------------------------------------
// Inspection and maintenance
// ---------------------------------------------------------------------------

export interface QueueStats {
  pending: number
  running: number
  succeeded: number
  failed: number
  cancelled: number
  /** Pending jobs whose time has come but which no worker has taken. */
  overdue: number
}

export async function queueStats(): Promise<QueueStats> {
  const [pending, running, succeeded, failed, cancelled, overdue] = await Promise.all([
    Job.objects.filter({ status: 'pending' }).count(),
    Job.objects.filter({ status: 'running' }).count(),
    Job.objects.filter({ status: 'succeeded' }).count(),
    Job.objects.filter({ status: 'failed' }).count(),
    Job.objects.filter({ status: 'cancelled' }).count(),
    Job.objects.filter({ status: 'pending', runAt__lte: new Date() } as never).count(),
  ])

  return { pending, running, succeeded, failed, cancelled, overdue }
}

/** Puts a failed job back in the queue. */
export async function retryJob(id: number): Promise<JobRow | null> {
  const [row] = await Job.objects.filter({ id, status: 'failed' } as never).update({
    status: 'pending',
    attempts: 0,
    runAt: new Date(),
    lastError: '',
    completedAt: null,
  })
  return row ?? null
}

/** Stops a job that has not started. */
export async function cancelJob(id: number): Promise<boolean> {
  const rows = await Job.objects
    .filter({ id, status: 'pending' } as never)
    .update({ status: 'cancelled', completedAt: new Date() })
  return rows.length > 0
}

/** Deletes finished jobs older than `days`, so the table doesn't grow forever. */
export async function pruneJobs(days = 7): Promise<number> {
  const before = new Date(Date.now() - days * 86_400_000)
  return Job.objects
    .filter({ status__in: ['succeeded', 'cancelled'], completedAt__lt: before } as never)
    .delete()
}

export { Job, jobModels } from './models.ts'
export type { JobRow } from './models.ts'
export { schedule, dueSchedules, runSchedules, registeredSchedules } from './schedule.ts'
export type { ScheduleConfig, ScheduleDefinition } from './schedule.ts'
