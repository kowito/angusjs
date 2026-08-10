/**
 * The job queue's storage.
 *
 * Jobs live in the project's own database rather than in Redis. That is a
 * deliberate trade:
 *
 * - **Enqueueing joins the caller's transaction.** `atomic(() => { order =
 *   create(); enqueue(sendReceipt) })` cannot leave a receipt queued for an
 *   order that rolled back. With a separate broker that race is unavoidable and
 *   is the single most common source of phantom jobs.
 * - **One less service to run.** A project already has a database; needing
 *   Redis before you can send an email in the background is a real barrier.
 *
 * The cost is throughput. Polling a table tops out far below a purpose-built
 * broker, and this is sized for the work most applications actually queue —
 * emails, webhooks, thumbnails — not for a firehose. `JobQueue` is an interface
 * so a Redis-backed one can replace it without touching call sites.
 */

import { defineModel, f } from '../db/index.ts'

export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const

export const Job = defineModel('job', {
  fields: {
    /** The registered job's name. */
    task: f.char({ maxLength: 120 }),
    /** Arguments, as given to `enqueue`. */
    payload: f.json<Record<string, unknown>>({ default: {} }),
    status: f.char({ choices: JOB_STATUSES, default: 'pending' }),

    /** Higher runs first. */
    priority: f.integer({ default: 0 }),
    /** Not eligible before this. Powers both delays and retry backoff. */
    runAt: f.datetime(),

    attempts: f.integer({ default: 0 }),
    maxAttempts: f.integer({ default: 3 }),

    /**
     * Set while a worker holds the job, and cleared when it finishes. A row
     * whose lease has expired is reclaimable — which is how a job survives a
     * worker being killed mid-run.
     */
    lockedAt: f.datetime({ null: true }),
    lockedBy: f.char({ maxLength: 100, null: true }),

    lastError: f.text({ blank: true, default: '' }),
    /**
     * Deduplication key. Two jobs with the same key cannot be pending at once,
     * so "send the digest" enqueued twice does not send twice.
     */
    uniqueKey: f.char({ maxLength: 200, null: true }),

    completedAt: f.datetime({ null: true }),
    createdAt: f.datetime({ autoNowAdd: true }),
  },
  meta: {
    tableName: 'angus_jobs',
    ordering: ['-priority', 'runAt', 'id'],
    verboseName: 'job',
    indexes: [
      // The claim query filters on exactly this, and it is the hot path.
      { fields: ['status', 'runAt', 'priority'] },
      { fields: ['uniqueKey'] },
    ],
  },
})

export type JobRow = typeof Job.$row

export const jobModels = { Job }
