/**
 * The testing utilities, tested through the utilities themselves — which is
 * also the clearest documentation of how a project is meant to use them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { defineApp } from '../core/app.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { router } from '../routing/router.ts'
import { modelViewSet } from '../routing/viewset.ts'
import { serializer } from '../serializers/index.ts'
import { factory, testClient, testDatabase, transactional, type TestClient, type TestDatabase } from './index.ts'

const Team = defineModel('t_team', {
  fields: { name: f.char({ maxLength: 60, unique: true }) },
  meta: { tableName: 'tt_teams', ordering: ['name'] },
})

const Player = defineModel('t_player', {
  fields: {
    name: f.char({ maxLength: 60 }),
    shirt: f.integer({ default: 0 }),
    active: f.boolean({ default: true }),
    team: f.foreignKey(() => Team, { null: true, onDelete: 'set null' }),
    joinedAt: f.datetime({ autoNowAdd: true }),
  },
  meta: { tableName: 'tt_players', ordering: ['name'] },
})

const PlayerSerializer = serializer(Player, { name: 'TPlayer', readOnly: ['id', 'joinedAt'] })

const app = defineApp({
  name: 'league',
  prefix: '/',
  models: { Team, Player },
  urls: router().include('/players', modelViewSet({ model: Player, serializer: PlayerSerializer, pagination: false })),
})

const teams = factory(Team, (n) => ({ name: `Team ${n}` }))
const players = factory(Player, (n) => ({ name: `Player ${n}`, shirt: n }))

let db: TestDatabase
let client: TestClient

beforeAll(async () => {
  // Tables come from the model definitions, so a test never depends on
  // migration state that may have drifted.
  db = await testDatabase({ models: [Team, Player] })
  client = await testClient({ apps: [app], prefix: '/api', openapi: false }, { basePath: '/api' })
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.reset()
})

describe('testDatabase', () => {
  test('creates tables from the models, with defaults applied', async () => {
    const player = await Player.objects.create({ name: 'Ada' })
    expect(player.shirt).toBe(0)
    expect(player.active).toBe(true)
    expect(player.teamId).toBeNull()
  })

  test('enforces uniqueness declared on a field', async () => {
    await Team.objects.create({ name: 'Rovers' })
    expect(Team.objects.create({ name: 'Rovers' })).rejects.toThrow()
  })

  test('creates referenced tables first, so foreign keys resolve', async () => {
    const team = await teams.create()
    const player = await players.create({ team: team.id })
    expect(player.teamId).toBe(team.id)
  })

  test('honours ON DELETE from the relation', async () => {
    const team = await teams.create()
    const player = await players.create({ team: team.id })
    await Team.objects.filter({ id: team.id }).delete()
    expect((await Player.objects.get({ id: player.id })).teamId).toBeNull()
  })

  test('reset empties every table and restarts ids', async () => {
    await players.createMany(3)
    await db.reset()
    expect(await Player.objects.count()).toBe(0)
    expect((await players.create()).id).toBe(1)
  })
})

describe('factory', () => {
  test('fills in what the test does not mention', async () => {
    const player = await players.create({ name: 'Named' })
    expect(player.name).toBe('Named')
    expect(player.shirt).toBeGreaterThan(0)
  })

  test('generates distinct values across calls', async () => {
    const [a, b] = await Promise.all([teams.create(), teams.create()])
    expect(a!.name).not.toBe(b!.name)
  })

  test('createMany accepts per-index overrides', async () => {
    const created = await players.createMany(3, (index) => ({ shirt: 100 + index }))
    expect(created.map((row) => row.shirt)).toEqual([100, 101, 102])
  })

  test('attributes builds without touching the database', async () => {
    const attributes = players.attributes({ name: 'Draft' })
    expect(attributes.name).toBe('Draft')
    expect(await Player.objects.count()).toBe(0)
  })
})

describe('transactional', () => {
  test('rolls the case back, leaving no trace', async () => {
    await transactional(async () => {
      await players.createMany(3)
      expect(await Player.objects.count()).toBe(3)
    })
    expect(await Player.objects.count()).toBe(0)
  })

  test('returns the block value', async () => {
    const name = await transactional(async () => (await players.create({ name: 'Kept' })).name)
    expect(name).toBe('Kept')
  })

  test('a failing case still propagates its error', async () => {
    expect(transactional(async () => {
      await players.create()
      throw new Error('assertion failed')
    })).rejects.toThrow('assertion failed')
  })
})

describe('TestClient', () => {
  test('drives the real app with no port', async () => {
    await players.create({ name: 'Ada' })
    const response = await client.get('/players')
    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.body).toHaveLength(1)
  })

  test('posts JSON and parses the response', async () => {
    const response = await client.post('/players', { name: 'Grace', shirt: 7, active: true })
    expect(response.status).toBe(201)
    expect(response.body.name).toBe('Grace')
  })

  test('surfaces validation failures as status plus body', async () => {
    const response = await client.post('/players', {})
    expect(response.status).toBe(422)
    expect(response.body.errors).toBeDefined()
  })

  test('patch and delete work', async () => {
    const player = await players.create({ name: 'Kay' })
    expect((await client.patch(`/players/${player.id}`, { name: 'Kay II' })).body.name).toBe('Kay II')
    expect((await client.delete(`/players/${player.id}`)).status).toBe(204)
    expect(await Player.objects.count()).toBe(0)
  })

  test('with() adds headers to every subsequent request', async () => {
    const tenant = client.with({ 'x-tenant': 'acme' })
    // The header reaches the app; this route ignores it, but the response
    // proves the derived client still works.
    expect((await tenant.get('/players')).status).toBe(200)
  })

  test('a 404 is reported, not thrown', async () => {
    const response = await client.get('/players/999')
    expect(response.status).toBe(404)
    expect(response.body.error).toBe('NotFound')
  })
})
