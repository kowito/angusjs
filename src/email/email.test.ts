import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '../core/project.ts'
import { authApp, authenticate } from '../auth/app.ts'
import { createUser } from '../auth/credentials.ts'
import { authModels, User } from '../auth/models.ts'
import { clientFor, testDatabase, type TestClient, type TestDatabase } from '../testing/index.ts'
import {
  consoleBackend,
  createMailer,
  EmailError,
  formatAddress,
  httpBackend,
  memoryBackend,
  nullBackend,
  passwordResetEmail,
  renderEmail,
  setMailer,
  stripHtml,
  verificationEmail,
  type MemoryBackend,
} from './index.ts'

describe('addresses', () => {
  test('formats a name and address', () => {
    expect(formatAddress({ name: 'Ada', address: 'ada@example.com' })).toBe('Ada <ada@example.com>')
    expect(formatAddress('ada@example.com')).toBe('ada@example.com')
    expect(formatAddress({ address: 'ada@example.com' })).toBe('ada@example.com')
  })

  test('quotes a name containing characters that would break the header', () => {
    expect(formatAddress({ name: 'Doe, Jane', address: 'jane@example.com' })).toBe('"Doe, Jane" <jane@example.com>')
    expect(formatAddress({ name: 'A "B"', address: 'a@example.com' })).toBe('"A \\"B\\"" <a@example.com>')
  })
})

describe('the memory backend', () => {
  let backend: MemoryBackend

  beforeEach(() => {
    backend = memoryBackend()
  })

  test('collects instead of sending, so tests can assert', async () => {
    const mailer = createMailer({ backend, from: 'no-reply@example.com' })
    await mailer.send({ to: 'ada@example.com', subject: 'Hello', text: 'Hi' })

    expect(backend.outbox).toHaveLength(1)
    expect(backend.outbox[0]!.subject).toBe('Hello')
    expect(backend.lastTo('ada@example.com')?.text).toBe('Hi')
  })

  test('lastTo matches case-insensitively and ignores the display name', async () => {
    const mailer = createMailer({ backend, from: 'no-reply@example.com' })
    await mailer.send({ to: { name: 'Ada', address: 'Ada@Example.com' }, subject: 'Hi', text: 'x' })
    expect(backend.lastTo('ada@example.com')).toBeDefined()
  })

  test('clear empties the outbox', async () => {
    const mailer = createMailer({ backend, from: 'a@b.c' })
    await mailer.send({ to: 'x@y.z', subject: 's', text: 't' })
    backend.clear()
    expect(backend.outbox).toEqual([])
  })
})

