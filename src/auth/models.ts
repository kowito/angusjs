/**
 * Identity models.
 *
 * Two models, deliberately: a `User` that owns identity, and a `Session` that
 * owns a *login*. Keeping them apart is what makes "sign out everywhere",
 * session expiry and token revocation ordinary queries rather than special
 * cases.
 *
 * Projects that need extra columns on a user should add a profile model with a
 * one-to-one back to this one, rather than the framework trying to make its own
 * model extensible — a swappable user model is the single biggest source of
 * complexity in Django's auth, and it buys less than it costs.
 */

import { defineModel, f } from '../db/index.ts'

export const User = defineModel('user', {
  fields: {
    email: f.email({ unique: true }),
    /** Argon2id hash. Never returned by a serializer. */
    passwordHash: f.char({ maxLength: 255, blank: true, default: '' }),
    name: f.char({ maxLength: 150, blank: true, default: '' }),
    /** May sign in at all. Deactivating beats deleting: rows keep referring to it. */
    isActive: f.boolean({ default: true }),
    /** May use the admin. */
    isStaff: f.boolean({ default: false }),
    /** Passes every permission check. */
    isSuperuser: f.boolean({ default: false }),
    /** Comma-free list of role names, checked by `hasRole`. */
    roles: f.json<string[]>({ default: [] }),
    emailVerifiedAt: f.datetime({ null: true }),
    lastLoginAt: f.datetime({ null: true }),
    createdAt: f.datetime({ autoNowAdd: true }),
    updatedAt: f.datetime({ autoNow: true }),
  },
  meta: {
    tableName: 'auth_users',
    ordering: ['email'],
    verboseName: 'user',
  },
})

export type UserRow = typeof User.$row

/**
 * One login. Covers both a browser session and an API token — they differ only
 * in how the secret travels, so modelling them separately would duplicate
 * expiry, revocation and last-used tracking.
 */
export const Session = defineModel('session', {
  fields: {
    user: f.foreignKey(() => User, { onDelete: 'cascade' }),
    /** SHA-256 of the secret. The secret itself is never stored. */
    tokenHash: f.char({ maxLength: 64, unique: true }),
    kind: f.char({ choices: ['session', 'token'], default: 'session' }),
    /** Human label for API tokens, shown in a "your tokens" list. */
    label: f.char({ maxLength: 100, blank: true, default: '' }),
    /** Restricts what this credential may do. Empty means "everything the user can". */
    scopes: f.json<string[]>({ default: [] }),
    expiresAt: f.datetime({ null: true }),
    revokedAt: f.datetime({ null: true }),
    lastUsedAt: f.datetime({ null: true }),
    createdAt: f.datetime({ autoNowAdd: true }),
  },
  meta: {
    tableName: 'auth_sessions',
    ordering: ['-createdAt'],
    verboseName: 'session',
  },
})

export type SessionRow = typeof Session.$row

/** Single-use tokens for password reset and email verification. */
export const VerificationToken = defineModel('verificationToken', {
  fields: {
    user: f.foreignKey(() => User, { onDelete: 'cascade' }),
    tokenHash: f.char({ maxLength: 64, unique: true }),
    purpose: f.char({ choices: ['password-reset', 'email-verification'] }),
    expiresAt: f.datetime(),
    usedAt: f.datetime({ null: true }),
    createdAt: f.datetime({ autoNowAdd: true }),
  },
  meta: {
    tableName: 'auth_verification_tokens',
    ordering: ['-createdAt'],
    verboseName: 'verification token',
  },
})

export type VerificationTokenRow = typeof VerificationToken.$row

/** Every model the auth app owns, for `defineApp({ models })` and migrations. */

/**
 * A provider identity linked to a user.
 *
 * Keyed on `(provider, subject)` rather than on email, because the provider's
 * subject is the only thing that is stable: people change their email address,
 * and reusing an address as the key means the account follows the address to
 * whoever holds it next.
 */
export const SocialAccount = defineModel('socialAccount', {
  fields: {
    user: f.foreignKey(() => User, { onDelete: 'cascade' }),
    /** `google`, `github`, and so on. */
    provider: f.char({ maxLength: 40 }),
    /** The provider's own id for this person. */
    subject: f.char({ maxLength: 255 }),
    email: f.email({ blank: true, default: '' }),
    name: f.char({ maxLength: 150, blank: true, default: '' }),
    avatarUrl: f.url({ blank: true, default: '' }),
    createdAt: f.datetime({ autoNowAdd: true }),
    lastLoginAt: f.datetime({ null: true }),
  },
  meta: {
    tableName: 'auth_social_accounts',
    ordering: ['provider'],
    verboseName: 'social account',
    // One row per provider identity. Without it a repeated callback creates a
    // second link and the account silently forks.
    uniqueTogether: [['provider', 'subject']],
  },
})

export type SocialAccountRow = typeof SocialAccount.$row

export const authModels = { User, Session, VerificationToken, SocialAccount }
