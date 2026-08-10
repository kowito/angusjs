/**
 * Email.
 *
 * A backend interface with four implementations, chosen so that the two states
 * a project is actually in are both handled well: **development**, where mail
 * must be visible but must not be sent, and **tests**, where it must be
 * assertable.
 *
 * ```ts
 * email: { backend: consoleBackend(), from: 'Acme <no-reply@acme.com>' }
 * ```
 *
 * SMTP is deliberately absent. A correct client means STARTTLS upgrade, several
 * AUTH mechanisms, line folding and dot-stuffing, and none of that can be
 * verified here — a half-working SMTP client that drops mail silently is worse
 * than an honest gap. `EmailBackend` is one method, so adding one (or wrapping
 * nodemailer) is a small, local piece of work.
 */

export interface EmailAddress {
  name?: string
  address: string
}

export type Addressee = string | EmailAddress

export interface EmailMessage {
  to: Addressee | Addressee[]
  from?: Addressee
  subject: string
  text?: string
  html?: string
  cc?: Addressee | Addressee[]
  bcc?: Addressee | Addressee[]
  replyTo?: Addressee
  headers?: Record<string, string>
  /** Set by the sender; useful for correlating with provider logs. */
  tag?: string
}

export interface SendResult {
  /** Provider message id, when one is returned. */
  id?: string
  accepted: string[]
  rejected: string[]
}

export interface EmailBackend {
  readonly name: string
  send(messages: EmailMessage[]): Promise<SendResult[]>
}

// ---------------------------------------------------------------------------
// Address formatting
// ---------------------------------------------------------------------------

/** `{ name, address }` -> `Name <addr>`, quoting a name that needs it. */
export function formatAddress(input: Addressee): string {
  if (typeof input === 'string') return input
  if (!input.name) return input.address
  const needsQuotes = /[",:;<>@\[\]\\]/.test(input.name)
  const name = needsQuotes ? `"${input.name.replace(/(["\\])/g, '\\$1')}"` : input.name
  return `${name} <${input.address}>`
}

export function addressList(input: Addressee | Addressee[] | undefined): string[] {
  if (!input) return []
  return (Array.isArray(input) ? input : [input]).map(formatAddress)
}

/** Just the address part, for reporting what was accepted. */
export function bareAddress(input: Addressee): string {
  return typeof input === 'string' ? extractAddress(input) : input.address
}

function extractAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value)
  return (match?.[1] ?? value).trim()
}

function recipients(message: EmailMessage): string[] {
  return [
    ...(Array.isArray(message.to) ? message.to : [message.to]),
    ...(message.cc ? (Array.isArray(message.cc) ? message.cc : [message.cc]) : []),
    ...(message.bcc ? (Array.isArray(message.bcc) ? message.bcc : [message.bcc]) : []),
  ].map(bareAddress)
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/**
 * Prints to stderr rather than sending. The default in development, because
 * "the reset link never arrived" is a much worse first hour than a slightly
 * noisy terminal — and stderr keeps it out of anything reading stdout.
 */
export function consoleBackend(): EmailBackend {
  return {
    name: 'console',
    async send(messages) {
      for (const message of messages) {
        const lines = [
          '',
          '─'.repeat(60),
          `To:      ${addressList(message.to).join(', ')}`,
          message.from ? `From:    ${formatAddress(message.from)}` : undefined,
          message.cc ? `Cc:      ${addressList(message.cc).join(', ')}` : undefined,
          `Subject: ${message.subject}`,
          '─'.repeat(60),
          message.text ?? stripHtml(message.html ?? ''),
          '─'.repeat(60),
          '',
        ].filter((line) => line !== undefined)

        process.stderr.write(`${lines.join('\n')}\n`)
      }

      return messages.map((message) => ({ accepted: recipients(message), rejected: [] }))
    },
  }
}

export interface MemoryBackend extends EmailBackend {
  /** Everything sent so far, oldest first. */
  readonly outbox: EmailMessage[]
  clear(): void
  /** The most recent message sent to an address, for assertions. */
  lastTo(address: string): EmailMessage | undefined
}

/**
 * Collects messages instead of sending them, so a test can assert on what was
 * sent without a mock or a network stub.
 */
export function memoryBackend(): MemoryBackend {
  const outbox: EmailMessage[] = []

  return {
    name: 'memory',
    outbox,
    clear() {
      outbox.length = 0
    },
    lastTo(address) {
      const wanted = address.toLowerCase()
      return [...outbox].reverse().find((message) => recipients(message).some((r) => r.toLowerCase() === wanted))
    },
    async send(messages) {
      outbox.push(...messages)
      return messages.map((message) => ({ accepted: recipients(message), rejected: [] }))
    },
  }
}

/** Accepts and discards. For a staging environment that must not send. */
export function nullBackend(): EmailBackend {
  return {
    name: 'null',
    async send(messages) {
      return messages.map((message) => ({ accepted: recipients(message), rejected: [] }))
    },
  }
}

export interface HttpBackendOptions {
  /** Provider endpoint. Defaults to Resend's. */
  url?: string
  apiKey: string
  /** Shapes the request body for the provider. Defaults to Resend's schema. */
  body?: (message: EmailMessage) => unknown
  /** Reads the provider's message id out of its response. */
  readId?: (response: unknown) => string | undefined
  headers?: Record<string, string>
  fetch?: typeof fetch
}

/**
 * Sends over a provider's HTTP API — Resend by default, and any similar one
 * through `body`.
 *
 * HTTP rather than SMTP because it is what modern deployments use, and because
 * a fetch call is something this framework can actually verify.
 */
export function httpBackend(options: HttpBackendOptions): EmailBackend {
  const url = options.url ?? 'https://api.resend.com/emails'
  const doFetch = options.fetch ?? globalThis.fetch

  const toBody =
    options.body ??
    ((message: EmailMessage) => ({
      from: message.from ? formatAddress(message.from) : undefined,
      to: addressList(message.to),
      cc: message.cc ? addressList(message.cc) : undefined,
      bcc: message.bcc ? addressList(message.bcc) : undefined,
      reply_to: message.replyTo ? formatAddress(message.replyTo) : undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
      tags: message.tag ? [{ name: 'tag', value: message.tag }] : undefined,
    }))

  return {
    name: 'http',
    async send(messages) {
      const results: SendResult[] = []

      // Sent one at a time: providers differ on batch semantics, and a partial
      // batch failure is much harder to report honestly than a per-message one.
      for (const message of messages) {
        const response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
            ...options.headers,
          },
          body: JSON.stringify(toBody(message)),
        })

        const text = await response.text()
        let payload: unknown
        try {
          payload = text === '' ? undefined : JSON.parse(text)
        } catch {
          payload = text
        }

        if (!response.ok) {
          throw new EmailError(
            `Email provider rejected the message (${response.status}).`,
            { status: response.status, response: payload, message },
          )
        }

        results.push({
          id: options.readId ? options.readId(payload) : (payload as { id?: string } | undefined)?.id,
          accepted: recipients(message),
          rejected: [],
        })
      }

      return results
    },
  }
}

