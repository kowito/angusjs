/**
 * Admin tests: real models, real HTML, real form posts through `app.handle()`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Elysia } from 'elysia'
import { createApp } from '../core/project.ts'
import { connect, disconnect, getConnection } from '../db/connection.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { adminSite } from './site.ts'
import { parseValue } from './widgets.ts'

const Team = defineModel('team', {
  fields: { name: f.char({ maxLength: 60 }) },
  meta: { ordering: ['name'] },
})

const Member = defineModel('member', {
  fields: {
    name: f.char({ maxLength: 80 }),
    email: f.email({ unique: true }),
    role: f.char({ choices: ['dev', 'ops', 'design'], default: 'dev' }),
    active: f.boolean({ default: true }),
    team: f.foreignKey(() => Team, { null: true, onDelete: 'set null' }),
    score: f.integer({ default: 0, min: 0 }),
    joinedAt: f.datetime({ autoNowAdd: true }),
  },
  meta: { ordering: ['name'] },
})

const admin = adminSite({ title: 'Test admin' })
admin.register(Team, { group: 'Org', listDisplay: ['id', 'name'], searchFields: ['name'] })
admin.register(Member, {
  group: 'Org',
  listDisplay: ['name', 'email', 'role', 'active', 'team'],
  listFilter: ['role', 'active', 'team'],
  searchFields: ['name', 'email'],
  readonlyFields: ['joinedAt'],
  listPerPage: 2,
})

let app: Elysia<any, any>

const get = async (path: string, init: RequestInit = {}) => {
  const response = await app.handle(new Request(`http://test${path}`, init))
  return { status: response.status, html: await response.text(), response }
}

const post = async (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const body = new URLSearchParams(fields).toString()
  const response = await app.handle(
    new Request(`http://test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
    }),
  )
  return { status: response.status, location: response.headers.get('location'), html: await response.text() }
}

beforeAll(async () => {
  await connect({ dialect: 'sqlite', url: ':memory:' }, [Team, Member])
  getConnection().client.exec(`
    CREATE TABLE teams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'dev',
      active INTEGER NOT NULL DEFAULT true,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      score INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL
    );
  `)
  app = await createApp({ apps: [admin.app()], openapi: false }, { connectDatabase: false })
})

afterAll(async () => {
  await disconnect()
})

beforeEach(async () => {
  getConnection().client.exec(`
    DELETE FROM members; DELETE FROM teams;
    DELETE FROM sqlite_sequence WHERE name IN ('members', 'teams');
  `)
  await Team.objects.bulkCreate([{ name: 'Platform' }, { name: 'Design' }])
  await Member.objects.bulkCreate([
    { name: 'Ada', email: 'ada@example.com', role: 'dev', team: 1, score: 10 },
    { name: 'Grace', email: 'grace@example.com', role: 'ops', team: 1, score: 20 },
    { name: 'Kay', email: 'kay@example.com', role: 'design', team: 2, active: false, score: 30 },
  ])
})

describe('index', () => {
  test('lists registered models with row counts', async () => {
    const { status, html } = await get('/admin')
    expect(status).toBe(200)
    expect(html).toContain('Org')
    expect(html).toContain('members')
    expect(html).toContain('3 rows')
  })

  test('an unregistered model 404s', async () => {
    expect((await get('/admin/nope')).status).toBe(404)
  })
})

describe('changelist', () => {
  test('renders the configured columns', async () => {
    const { html } = await get('/admin/member')
    expect(html).toContain('ada@example.com')
    expect(html).toContain('>role<')
    // joinedAt is not in listDisplay, so it should not be a column header.
    expect(html).not.toContain('>joinedAt<')
  })

  test('renders a relation as its label, not its id', async () => {
    const { html } = await get('/admin/member')
    expect(html).toContain('Platform')
  })

  test('paginates at listPerPage', async () => {
    // Ordering falls back to the model's own `['name']`: Ada, Grace, Kay.
    const { html } = await get('/admin/member')
    expect(html).toContain('3 rows')
    expect(html).toContain('page 1 of 2')
    expect(html).toContain('ada@example.com')
    expect(html).toContain('grace@example.com')
    expect(html).not.toContain('kay@example.com')
  })

  test('the second page shows the rest', async () => {
    const { html } = await get('/admin/member?p=2')
    expect(html).toContain('kay@example.com')
    expect(html).not.toContain('ada@example.com')
  })

  test('searches the configured fields', async () => {
    const { html } = await get('/admin/member?q=grace')
    expect(html).toContain('grace@example.com')
    expect(html).not.toContain('ada@example.com')
    expect(html).toContain('1 row')
  })

  test('filters on a choice field', async () => {
    const { html } = await get('/admin/member?f_role=ops')
    expect(html).toContain('Grace')
    expect(html).not.toContain('Ada')
  })

  test('filters on a boolean', async () => {
    const { html } = await get('/admin/member?f_active=false')
    expect(html).toContain('Kay')
    expect(html).toContain('1 row')
  })

  test('filters on a relation', async () => {
    const { html } = await get('/admin/member?f_team=2')
    expect(html).toContain('Kay')
    expect(html).toContain('1 row')
  })

  test('sorts by a column and keeps other params', async () => {
    // All three match "a"; descending by name gives Kay, Grace, Ada — and
    // listPerPage is 2, so the first page is Kay then Grace.
    const { html } = await get('/admin/member?o=-name&q=a')
    expect(html).toContain('o=-name')
    expect(html).toContain('q=a')
    expect(html.indexOf('kay@example.com')).toBeLessThan(html.indexOf('grace@example.com'))
  })

  test('an empty result set says so', async () => {
    const { html } = await get('/admin/member?q=nobodyhere')
    expect(html).toContain('Nothing to show')
  })
})

describe('add form', () => {
  test('renders a control per editable field', async () => {
    const { html } = await get('/admin/member/add')
    expect(html).toContain('name="name"')
    expect(html).toContain('name="email"')
    // Choices become a select, booleans a checkbox, relations a select.
    expect(html).toContain('<option value="dev"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('>Platform</option>')
    // Auto timestamps are never editable.
    expect(html).not.toContain('name="joinedAt"')
  })

  test('a nullable relation offers a blank option, selected by default', async () => {
    const { html } = await get('/admin/member/add')
    expect(html).toContain('<option value="" selected>—</option>')
  })

  test('creates and redirects to the change form', async () => {
    const created = await post('/admin/member/add', {
      name: 'Barbara',
      email: 'barbara@example.com',
      role: 'dev',
      team: '1',
      score: '5',
      active: 'true',
    })
    expect(created.status).toBe(303)
    expect(created.location).toMatch(/\/admin\/member\/\d+$/)

    const row = await Member.objects.get({ email: 'barbara@example.com' })
    expect(row.name).toBe('Barbara')
    expect(row.teamId).toBe(1)
    expect(row.active).toBe(true)
  })

  test('an unchecked checkbox stores false', async () => {
    await post('/admin/member/add', {
      name: 'Inactive',
      email: 'inactive@example.com',
      role: 'dev',
      team: '',
      score: '0',
      // `active` omitted entirely, as a browser does for an unchecked box.
    })
    const row = await Member.objects.get({ email: 'inactive@example.com' })
    expect(row.active).toBe(false)
  })

  test('a blank nullable relation stores null', async () => {
    await post('/admin/member/add', {
      name: 'Teamless',
      email: 'teamless@example.com',
      role: 'dev',
      team: '',
      score: '0',
    })
    const row = await Member.objects.get({ email: 'teamless@example.com' })
    expect(row.teamId).toBeNull()
  })

  test('re-renders with a field error rather than saving', async () => {
    const { status, html } = await post('/admin/member/add', {
      name: 'Bad',
      email: 'not-an-email',
      role: 'dev',
      team: '',
      score: '0',
    })
    expect(status).toBe(200)
    expect(html).toContain('Enter a valid email address.')
    expect(await Member.objects.filter({ name: 'Bad' }).exists()).toBe(false)
  })

  test('rejects a value outside the declared choices', async () => {
    const { html } = await post('/admin/member/add', {
      name: 'X',
      email: 'x@example.com',
      role: 'president',
      team: '',
      score: '0',
    })
    expect(html).toContain('Choose one of')
  })

  test('reports a missing required field', async () => {
    const { html } = await post('/admin/member/add', { name: '', email: 'y@example.com', role: 'dev', score: '0' })
    expect(html).toContain('This field is required.')
  })

  test('explains a unique violation in plain language', async () => {
    const { html } = await post('/admin/member/add', {
      name: 'Clash',
      email: 'ada@example.com',
      role: 'dev',
      team: '',
      score: '0',
    })
    expect(html).toContain('must be unique')
  })

  test('explains a dangling foreign key', async () => {
    const { html } = await post('/admin/member/add', {
      name: 'Ghost',
      email: 'ghost@example.com',
      role: 'dev',
      team: '999',
      score: '0',
    })
    expect(html).toContain('does not exist')
  })
})

describe('change form', () => {
  test('shows current values', async () => {
    const { html } = await get('/admin/member/1')
    expect(html).toContain('value="ada@example.com"')
    expect(html).toContain('<option value="dev" selected>')
  })

  test('shows readonly fields without an input', async () => {
    const { html } = await get('/admin/member/1')
    expect(html).toContain('joinedAt')
    expect(html).not.toContain('name="joinedAt"')
  })

  test('saves and redirects', async () => {
    const { status } = await post('/admin/member/1', {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'ops',
      team: '2',
      score: '99',
      active: 'true',
    })
    expect(status).toBe(303)
    const row = await Member.objects.get({ id: 1 })
    expect(row.name).toBe('Ada Lovelace')
    expect(row.role).toBe('ops')
    expect(row.teamId).toBe(2)
  })

  test('a missing pk 404s', async () => {
    expect((await get('/admin/member/999')).status).toBe(404)
  })

  test('a non-numeric pk 404s rather than throwing', async () => {
    expect((await get('/admin/member/abc')).status).toBe(404)
  })
})

describe('delete', () => {
  test('confirmation page names the row', async () => {
    const { status, html } = await get('/admin/member/1/delete')
    expect(status).toBe(200)
    expect(html).toContain('Ada')
    expect(html).toContain('permanently removed')
  })

  test('posting removes the row', async () => {
    const { status } = await post('/admin/member/1/delete', {})
    expect(status).toBe(303)
    expect(await Member.objects.filter({ id: 1 }).exists()).toBe(false)
  })
})

describe('escaping', () => {
  test('HTML in data is escaped everywhere it is shown', async () => {
    await Member.objects.create({
      name: '<script>alert(1)</script>',
      email: 'xss@example.com',
      role: 'dev',
      score: 0,
    })

    const list = await get('/admin/member?q=script')
    expect(list.html).toContain('&lt;script&gt;')
    expect(list.html).not.toContain('<script>alert(1)</script>')

    const row = await Member.objects.get({ email: 'xss@example.com' })
    const form = await get(`/admin/member/${row.id}`)
    expect(form.html).not.toContain('<script>alert(1)</script>')
  })

  test('a quote in a value cannot break out of an attribute', async () => {
    await Member.objects.create({ name: 'a" onfocus="evil()', email: 'q@example.com', role: 'dev', score: 0 })
    const row = await Member.objects.get({ email: 'q@example.com' })
    const { html } = await get(`/admin/member/${row.id}`)
    expect(html).not.toContain('onfocus="evil()"')
    expect(html).toContain('&quot;')
  })
})

describe('access control', () => {
  test('cross-origin form posts are refused', async () => {
    const { status } = await post(
      '/admin/member/add',
      { name: 'Evil', email: 'evil@example.com', role: 'dev', score: '0' },
      { origin: 'http://evil.example' },
    )
    expect(status).toBe(403)
  })

  test('a cross-site fetch is refused', async () => {
    const { status } = await post(
      '/admin/member/add',
      { name: 'Evil', email: 'evil2@example.com', role: 'dev', score: '0' },
      { 'sec-fetch-site': 'cross-site' },
    )
    expect(status).toBe(403)
  })

  test('same-origin posts are allowed', async () => {
    const { status } = await post(
      '/admin/member/add',
      { name: 'Fine', email: 'fine@example.com', role: 'dev', team: '', score: '0' },
      { origin: 'http://test', 'sec-fetch-site': 'same-origin' },
    )
    expect(status).toBe(303)
  })

  test('configured permissions gate every page', async () => {
    const locked = adminSite({ title: 'Locked', path: '/locked' })
    locked.register(Team)
    const lockedApp = await createApp(
      { apps: [locked.app('locked-admin')], openapi: false },
      { connectDatabase: false },
    )
    // No `user` is ever derived, so the staff check always fails.
    const response = await lockedApp.handle(new Request('http://test/locked'))
    expect(response.status).toBe(200)

    const guarded = adminSite({
      title: 'Guarded',
      path: '/guarded',
      permissions: [(context) => Boolean((context.user as { isStaff?: boolean } | undefined)?.isStaff)],
    })
    guarded.register(Team)
    const guardedApp = await createApp(
      { apps: [guarded.app('guarded-admin')], openapi: false },
      { connectDatabase: false },
    )
    expect((await guardedApp.handle(new Request('http://test/guarded'))).status).toBe(401)
  })
})

describe('parseValue', () => {
  const spec = (overrides: Record<string, unknown>) =>
    ({ kind: 'char', null: false, blank: false, unique: false, index: false, primaryKey: false, editable: true, auto: false, hasDefault: false, ...overrides }) as never

  test('an empty value on a nullable field becomes null', () => {
    expect(parseValue(spec({ null: true }), '')).toEqual({ ok: true, value: null })
  })

  test('an empty value on a defaulted field is omitted so the default applies', () => {
    expect(parseValue(spec({ hasDefault: true }), '')).toEqual({ ok: true, value: undefined })
  })

  test('an empty value on a blankable string becomes an empty string', () => {
    expect(parseValue(spec({ blank: true }), '')).toEqual({ ok: true, value: '' })
  })

  test('an empty value on a required field is an error', () => {
    expect(parseValue(spec({}), '')).toEqual({ ok: false, error: 'This field is required.' })
  })

  test('integers reject decimals and respect bounds', () => {
    expect(parseValue(spec({ kind: 'integer' }), '4.5').ok).toBe(false)
    expect(parseValue(spec({ kind: 'integer', min: 10 }), '3').ok).toBe(false)
    expect(parseValue(spec({ kind: 'integer' }), '42')).toEqual({ ok: true, value: 42 })
  })

  test('decimals stay strings so precision survives', () => {
    expect(parseValue(spec({ kind: 'decimal' }), '19.99')).toEqual({ ok: true, value: '19.99' })
  })

  test('json round-trips or reports a parse failure', () => {
    expect(parseValue(spec({ kind: 'json' }), '{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseValue(spec({ kind: 'json' }), '{oops').ok).toBe(false)
  })

  test('an unchecked checkbox is false', () => {
    expect(parseValue(spec({ kind: 'boolean' }), undefined)).toEqual({ ok: true, value: false })
    expect(parseValue(spec({ kind: 'boolean' }), 'true')).toEqual({ ok: true, value: true })
  })
})
