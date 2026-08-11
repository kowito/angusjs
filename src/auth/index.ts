export { authModels, Session, SocialAccount, User, VerificationToken } from './models.ts'
export type { SessionRow, SocialAccountRow, UserRow, VerificationTokenRow } from './models.ts'

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

export { decodeJwt, JwtError, signJwt, verifyJwt, verifyJwtWithJwks } from './jwt.ts'
export type { Algorithm, Jwk, JwtClaims, SignOptions, VerifyOptions } from './jwt.ts'

export {
  assertProviderConfig,
  beginAuthorization,
  exchangeCode,
  fetchJwks,
  fetchProfile,
  OAuthError,
  openFlowState,
  pkceChallenge,
  providers,
  randomToken,
  safeRedirect,
  sealFlowState,
  stateMatches,
} from './oauth.ts'
export type { AuthorizationRequest, FlowState, ProviderConfig, ProviderProfile, TokenResponse } from './oauth.ts'

export { linkedProviders, resolveSocialUser, SocialLoginError, unlinkProvider } from './social.ts'
export type { LinkPolicy, SocialLoginOptions, SocialLoginResult } from './social.ts'

export { socialAuthRoutes } from './social-app.ts'
export type { SocialAuthOptions } from './social-app.ts'