export class EmailError extends Error {
  readonly status?: number
  readonly response?: unknown
  readonly email?: EmailMessage

  constructor(message: string, context: { status?: number; response?: unknown; message?: EmailMessage } = {}) {
    super(message)
    this.name = 'EmailError'
    this.status = context.status
    this.response = context.response
    this.email = context.message
  }
}

// ---------------------------------------------------------------------------
// The configured mailer
// ---------------------------------------------------------------------------

export interface EmailSettings {
  backend?: EmailBackend
  /** Default `from`, used when a message doesn't set one. */
  from?: Addressee
  /**
   * Redirects every message here instead of its real recipients, keeping the
   * originals in an `X-Original-To` header. The safety catch for staging
   * against a copy of production data.
   */
  redirectTo?: Addressee
  /** Prefix added to every subject — `[staging] `, say. */
  subjectPrefix?: string
}

export interface Mailer {
  readonly backend: EmailBackend
  send(message: EmailMessage): Promise<SendResult>
  sendMany(messages: EmailMessage[]): Promise<SendResult[]>
}

export function createMailer(settings: EmailSettings = {}): Mailer {
  const backend = settings.backend ?? consoleBackend()

  const prepare = (message: EmailMessage): EmailMessage => {
    const prepared: EmailMessage = {
      ...message,
      from: message.from ?? settings.from,
      subject: settings.subjectPrefix ? `${settings.subjectPrefix}${message.subject}` : message.subject,
    }

    if (settings.redirectTo) {
      prepared.headers = {
        ...prepared.headers,
        'X-Original-To': addressList(message.to).join(', '),
      }
      prepared.to = settings.redirectTo
      delete prepared.cc
      delete prepared.bcc
    }

    if (!prepared.from) {
      throw new EmailError(
        'No sender. Set `email.from` in settings, or `from` on the message.',
        { message: prepared },
      )
    }
    if (!prepared.text && !prepared.html) {
      throw new EmailError('An email needs `text`, `html`, or both.', { message: prepared })
    }

    return prepared
  }

  return {
    backend,
    async send(message) {
      const [result] = await backend.send([prepare(message)])
      return result!
    },
    async sendMany(messages) {
      return backend.send(messages.map(prepare))
    },
  }
}

let active: Mailer | undefined

/** The project's mailer. Falls back to the console backend when unconfigured. */
export function getMailer(): Mailer {
  return (active ??= createMailer())
}

export function setMailer(mailer: Mailer | undefined): void {
  active = mailer
}

/** Sends via the project's mailer. */
export function sendEmail(message: EmailMessage): Promise<SendResult> {
  return getMailer().send(message)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Crude but adequate: enough to produce a text alternative from an HTML body. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export { renderEmail, passwordResetEmail, verificationEmail } from './templates.ts'
export type { EmailTemplate, TemplateContext } from './templates.ts'
