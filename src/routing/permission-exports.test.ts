/**
 * The public permission set must be single-sourced. `angusjs` and `angusjs/auth`
 * used to ship two `isStaff` implementations that disagreed about superusers,
 * which is the kind of divergence npm freezes into a breaking change.
 */

import { describe, expect, test } from 'bun:test'
import * as root from '../index.ts'
import * as auth from '../auth/index.ts'
import type { Context } from './router.ts'

const ctx = (user: unknown): Context => ({ user }) as Context

describe('single-sourced predicates', () => {
  test('isStaff and readOnlyOrAuthenticated are the same function from both entry points', () => {
    expect(root.isStaff).toBe(auth.isStaff)
    expect(root.readOnlyOrAuthenticated).toBe(auth.readOnlyOrAuthenticated)
    expect(root.all).toBe(auth.all)
    expect(root.any).toBe(auth.any)
  })

  test('isStaff admits a superuser, from either entry point', async () => {
    for (const isStaff of [root.isStaff, auth.isStaff]) {
      expect(await isStaff(ctx({ isStaff: true }))).toBe(true)
      expect(await isStaff(ctx({ isSuperuser: true }))).toBe(true) // the bug: this was false at root
      expect(await isStaff(ctx({ isStaff: false, isSuperuser: false }))).toBe(false)
      expect(await isStaff(ctx(null))).toBe(false)
    }
  })
})

describe('combinators are complete and consistent', () => {
  test('root exports all, any, not, and either as an alias of any', async () => {
    expect(typeof root.all).toBe('function')
    expect(typeof root.any).toBe('function')
    expect(typeof root.not).toBe('function')
    expect(root.either).toBe(root.any)
  })

  test('all is AND, any is OR', async () => {
    const yes = () => true
    const no = () => false
    expect(await root.all(yes, yes)(ctx(null))).toBe(true)
    expect(await root.all(yes, no)(ctx(null))).toBe(false)
    expect(await root.any(no, yes)(ctx(null))).toBe(true)
    expect(await root.any(no, no)(ctx(null))).toBe(false)
  })
})
