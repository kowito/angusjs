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

export { createApp, projectRouter, runServer } from './core/project.ts'
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

// Admin
export { AdminSite, adminSite } from './admin/index.ts'
export type { AdminSiteOptions, ModelAdminOptions } from './admin/index.ts'

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
