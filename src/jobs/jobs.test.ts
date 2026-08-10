import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { t } from 'elysia'
import { atomic } from '../db/transaction.ts'
import { testDatabase, type TestDatabase } from '../testing/index.ts'
import {
  cancelJob,
  claimJob,
  enqueue,
  job,
  Job,
  pruneJobs,
  queueStats,
  retryJob,
  runJob,
  runOnce,
  startWorker,
} from './index.ts'
import { parseInterval, runSchedules, schedule, slotFor, _resetScheduleRegistry } from './schedule.ts'

const ran: string[] = []

const succeed = job({
  name: 'test-succeed',
  input: t.Object({ label: t.String() }),
  handler: ({ input }) => void ran.push(input.label),
})

const alwaysFails = job({
  name: 'test-fails',
  input: t.Object({}),
  maxAttempts: 2,
  retryDelaySeconds: 0,
  handler: () => {
    throw new Error('nope')
  },
})

const failsOnce = job({
  name: 'test-fails-once',
  input: t.Object({}),
  maxAttempts: 3,
  retryDelaySeconds: 0,
  handler: ({ attempt }) => {
    if (attempt === 1) throw new Error('transient')
    ran.push('recovered')
  },
})

const slow = job({
  name: 'test-slow',
  input: t.Object({}),
  maxAttempts: 1,
  timeoutSeconds: 0.05,
  handler: () => Bun.sleep(500),
})

const nightly = job({ name: 'test-nightly', input: t.Object({}), handler: () => void ran.push('nightly') })

let db: TestDatabase

beforeAll(async () => {
  db = await testDatabase({ models: [Job] })
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
  ran.length = 0
  _resetScheduleRegistry()
})

describe('enqueueing', () => {
  test('creates a pending job', async () => {
    const row = await enqueue(succeed, { label: 'a' })
    expect(row!.status).toBe('pending')
    expect(row!.task).toBe('test-succeed')
    expect(row!.payload).toEqual({ label: 'a' })
  })

  test('rejects bad input at enqueue time, not inside a worker later', async () => {
    // The stack still points at the caller here; failing in a worker hours
    // later points at the queue.
    expect(enqueue(succeed, { label: 42 })).rejects.toThrow(/label/)
    expect(await Job.objects.count()).toBe(0)
  })

  test('a delay postpones eligibility', async () => {
    await enqueue(succeed, { label: 'later' }, { delaySeconds: 60 })
    expect(await claimJob('w')).toBeNull()
  })

  test('uniqueKey prevents a second pending copy', async () => {
    const first = await enqueue(succeed, { label: 'a' }, { uniqueKey: 'digest' })
    const second = await enqueue(succeed, { label: 'a' }, { uniqueKey: 'digest' })

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(await Job.objects.count()).toBe(1)
  })

  test('the enqueue joins the caller transaction, so a rollback takes it too', async () => {
    // This is the failure a separate broker cannot avoid: a job queued for work
    // that never committed.
    await expect(
      atomic(async () => {
        await enqueue(succeed, { label: 'orphan' })
        throw new Error('the surrounding work failed')
      }),
    ).rejects.toThrow()

    expect(await Job.objects.count()).toBe(0)
  })
})

