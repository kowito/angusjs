/**
 * A record of what agents did.
 *
 * The HTTP access log already records the request a tool call produces, but it
 * cannot answer the question anyone actually asks after an incident: *which
 * tool did the assistant think it was using, with what arguments, and did it
 * work?* One tool call becomes one API request, so the two logs describe the
 * same event at different levels — and only this one knows the tool's name, the
 * arguments the model chose, and whether the call was refused before it ever
 * reached the API.
 *
 * Writes are fire-and-forget: an audit sink that throws or hangs must not take
 * the tool call down with it, because a logging outage is not a reason to stop
 * serving. The cost of that choice is that a crashing process can lose the last
 * few entries, which is the right trade for this kind of log and the wrong one
 * for a financial ledger.
 */

export interface AuditEvent {
  /** ISO timestamp of when the call completed. */
  at: string
  tool: string
  /** Arguments the model supplied, with secret-looking values removed. */
  args: Record<string, unknown>
  /** HTTP status the underlying API returned, or null if never dispatched. */
  status: number | null
  outcome: 'ok' | 'error' | 'refused'
  /** Milliseconds spent in the call. */
  duration: number
  /** Who the call was made for, as far as the server can tell. */
  actor: string | null
  /** Present when the outcome was not ok. */
  detail?: string
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>

/**
 * Keys whose values are never recorded.
 *
 * An audit log is read by more people than the database is, and often shipped
 * somewhere else entirely, so a password that lands in it has effectively been
 * published. Matching on the key is coarse and will redact the occasional
 * harmless field; that is the safer direction to be wrong in.
 */
const SECRET_KEY = /pass(word|phrase)?|secret|token|authorization|api[-_]?key|credential|otp|cvv|ssn/i

/** Replaces secret-looking values, and trims anything too large to be useful. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]'

  if (Array.isArray(value)) {
    // A long array in a log is noise; the length is the informative part.
    if (value.length > 20) return [...value.slice(0, 20).map((entry) => redact(entry, depth + 1)), `[+${value.length - 20} more]`]
    return value.map((entry) => redact(entry, depth + 1))
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(entry, depth + 1)
    }
    return out
  }

  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}… [${value.length} chars]`

  return value
}

/**
 * Names the caller without recording their credential.
 *
 * A bearer token in an audit log is a live credential sitting in a file that
 * outlives it, so what gets stored is a short digest: stable enough to group a
 * session's calls together and to compare against another entry, useless to
 * anyone who reads the log.
 */
export function fingerprint(headers: Headers | undefined): string | null {
  const authorization = headers?.get('authorization')
  if (!authorization) return null

  const hash = new Bun.CryptoHasher('sha256').update(authorization).digest('hex')
  return `agent:${hash.slice(0, 12)}`
}

/** One JSON object per line, appended to a file. */
export function jsonlAuditSink(path: string): AuditSink {
  // Held open rather than reopened per call: a tool call is not rare, and the
  // open/close pair would cost more than the write.
  const writer = Bun.file(path).writer()

  return (event) => {
    writer.write(`${JSON.stringify(event)}\n`)
    void writer.flush()
  }
}

/** Human-readable, for development. */
export function consoleAuditSink(): AuditSink {
  return (event) => {
    const mark = event.outcome === 'ok' ? '·' : event.outcome === 'refused' ? '⨯' : '!'
    const actor = event.actor ? ` ${event.actor}` : ''
    console.log(`[mcp]${actor} ${mark} ${event.tool} ${event.status ?? event.outcome} ${event.duration}ms`)
  }
}

/** Keeps events in memory. For tests, and for a small dashboard. */
export function memoryAuditSink(limit = 1000): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = []
  const sink = ((event: AuditEvent) => {
    events.push(event)
    if (events.length > limit) events.shift()
  }) as AuditSink & { events: AuditEvent[] }
  sink.events = events
  return sink
}

/**
 * Sends an event to a sink without letting the sink affect the caller.
 *
 * A sink that throws is reported once to stderr and otherwise ignored: losing
 * the log entry is bad, failing the agent's call because the log was
 * unavailable is worse.
 */
export function emitAudit(sink: AuditSink | undefined, event: AuditEvent): void {
  if (!sink) return

  try {
    const returned = sink(event)
    if (returned instanceof Promise) {
      void returned.catch((error) => console.error('[mcp] audit sink failed:', error))
    }
  } catch (error) {
    console.error('[mcp] audit sink failed:', error)
  }
}
