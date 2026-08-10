/**
 * Password hashing and credential issuing.
 *
 * Bun ships argon2id, so there is no dependency here and no opportunity to pick
 * the wrong algorithm. The rules this module enforces:
 *
 * - A secret is generated with a CSPRNG and returned exactly once.
 * - Only a hash is stored. A database dump therefore contains no usable
 *   credential.
 * - Lookups compare hashes, so a stolen row can't be replayed.
 * - Verifying a non-existent user still does the hashing work, so response time
 *   doesn't reveal whether an account exists.
 */

import { atomic } from '../db/transaction.ts'
import { Session, User, VerificationToken, type SessionRow, type UserRow } from './models.ts'

/** Cost parameters. Defaults are Bun's, which follow the OWASP guidance. */
const ARGON = { algorithm: 'argon2id' } as const

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.')
  }
  return Bun.password.hash(password, ARGON)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}

/**
 * A dummy verification, used when no user matched. Without it, a missing
 * account returns in microseconds and a real one takes ~100ms, which is enough
 * to enumerate addresses.
 */
const DUMMY_HASH = await Bun.password.hash('angus-timing-equaliser', ARGON)

export async function equaliseTiming(password: string): Promise<void> {
  await Bun.password.verify(password, DUMMY_HASH).catch(() => false)
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** 256 bits of CSPRNG, base64url — safe in a cookie, a header, or a URL. */
export function generateSecret(bytes = 32): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Buffer.from(buffer).toString('base64url')
}

/**
 * Hashes a bearer secret for storage and lookup.
 *
 * SHA-256 rather than argon2 on purpose: this value is high-entropy already, so
 * there is nothing to brute-force, and a lookup has to be a single indexed
 * query rather than a scan comparing every row.
 */
export function hashSecret(secret: string): string {
  return new Bun.CryptoHasher('sha256').update(secret).digest('hex')
}

/** Compares two hashes without leaking their common prefix through timing. */
export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

// ---------------------------------------------------------------------------
// Sessions and tokens
// ---------------------------------------------------------------------------

export interface IssuedCredential {
  /** Returned to the caller once and never recoverable afterwards. */
  secret: string
  session: SessionRow
}

export interface IssueOptions {
  kind?: 'session' | 'token'
  label?: string
  scopes?: string[]
  /** Lifetime in seconds. `null` means it does not expire. */
  ttlSeconds?: number | null
}

const DEFAULT_SESSION_TTL = 60 * 60 * 24 * 14 // two weeks

export async function issueCredential(user: UserRow, options: IssueOptions = {}): Promise<IssuedCredential> {
  const secret = generateSecret()
  const ttl = options.ttlSeconds === undefined ? DEFAULT_SESSION_TTL : options.ttlSeconds

  const session = await Session.objects.create({
    user: user.id,
    tokenHash: hashSecret(secret),
    kind: options.kind ?? 'session',
    label: options.label ?? '',
    scopes: options.scopes ?? [],
    expiresAt: ttl === null ? null : new Date(Date.now() + ttl * 1000),
  })

  return { secret, session }
}

export interface ResolvedCredential {
  user: UserRow
  session: SessionRow
}

/**
 * Looks up a credential and returns the user it belongs to, or `null` for
 * anything unusable — unknown, expired, revoked, or belonging to a deactivated
 * account. Callers never have to distinguish those cases, and shouldn't.
 */
export async function resolveCredential(secret: string): Promise<ResolvedCredential | null> {
  if (!secret) return null

  const session = await Session.objects.getOrNull({ tokenHash: hashSecret(secret) })
  if (!session) return null
  if (session.revokedAt) return null
  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) return null

  const user = await User.objects.getOrNull({ id: session.userId })
  if (!user || !user.isActive) return null

  return { user, session }
}

/** Records use, throttled so a busy session isn't written on every request. */
const LAST_USED_RESOLUTION_MS = 60_000

export async function touchSession(session: SessionRow): Promise<void> {
  const last = session.lastUsedAt?.getTime() ?? 0
  if (Date.now() - last < LAST_USED_RESOLUTION_MS) return
  await Session.objects.filter({ id: session.id }).update({ lastUsedAt: new Date() })
}

export async function revokeSession(sessionId: number): Promise<void> {
  await Session.objects.filter({ id: sessionId, revokedAt__isnull: true }).update({ revokedAt: new Date() })
}

/** Signs a user out everywhere — the thing you do after a password change. */
export async function revokeAllSessions(userId: number, options: { kind?: 'session' | 'token' } = {}): Promise<number> {
  const rows = await Session.objects
    .filter({ user: userId, revokedAt__isnull: true, ...(options.kind ? { kind: options.kind } : {}) } as never)
    .update({ revokedAt: new Date() })
  return rows.length
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  email: string
  password?: string
  name?: string
  isStaff?: boolean
  isSuperuser?: boolean
  roles?: string[]
}

export async function createUser(input: CreateUserInput): Promise<UserRow> {
  return User.objects.create({
    email: input.email.trim().toLowerCase(),
    passwordHash: input.password ? await hashPassword(input.password) : '',
    name: input.name ?? '',
    isStaff: input.isStaff ?? false,
    isSuperuser: input.isSuperuser ?? false,
    roles: input.roles ?? [],
  })
}

/**
 * Verifies an email and password.
 *
 * Returns `null` for every failure — wrong password, unknown address, inactive
 * account — because telling them apart is how account enumeration works.
 */
export async function authenticate(email: string, password: string): Promise<UserRow | null> {
  const user = await User.objects.getOrNull({ email: email.trim().toLowerCase() })

  if (!user) {
    await equaliseTiming(password)
    return null
  }

  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid || !user.isActive) return null

  await User.objects.filter({ id: user.id }).update({ lastLoginAt: new Date() })
  return user
}

/** Changes a password and invalidates every existing browser session. */
export async function setPassword(userId: number, password: string): Promise<void> {
  const passwordHash = await hashPassword(password)
  await atomic(async () => {
    await User.objects.filter({ id: userId }).update({ passwordHash })
    await revokeAllSessions(userId, { kind: 'session' })
  })
}

// ---------------------------------------------------------------------------
// Verification tokens
// ---------------------------------------------------------------------------

const VERIFICATION_TTL = 60 * 60 // one hour

export async function issueVerificationToken(
  userId: number,
  purpose: 'password-reset' | 'email-verification',
  ttlSeconds = VERIFICATION_TTL,
): Promise<string> {
  const secret = generateSecret()
  await VerificationToken.objects.create({
    user: userId,
    tokenHash: hashSecret(secret),
    purpose,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  })
  return secret
}

/**
 * Consumes a token, returning the user it belongs to. Single use: the row is
 * marked immediately, inside a transaction, so the same link can't be replayed.
 */
export async function consumeVerificationToken(
  secret: string,
  purpose: 'password-reset' | 'email-verification',
): Promise<UserRow | null> {
  return atomic(async () => {
    const token = await VerificationToken.objects.getOrNull({ tokenHash: hashSecret(secret), purpose } as never)
    if (!token || token.usedAt) return null
    if (token.expiresAt.getTime() <= Date.now()) return null

    await VerificationToken.objects.filter({ id: token.id }).update({ usedAt: new Date() })
    const user = await User.objects.getOrNull({ id: token.userId })
    return user && user.isActive ? user : null
  })
}
