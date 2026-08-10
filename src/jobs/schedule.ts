/**
 * Scheduled jobs.
 *
 * A schedule enqueues an ordinary job on an interval, so everything the queue
 * already provides — retries, backoff, visibility, the admin — applies without
 * a second mechanism.
 *
 * Each tick enqueues with a `uniqueKey` derived from the schedule and the slot
 * it belongs to. That is what makes running several workers safe: they all
 * compute the same key, and only the first insert survives. Without it, three
 * replicas would send three copies of the nightly digest.
 *
 * Intervals rather than cron expressions. Cron is a parser, a timezone story
 * and a class of surprises around DST for expressiveness most applications
 * never use — and `every: '1h'` covers what they do.
 */

import { enqueue, getJob, type JobDefinition } from './index.ts'

export interface ScheduleConfig {
  /** Unique name; also the deduplication key prefix. */
  name: string
  /** The job to enqueue. */
  job: JobDefinition
  /** `30s`, `15m`, `1h`, `1d`, or a number of seconds. */
  every: string | number
  input?: unknown
  priority?: number
  /**
   * Aligns slots to the clock, so `1h` fires on the hour rather than an hour
   * after the process happened to start.
   */
  aligned?: boolean
}

export interface ScheduleDefinition extends Omit<ScheduleConfig, 'every'> {
  everySeconds: number
  aligned: boolean
}

const registry = new Map<string, ScheduleDefinition>()

export function registeredSchedules(): ScheduleDefinition[] {
  return [...registry.values()]
}

export function _resetScheduleRegistry(): void {
  registry.clear()
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 }

export function parseInterval(every: string | number): number {
  if (typeof every === 'number') return every

  const match = /^(\d+)\s*([smhd])$/.exec(every.trim())
  if (!match) {
    throw new Error(`Invalid interval "${every}". Use a number of seconds, or 30s / 15m / 1h / 1d.`)
  }

  return Number(match[1]) * UNITS[match[2]!]!
}

export function schedule(config: ScheduleConfig): ScheduleDefinition {
  if (registry.has(config.name)) {
    throw new Error(`Schedule "${config.name}" is already defined.`)
  }
  if (!getJob(config.job.name)) {
    throw new Error(`schedule("${config.name}"): job "${config.job.name}" is not registered.`)
  }

  const definition: ScheduleDefinition = {
    ...config,
    everySeconds: parseInterval(config.every),
    aligned: config.aligned ?? true,
  }

  registry.set(config.name, definition)
  return definition
}

/**
 * The slot a moment belongs to.
 *
 * Every worker computes the same slot for the same instant, so they all derive
 * the same deduplication key and only one enqueue wins.
 */
export function slotFor(definition: ScheduleDefinition, at: Date = new Date()): number {
  const seconds = Math.floor(at.getTime() / 1000)
  return definition.aligned
    ? Math.floor(seconds / definition.everySeconds)
    : Math.floor(seconds / definition.everySeconds)
}

/** The schedules whose current slot has not been enqueued yet. */
export function dueSchedules(at: Date = new Date()): { definition: ScheduleDefinition; key: string }[] {
  return registeredSchedules().map((definition) => ({
    definition,
    key: `schedule:${definition.name}:${slotFor(definition, at)}`,
  }))
}

/**
 * Enqueues anything due. Safe to call from every worker on every tick: the
 * unique key means only the first call in a slot creates a job.
 */
export async function runSchedules(at: Date = new Date()): Promise<string[]> {
  const enqueued: string[] = []

  for (const { definition, key } of dueSchedules(at)) {
    const row = await enqueue(definition.job, definition.input ?? {}, {
      uniqueKey: key,
      priority: definition.priority,
    })
    if (row) enqueued.push(definition.name)
  }

  return enqueued
}
