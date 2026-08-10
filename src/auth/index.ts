export { authModels, Session, User, VerificationToken } from './models.ts'
export type { SessionRow, UserRow, VerificationTokenRow } from './models.ts'

export {
  authenticate as verifyCredentials,
  consumeVerificationToken,
  createUser,
  generateSecret,
  hashPassword,
  hashSecret,
  issueCredential,
  issueVerificationToken,
  resolveCredential,
  revokeAllSessions,
  revokeSession,
  safeEqual,
  setPassword,
  verifyPassword,
} from './credentials.ts'
export type { CreateUserInput, IssueOptions, IssuedCredential, ResolvedCredential } from './credentials.ts'

export {
  all,
  any,
  hasRole,
  hasScope,
  identityOf,
  isActive,
  isAuthenticated,
  isEmailVerified,
  isOwner,
  isStaff,
  isSuperuser,
  ownedBy,
  readOnlyOrAuthenticated,
  userOf,
} from './permissions.ts'
export type { Identity } from './permissions.ts'

export { adminAuthApp, authApp, authenticate, credentialFrom, redirectToLogin, SESSION_COOKIE, UserSerializer } from './app.ts'
export type { AuthAppOptions } from './app.ts'
