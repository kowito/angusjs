/**
 * angusjs — a batteries-included API framework for Bun.
 *
 * Django's ergonomics (apps, models, migrations, serializers, view sets) on
 * top of ElysiaJS's speed and type inference.
 */

// Core
export { defineApp, appModels } from './core/app.ts'
export type { AngusApp, AppConfig } from './core/app.ts'

export { defineSettings, resolveSettings } from './core/settings.ts'
export type { OpenApiSettings, ResolvedSettings, ServerSettings, Settings } from './core/settings.ts'

export { createApp, mcpIdentity, projectRouter, projectSpec, projectTools, runServer } from './core/project.ts'
export type { BuildOptions, RunningServer } from './core/project.ts'

export { findConfig, loadProject } from './core/config.ts'
export type { LoadedProject } from './core/config.ts'

// Database
export { defineModel, f, Field, Q, QuerySet, Manager } from './db/index.ts'
export type {
  AnyModel,
  Connection,
  DatabaseConfig,
  Dialect,
  FieldSpec,
  Filter,
  Model,
  ModelMeta,
  OrderBy,
  RowOf,
  InsertOf,
  UpdateOf,
} from './db/index.ts'
export { connect, disconnect, getConnection } from './db/connection.ts'
export { atomic, inTransaction, rollbackAfter, Rollback } from './db/transaction.ts'
export { F, FExpression } from './db/expressions.ts'
export { DoesNotExist, IntegrityError, MultipleObjectsReturned } from './db/errors.ts'

// Serializers
export { serializer, fieldSchema, ValidationError } from './serializers/index.ts'
export type {
  ComputedField,
  Payload,
  Representation,
  Serializer,
  SerializerInput,
  SerializerOptions,
  SerializerOutput,
} from './serializers/index.ts'

// Routing
export {
  allowAny,
  either,
  isAuthenticated,
  isStaff,
  modelViewSet,
  not,
  readOnlyOrAuthenticated,
  Router,
  router,
  view,
} from './routing/index.ts'
export type {
  Context,
  Handler,
  ModelViewSetOptions,
  Permission,
  RouteDefinition,
  RouteOptions,
  ViewConfig,
  ViewContext,
  ViewDefinition,
  ViewSetAction,
  ViewSetHooks,
} from './routing/index.ts'

// Elysia plugin surface — incremental adoption
export { angus, mount, openapi as openapiPlugin, mcp as mcpPlugin, admin as adminPlugin } from './plugin.ts'
export type { AngusPluginOptions, McpPluginOptions } from './plugin.ts'
export { errorTranslation, ERROR_CODES, codeForStatus } from './core/errors.ts'
export type { ErrorCode } from './core/errors.ts'

// Admin
export { AdminSite, adminSite } from './admin/index.ts'
export type { AdminSiteOptions, ModelAdminOptions } from './admin/index.ts'

// OpenAPI
export { generateOpenApi, renderDocs } from './openapi/index.ts'
export type { OpenApiDocument, OpenApiOptions } from './openapi/index.ts'

// MCP
export { buildTools, callTool, dispatch, serveStdio, SUPPORTED_VERSIONS } from './mcp/index.ts'
export type { DispatchContext, ServerIdentity, Tool, ToolDefinition } from './mcp/index.ts'

// Application services
export { service, callService, getService, registeredServices } from './services/index.ts'
export type { AnyService, CallOptions, Service, ServiceConfig, ServiceContext } from './services/index.ts'
export { fromService } from './services/route.ts'

// Production: security, throttling, observability, configuration
export { cors, csrf, securityHeaders } from './http/security.ts'
export type { CorsOptions, CsrfOptions, SecurityHeaderOptions } from './http/security.ts'
export { defaultThrottleRules, MemoryThrottleStore, throttle } from './http/throttle.ts'
export type { ThrottleOptions, ThrottleRule, ThrottleStore } from './http/throttle.ts'
export { health, observability, REQUEST_ID_HEADER } from './core/observability.ts'
export type { HealthOptions, ObservabilityOptions, RequestLogFields } from './core/observability.ts'
export { defineEnv, describeEnv, env, ConfigurationError } from './core/env.ts'
export { deployChecks, hasBlockingFindings } from './core/deploy.ts'
export type { Finding, Severity } from './core/deploy.ts'

// HTTP
export {
  APIError,
  BadRequest,
  Conflict,
  MethodNotAllowed,
  NotFound,
  PermissionDenied,
  ServerError,
  Throttled,
  Unauthorized,
  UnprocessableEntity,
} from './http/errors.ts'
export { limitOffsetPagination, noPagination, pageNumberPagination } from './http/pagination.ts'
export type { Page, Paginator } from './http/pagination.ts'

// Re-exported so projects need only one import for schemas.
export { t } from 'elysia'
export type { Static } from 'elysia'
