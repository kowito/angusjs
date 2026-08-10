/**
 * Turning a provider profile into a signed-in user.
 *
 * This is the part of social login where the security actually lives, and it
 * comes down to one question: when the provider hands you an email address that
 * already belongs to an account, do you log that person in?
 *
 * The answer is no, unless the provider verified the address. Otherwise anyone
 * can register at a provider using someone else's email and log in as them —
 * the account takeover that has repeatedly hit sites that treated "same email"
 * as "same person". Angus defaults to linking only on verified emails, and the
 * looser behaviour has to be asked for by name.
 */

import { atomic } from '../db/transaction.ts'
import { SocialAccount, User, type UserRow } from './models.ts'
import type { ProviderProfile } from './oauth.ts'

export type LinkPolicy =
  /** Link to an existing account only when the provider verified the email. */
  | 'verified-email'
  /**
   * Link on a matching email whether or not the provider verified it.
   *
   * Only safe when every provider you have configured verifies addresses
   * itself. Choosing this without that guarantee is an account takeover.
   */
  | 'any-email'
  /**
   * Never link. A provider identity always creates its own account.
   *
   * The safest option and the most confusing for users, who will make a second
   * account without realising. Note that it cannot create an account when the
   * email is already taken — `email` is unique — so that case is refused with
   * an explanation rather than a constraint error.
   */
  | 'never'

export interface SocialLoginOptions {
  /** Defaults to `verified-email`. */
  linkPolicy?: LinkPolicy
  /**
   * Create an account when the profile matches nothing. Defaults to true.
   *
   * Turn it off for an application where accounts are provisioned elsewhere,
   * and a login by someone unknown should fail rather than quietly enrol them.
   */
  signUp?: boolean
  /** Applied to a newly created user — roles, staff status, anything. */
  onCreate?: (user: UserRow, profile: ProviderProfile) => Promise<void> | void
}

export class SocialLoginError extends Error {
  constructor(
    message: string,
    readonly reason: 'no-account' | 'unverified-email' | 'inactive' | 'email-taken',
  ) {
    super(message)
    this.name = 'SocialLoginError'
  }
}

export interface SocialLoginResult {
  user: UserRow
  /** True when this login created the account. */
  created: boolean
  /** True when it attached a new provider to an existing account. */
  linked: boolean
}

/**
 * Finds or creates the user behind a provider profile.
 *
 * In a transaction, because it can write three rows — user, social account,
 * verification stamp — and a half-linked account is worse than a failed login:
 * it is an account nobody can sign into and no-one can see is broken.
 */
export async function resolveSocialUser(
  provider: string,
  profile: ProviderProfile,
  options: SocialLoginOptions = {},
): Promise<SocialLoginResult> {
  const policy = options.linkPolicy ?? 'verified-email'

  return atomic(async () => {
    // 1. Already linked. The provider's subject is the key, so this keeps
    //    working after someone changes their email at the provider.
    const existing = await SocialAccount.objects.getOrNull({ provider, subject: profile.subject })

    if (existing) {
      const user = await User.objects.getOrNull({ id: existing.userId })
      if (!user) {
        // The link outlived its user. Cascade should prevent it; if it happens,
        // failing is better than resurrecting a deleted account.
        throw new SocialLoginError('The linked account no longer exists.', 'no-account')
      }

      assertActive(user)

      await SocialAccount.objects.filter({ id: existing.id }).update({
        // Kept fresh: a display name that never updates looks broken.
        email: profile.email ?? '',
        name: profile.name ?? '',
        avatarUrl: profile.avatarUrl ?? '',
        lastLoginAt: new Date(),
      })

      return { user, created: false, linked: false }
    }

    // 2. Not linked. Can we attach to an existing account by email?
    if (profile.email) {
      const byEmail = await User.objects.getOrNull({ email: profile.email })

      if (byEmail && policy === 'never') {
        // The address is unique, so there is no second account to create here.
        // Saying so beats a constraint violation surfacing from three calls
        // down, which tells the user nothing they can act on.
        throw new SocialLoginError(
          `An account already uses ${profile.email}, and this application does not link ` +
            `provider identities to existing accounts. Sign in with that account and connect ` +
            `${provider} from your account settings.`,
          'email-taken',
        )
      }

      if (byEmail) {
        if (policy === 'verified-email' && !profile.emailVerified) {
          // The takeover this exists to stop: register at the provider with
          // someone else's address, and log in as them.
          throw new SocialLoginError(
            `${provider} did not verify this email address, so it cannot be linked to an existing account. ` +
              `Sign in with your password and connect ${provider} from your account settings.`,
            'unverified-email',
          )
        }

        assertActive(byEmail)
        await linkAccount(byEmail.id, provider, profile)
        return { user: byEmail, created: false, linked: true }
      }
    }

    // 3. Nobody matches.
    if (options.signUp === false) {
      throw new SocialLoginError('No account matches this login.', 'no-account')
    }

    const user = await User.objects.create({
      email: profile.email ?? `${provider}:${profile.subject}`,
      name: profile.name ?? '',
      roles: [],
      // No password: this account signs in through the provider. An empty hash
      // never matches, so it cannot be used as a password login by accident.
      passwordHash: '',
      // Only when the provider actually said so — this flag gates real
      // permissions elsewhere.
      emailVerifiedAt: profile.emailVerified ? new Date() : null,
    })

    await linkAccount(user.id, provider, profile)
    await options.onCreate?.(user, profile)

    return { user, created: true, linked: true }
  })
}

function assertActive(user: UserRow): void {
  if (!user.isActive) {
    // A deactivated account must not be revivable through a second sign-in
    // route; that would make deactivation meaningless.
    throw new SocialLoginError('This account is not active.', 'inactive')
  }
}

async function linkAccount(userId: number, provider: string, profile: ProviderProfile): Promise<void> {
  await SocialAccount.objects.create({
    user: userId,
    provider,
    subject: profile.subject,
    email: profile.email ?? '',
    name: profile.name ?? '',
    avatarUrl: profile.avatarUrl ?? '',
    lastLoginAt: new Date(),
  })
}

/** The providers a user has connected, for an account settings page. */
export async function linkedProviders(userId: number): Promise<string[]> {
  const rows = await SocialAccount.objects.filter({ user: userId }).values('provider')
  return rows.map((row) => String(row.provider))
}

/**
 * Disconnects a provider.
 *
 * Refuses to remove the last way in. Someone who signed up through Google and
 * never set a password would otherwise disconnect Google and lock themselves
 * out of an account they can still see the settings page for.
 */
export async function unlinkProvider(userId: number, provider: string): Promise<void> {
  return atomic(async () => {
    const user = await User.objects.getOrNull({ id: userId })
    if (!user) throw new SocialLoginError('No such account.', 'no-account')

    const links = await SocialAccount.objects.filter({ user: userId }).count()
    const hasPassword = user.passwordHash !== ''

    if (!hasPassword && links <= 1) {
      throw new SocialLoginError(
        `Disconnecting ${provider} would leave no way to sign in. Set a password first.`,
        'no-account',
      )
    }

    await SocialAccount.objects.filter({ user: userId, provider }).delete()
  })
}