describe('the mailer', () => {
  test('applies the default sender', async () => {
    const backend = memoryBackend()
    const mailer = createMailer({ backend, from: { name: 'Acme', address: 'no-reply@acme.com' } })
    await mailer.send({ to: 'a@b.c', subject: 's', text: 't' })
    expect(formatAddress(backend.outbox[0]!.from!)).toBe('Acme <no-reply@acme.com>')
  })

  test('a message may override the sender', async () => {
    const backend = memoryBackend()
    const mailer = createMailer({ backend, from: 'default@acme.com' })
    await mailer.send({ to: 'a@b.c', from: 'billing@acme.com', subject: 's', text: 't' })
    expect(backend.outbox[0]!.from).toBe('billing@acme.com')
  })

  test('refuses a message with no sender at all', async () => {
    const mailer = createMailer({ backend: memoryBackend() })
    expect(mailer.send({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/No sender/)
  })

  test('refuses a message with no body', async () => {
    const mailer = createMailer({ backend: memoryBackend(), from: 'a@b.c' })
    expect(mailer.send({ to: 'x@y.z', subject: 's' })).rejects.toThrow(/needs `text`, `html`/)
  })

  test('subjectPrefix marks non-production mail', async () => {
    const backend = memoryBackend()
    const mailer = createMailer({ backend, from: 'a@b.c', subjectPrefix: '[staging] ' })
    await mailer.send({ to: 'x@y.z', subject: 'Invoice', text: 't' })
    expect(backend.outbox[0]!.subject).toBe('[staging] Invoice')
  })

  test('redirectTo diverts every recipient and records the original', async () => {
    // The safety catch for staging against a copy of production data: without
    // it, a test run mails real customers.
    const backend = memoryBackend()
    const mailer = createMailer({ backend, from: 'a@b.c', redirectTo: 'dev@acme.com' })

    await mailer.send({
      to: 'customer@real.com',
      cc: 'manager@real.com',
      subject: 'Invoice',
      text: 't',
    })

    const sent = backend.outbox[0]!
    expect(sent.to).toBe('dev@acme.com')
    expect(sent.cc).toBeUndefined()
    expect(sent.headers?.['X-Original-To']).toBe('customer@real.com')
  })

  test('sendMany prepares each message', async () => {
    const backend = memoryBackend()
    const mailer = createMailer({ backend, from: 'a@b.c' })
    await mailer.sendMany([
      { to: 'one@x.com', subject: '1', text: 'a' },
      { to: 'two@x.com', subject: '2', text: 'b' },
    ])
    expect(backend.outbox).toHaveLength(2)
    expect(backend.outbox.every((message) => message.from === 'a@b.c')).toBe(true)
  })
})

describe('the HTTP backend', () => {
  test('posts the provider payload and returns the id', async () => {
    const seen: { url: string; body: any; auth: string | null }[] = []

    const backend = httpBackend({
      apiKey: 'secret-key',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({
          url: String(url),
          body: JSON.parse(String(init.body)),
          auth: new Headers(init.headers).get('authorization'),
        })
        return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 })
      }) as unknown as typeof fetch,
    })

    const mailer = createMailer({ backend, from: 'Acme <no-reply@acme.com>' })
    const result = await mailer.send({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hello</p>' })

    expect(result.id).toBe('msg_123')
    expect(seen[0]!.url).toContain('resend.com')
    expect(seen[0]!.auth).toBe('Bearer secret-key')
    expect(seen[0]!.body.to).toEqual(['ada@example.com'])
    expect(seen[0]!.body.subject).toBe('Hi')
  })

  test('a provider rejection raises EmailError carrying the response', async () => {
    const backend = httpBackend({
      apiKey: 'k',
      fetch: (async () =>
        new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 })) as unknown as typeof fetch,
    })

    const mailer = createMailer({ backend, from: 'a@b.c' })

    try {
      await mailer.send({ to: 'x@y.z', subject: 's', text: 't' })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(EmailError)
      expect((error as EmailError).status).toBe(403)
      expect((error as EmailError).response).toEqual({ message: 'domain not verified' })
    }
  })

  test('a custom body shape supports other providers', async () => {
    let captured: any
    const backend = httpBackend({
      url: 'https://api.postmarkapp.com/email',
      apiKey: 'k',
      body: (message) => ({ Subject: message.subject, TextBody: message.text }),
      readId: (response) => (response as { MessageID?: string }).MessageID,
      fetch: (async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ MessageID: 'pm-1' }), { status: 200 })
      }) as unknown as typeof fetch,
    })

    const result = await createMailer({ backend, from: 'a@b.c' }).send({
      to: 'x@y.z',
      subject: 'Custom',
      text: 'body',
    })

    expect(captured).toEqual({ Subject: 'Custom', TextBody: 'body' })
    expect(result.id).toBe('pm-1')
  })
})

describe('other backends', () => {
  test('the console backend accepts everything and sends nothing', async () => {
    const result = await createMailer({ backend: consoleBackend(), from: 'a@b.c' }).send({
      to: 'x@y.z',
      subject: 's',
      text: 't',
    })
    expect(result.accepted).toEqual(['x@y.z'])
  })

  test('the null backend discards', async () => {
    const result = await createMailer({ backend: nullBackend(), from: 'a@b.c' }).send({
      to: 'x@y.z',
      subject: 's',
      text: 't',
    })
    expect(result.rejected).toEqual([])
  })
})

describe('templates', () => {
  test('every template produces both text and html', () => {
    // HTML-only mail scores worse with spam filters and some clients prefer text.
    for (const template of [
      passwordResetEmail({ resetUrl: 'https://x/reset?token=abc' }),
      verificationEmail({ verifyUrl: 'https://x/verify?token=abc' }),
    ]) {
      expect(template.text.length).toBeGreaterThan(20)
      expect(template.html).toContain('<html>')
      expect(template.subject.length).toBeGreaterThan(0)
    }
  })

  test('the action link appears in both parts', () => {
    const url = 'https://example.com/reset?token=abc123'
    const template = passwordResetEmail({ resetUrl: url, siteName: 'Acme' })
    expect(template.html).toContain(url)
    expect(template.text).toContain(url)
    expect(template.subject).toContain('Acme')
  })

  test('interpolated values are escaped, so a name cannot inject markup', () => {
    const rendered = renderEmail({ title: 'Hi', body: ['<script>alert(1)</script>'] })
    expect(rendered.html).toContain('&lt;script&gt;')
    expect(rendered.html).not.toContain('<script>alert(1)</script>')
  })

  test('a javascript: action URL is defused, not just escaped', () => {
    // Webmail renders these in a browser, so the scheme matters even in email.
    const rendered = renderEmail({
      title: 'Hi',
      body: ['x'],
      action: { label: 'Go', url: 'javascript:alert(1)' },
    })
    expect(rendered.html).not.toContain('href="javascript:')
    expect(rendered.html).toContain('href="#"')
  })

  test('a URL with a quote cannot break out of the href', () => {
    const rendered = renderEmail({
      title: 'Hi',
      body: ['x'],
      action: { label: 'Go', url: 'https://x/?a="onmouseover="evil()' },
    })
    expect(rendered.html).not.toContain('onmouseover="evil()"')
    expect(rendered.html).toContain('&quot;')
  })

  test('stripHtml produces readable text', () => {
    expect(stripHtml('<p>One</p><p>Two &amp; three</p>')).toBe('One\nTwo & three')
  })
})

