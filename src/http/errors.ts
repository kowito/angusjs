/**
 * HTTP errors.
 *
 * Views throw these and the framework turns them into responses, so a handler
 * never has to build an error body by hand. ORM and serializer errors are
 * translated here too — `DoesNotExist` becomes a 404, `ValidationError` a 400.
 */

export interface ErrorBody {
  error: string
  detail: string
  /** Present on validation failures: field name -> messages. */
  errors?: Record<string, string[]>
  code?: string
}

export class APIError extends Error {
  readonly status: number
  readonly code: string
  readonly errors?: Record<string, string[]>

  constructor(status: number, detail: string, options: { code?: string; errors?: Record<string, string[]> } = {}) {
    super(detail)
    this.name = new.target.name
    this.status = status
    this.code = options.code ?? new.target.name
    this.errors = options.errors
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { error: this.name, detail: this.message, code: this.code }
    if (this.errors) body.errors = this.errors
    return body
  }
}

export class BadRequest extends APIError {
  constructor(detail = 'Malformed request.', errors?: Record<string, string[]>) {
    super(400, detail, { errors })
  }
}

export class Unauthorized extends APIError {
  /**
   * The permission that refused, if a named one did.
   *
   * Carried so the server can log it and a development response can show it,
   * never so a production body can — telling an anonymous caller *which* gate
   * stopped them maps out the authorization for an attacker.
   */
  readonly deniedBy?: string

  constructor(detail = 'Authentication credentials were not provided.', deniedBy?: string) {
    super(401, detail)
    this.deniedBy = deniedBy
  }
}

export class PermissionDenied extends APIError {
  /** The permission that refused. See {@link Unauthorized.deniedBy}. */
  readonly deniedBy?: string

  constructor(detail = 'You do not have permission to perform this action.', deniedBy?: string) {
    super(403, detail)
    this.deniedBy = deniedBy
  }
}

export class NotFound extends APIError {
  constructor(detail = 'Not found.') {
    super(404, detail)
  }
}

export class MethodNotAllowed extends APIError {
  constructor(method: string) {
    super(405, `Method "${method}" is not allowed.`)
  }
}

export class Conflict extends APIError {
  constructor(detail = 'The request conflicts with the current state.') {
    super(409, detail)
  }
}

export class UnprocessableEntity extends APIError {
  constructor(detail = 'Validation failed.', errors?: Record<string, string[]>) {
    super(422, detail, { errors })
  }
}

export class Throttled extends APIError {
  constructor(readonly retryAfter: number) {
    super(429, `Request was throttled. Try again in ${retryAfter} seconds.`)
  }
}

export class ServerError extends APIError {
  constructor(detail = 'Internal server error.') {
    super(500, detail)
  }
}