describe('claiming', () => {
  test('claims in priority then time order', async () => {
    await enqueue(succeed, { label: 'low' })
    await enqueue(succeed, { label: 'high' }, { priority: 10 })

    const claimed = await claimJob('w')
    expect((claimed!.payload as { label: string }).label).toBe('high')
  })

  test('a claimed job is not handed to a second worker', async () => {
    await enqueue(succeed, { label: 'only' })

    const first = await claimJob('w1')
    const second = await claimJob('w2')

    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  test('claiming records the attempt and the holder', async () => {
    await enqueue(succeed, { label: 'a' })
    const claimed = await claimJob('worker-7')

    expect(claimed!.attempts).toBe(1)
    expect(claimed!.lockedBy).toBe('worker-7')
    expect(claimed!.status).toBe('running')
  })

  test('a job whose lease expired is reclaimed', async () => {
    // This is what recovers work from a worker killed mid-run.
    await enqueue(succeed, { label: 'stranded' })
    const claimed = await claimJob('dead-worker')

    await Job.objects
      .filter({ id: claimed!.id })
      .update({ lockedAt: new Date(Date.now() - 10 * 60_000) })

    const reclaimed = await claimJob('live-worker')
    expect(reclaimed!.id).toBe(claimed!.id)
    expect(reclaimed!.lockedBy).toBe('live-worker')
  })

  test('an empty queue returns null rather than waiting', async () => {
    expect(await claimJob('w')).toBeNull()
  })
})

describe('running', () => {
  test('a success is recorded and the handler ran', async () => {
    await enqueue(succeed, { label: 'hello' })
    const result = await runOnce()

    expect(result!.status).toBe('succeeded')
    expect(ran).toEqual(['hello'])
    expect((await Job.objects.get({ id: result!.job.id })).completedAt).not.toBeNull()
  })

  test('a failure retries with the error recorded', async () => {
    await enqueue(alwaysFails, {})
    const result = await runOnce()

    expect(result!.status).toBe('retrying')
    const row = await Job.objects.get({ id: result!.job.id })
    expect(row.status).toBe('pending')
    expect(row.lastError).toContain('nope')
  })

  test('retries stop at maxAttempts', async () => {
    await enqueue(alwaysFails, {})

    expect((await runOnce())!.status).toBe('retrying')
    expect((await runOnce())!.status).toBe('failed')

    expect(await Job.objects.filter({ status: 'failed' }).count()).toBe(1)
    // Exhausted: no worker picks it up again.
    expect(await claimJob('w')).toBeNull()
  })

  test('a transient failure succeeds on the retry', async () => {
    await enqueue(failsOnce, {})
    expect((await runOnce())!.status).toBe('retrying')
    expect((await runOnce())!.status).toBe('succeeded')
    expect(ran).toEqual(['recovered'])
  })

  test('backoff grows, so a failing dependency is not hammered', async () => {
    const spaced = job({ name: 'test-backoff', input: t.Object({}), maxAttempts: 5, retryDelaySeconds: 10, handler: () => { throw new Error('x') } })
    await enqueue(spaced, {})

    const before = Date.now()
    const first = await runOnce()
    const after = await Job.objects.get({ id: first!.job.id })

    // First retry waits ~10s rather than running immediately.
    expect(after.runAt.getTime() - before).toBeGreaterThan(5_000)
  })

  test('a job that outruns its timeout fails rather than holding the worker', async () => {
    await enqueue(slow, {})
    const result = await runOnce()

    expect(result!.status).toBe('failed')
    expect(result!.error).toContain('timeout')
  })

  test('a job whose code was deleted fails immediately rather than spinning', async () => {
    await Job.objects.create({ task: 'no-such-job', payload: {}, runAt: new Date() })
    const result = await runOnce()

    expect(result!.status).toBe('failed')
    expect(result!.error).toContain('Unknown job')
  })

  test('runOnce returns null on an empty queue', async () => {
    expect(await runOnce()).toBeNull()
  })
})

describe('the worker loop', () => {
  test('drains the queue', async () => {
    await enqueue(succeed, { label: 'a' })
    await enqueue(succeed, { label: 'b' })
    await enqueue(succeed, { label: 'c' })

    const worker = startWorker({ maxJobs: 3, pollIntervalMs: 1 })
    await worker.done

    expect(ran.sort()).toEqual(['a', 'b', 'c'])
  })

  test('stop() ends the loop', async () => {
    const worker = startWorker({ pollIntervalMs: 1 })
    await Bun.sleep(10)
    await worker.stop()
    expect(true).toBe(true)
  })

  test('reports each result', async () => {
    await enqueue(succeed, { label: 'x' })
    const seen: string[] = []
    const worker = startWorker({ maxJobs: 1, pollIntervalMs: 1, onResult: (r) => seen.push(r.status) })
    await worker.done
    expect(seen).toEqual(['succeeded'])
  })
})

describe('management', () => {
  test('stats count each state', async () => {
    await enqueue(succeed, { label: 'a' })
    await enqueue(alwaysFails, {})
    await runOnce()

    const stats = await queueStats()
    expect(stats.pending + stats.succeeded + stats.failed).toBeGreaterThanOrEqual(2)
  })

  test('a pending job can be cancelled', async () => {
    const row = await enqueue(succeed, { label: 'a' }, { delaySeconds: 600 })
    expect(await cancelJob(row!.id)).toBe(true)
    expect((await Job.objects.get({ id: row!.id })).status).toBe('cancelled')
  })

  test('a failed job can be retried', async () => {
    await enqueue(alwaysFails, {})
    await runOnce()
    await runOnce()

    const failed = await Job.objects.get({ status: 'failed' } as never)
    const retried = await retryJob(failed.id)

    expect(retried!.status).toBe('pending')
    expect(retried!.attempts).toBe(0)
  })

  test('pruning removes old finished jobs only', async () => {
    await enqueue(succeed, { label: 'a' })
    await runOnce()

    const done = await Job.objects.get({ status: 'succeeded' } as never)
    await Job.objects.filter({ id: done.id }).update({ completedAt: new Date(Date.now() - 30 * 86_400_000) })
    await enqueue(succeed, { label: 'keep' })

    expect(await pruneJobs(7)).toBe(1)
    expect(await Job.objects.count()).toBe(1)
  })
})

describe('schedules', () => {
  test('parses intervals', () => {
    expect(parseInterval('30s')).toBe(30)
    expect(parseInterval('15m')).toBe(900)
    expect(parseInterval('1h')).toBe(3600)
    expect(parseInterval('1d')).toBe(86_400)
    expect(parseInterval(45)).toBe(45)
    expect(() => parseInterval('every friday')).toThrow(/Invalid interval/)
  })

  test('a tick enqueues the job', async () => {
    schedule({ name: 'nightly-digest', job: nightly, every: '1h' })
    expect(await runSchedules()).toEqual(['nightly-digest'])
    expect(await Job.objects.filter({ task: 'test-nightly' }).count()).toBe(1)
  })

  test('several workers ticking the same slot enqueue once', async () => {
    // Without the per-slot unique key, three replicas send three digests.
    schedule({ name: 'nightly-digest', job: nightly, every: '1h' })
    const at = new Date()

    await runSchedules(at)
    await runSchedules(at)
    await runSchedules(at)

    expect(await Job.objects.filter({ task: 'test-nightly' }).count()).toBe(1)
  })

  test('the next slot enqueues again', async () => {
    schedule({ name: 'frequent', job: nightly, every: '1m' })
    const now = new Date()

    await runSchedules(now)
    await runSchedules(new Date(now.getTime() + 61_000))

    expect(await Job.objects.filter({ task: 'test-nightly' }).count()).toBe(2)
  })

  test('every worker computes the same slot for the same instant', () => {
    const definition = schedule({ name: 'aligned', job: nightly, every: '1h' })
    const at = new Date('2026-08-11T13:37:00Z')
    expect(slotFor(definition, at)).toBe(slotFor(definition, at))
  })

  test('a schedule for an unregistered job is rejected', () => {
    expect(() =>
      schedule({ name: 'bad', job: { name: 'not-registered' } as never, every: '1h' }),
    ).toThrow(/is not registered/)
  })
})
