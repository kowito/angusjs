/**
 * ORM-level errors. The HTTP layer maps `DoesNotExist` to 404 and
 * `ValidationError` to 400, so views can let them propagate.
 */

export class DoesNotExist extends Error {
  readonly model: string

  constructor(model: string, criteria?: unknown) {
    const detail = criteria ? ` matching ${JSON.stringify(criteria)}` : ''
    super(`${model} matching query does not exist${detail ? ` (${detail.trim()})` : ''}.`)
    this.name = 'DoesNotExist'
    this.model = model
  }
}

export class MultipleObjectsReturned extends Error {
  readonly model: string
  readonly count: number

  constructor(model: string, count: number) {
    super(`get() returned more than one ${model} — it returned ${count}. Use filter() instead.`)
    this.name = 'MultipleObjectsReturned'
    this.model = model
    this.count = count
  }
}

export class IntegrityError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'IntegrityError'
  }
}