describe('password reset over HTTP', () => {
  let db: TestDatabase
  let client: TestClient
  let outbox: MemoryBackend

  beforeAll(async () => {
    db = await testDatabase({ models: Object.values(authModels) })
    outbox = memoryBackend()

    const app = await createApp(
      {
        apps: [authApp({ siteUrl: 'https://acme.test', siteName: 'Acme' })],
        prefix: '/api',
        openapi: false,
        authenticate,
        email: { backend: outbox, from: 'Acme <no-reply@acme.test>' },
      },
      { connectDatabase: false },
    )
    client = clientFor(app, { basePath: '/api' })
  })

  afterAll(async () => {
    await db.close()
    setMailer(undefined)
  })

  beforeEach(async () => {
    await db.reset()
    outbox.clear()
    await createUser({ email: 'ada@example.com', password: 'correct-horse-battery' })
  })

  test('a reset request sends the built-in email with a working link', async () => {
    await client.post('/auth/password-reset', { email: 'ada@example.com' })

    const sent = outbox.lastTo('ada@example.com')!
    expect(sent).toBeDefined()
    expect(sent.subject).toContain('Acme')
    expect(sent.html).toContain('https://acme.test/reset-password?token=')

    // The link in the email actually resets the password.
    // \s matters: a negated class matches newlines, so [^"&]+ would swallow
    // the rest of the message.
    const token = decodeURIComponent(/token=([^\s"&]+)/.exec(sent.text!)![1]!)
    const confirmed = await client.post('/auth/password-reset/confirm', { token, password: 'a-new-password-here' })
    expect(confirmed.status).toBe(200)
  })

  test('an unknown address sends nothing but answers the same', async () => {
    const known = await client.post('/auth/password-reset', { email: 'ada@example.com' })
    outbox.clear()
    const unknown = await client.post('/auth/password-reset', { email: 'nobody@example.com' })

    expect(unknown.body).toEqual(known.body)
    // Sending nothing is what keeps the answer from revealing the account.
    expect(outbox.outbox).toHaveLength(0)
  })

  test('a delivery failure does not reveal that the account exists', async () => {
    const failing = await createApp(
      {
        apps: [authApp({ siteUrl: 'https://acme.test' })],
        prefix: '/api',
        openapi: false,
        authenticate,
        email: {
          from: 'a@b.c',
          backend: {
            name: 'broken',
            async send() {
              throw new Error('provider down')
            },
          },
        },
      },
      { connectDatabase: false },
    )

    const response = await clientFor(failing, { basePath: '/api' }).post('/auth/password-reset', {
      email: 'ada@example.com',
    })

    // Still 200 with the neutral message: a 500 here would confirm the address.
    expect(response.status).toBe(200)
    expect(response.body.detail).toContain('If that address has an account')
  })

  test('sendPasswordReset still overrides delivery', async () => {
    const seen: { email: string; url: string }[] = []
    const custom = await createApp(
      {
        apps: [
          authApp({
            siteUrl: 'https://acme.test',
            sendPasswordReset: ({ user, url }) => void seen.push({ email: user.email, url }),
          }),
        ],
        prefix: '/api',
        openapi: false,
        authenticate,
        email: { backend: outbox, from: 'a@b.c' },
      },
      { connectDatabase: false },
    )

    outbox.clear()
    await clientFor(custom, { basePath: '/api' }).post('/auth/password-reset', { email: 'ada@example.com' })

    expect(seen[0]!.email).toBe('ada@example.com')
    expect(seen[0]!.url).toContain('token=')
    // The override replaces delivery rather than adding to it.
    expect(outbox.outbox).toHaveLength(0)
  })
})
