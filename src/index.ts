/**
 * @donkeylabs/server
 *
 * Type-safe plugin system for building RPC-style APIs with Bun.
 */

// ==========================================
// Core Plugin System
// ==========================================

export {
  createPlugin,
  PluginManager,
  PluginBuilder,
  ConfiguredPluginBuilder,
  PluginContext,
  type Plugin,
  type ConfiguredPlugin,
  type PluginConfig,
  type PluginFactory,
  type PluginWithConfig,
  type PluginRegistry,
  type PluginHandlerRegistry,
  type PluginMiddlewareRegistry,
  type CoreServices,
  type Register,
  type ClientConfig,
  type EventSchemas,
  type InferService,
  type InferSchema,
  type InferHandlers,
  type InferMiddleware,
  type InferDependencies,
  type InferConfig,
  type InferEvents,
  type InferClientConfig,
  type InferCustomErrors,
} from "./core";

// ==========================================
// Router & Routes
// ==========================================

export {
  createRouter,
  type IRouter,
  type IRouteBuilder,
  type RouteDefinition,
  type RouteMetadata,
  type ServerContext,
  type TypedRouteConfig,
  type RawRouteConfig,
} from "./router";

// ==========================================
// Handlers
// ==========================================

export {
  createHandler,
  Handlers,
  TypedHandler,
  RawHandler,
  type HandlerRuntime,
  type TypedFn,
  type RawFn,
} from "./handlers";

// ==========================================
// Middleware
// ==========================================

export {
  createMiddleware,
  type MiddlewareDefinition,
  type MiddlewareFn,
  type MiddlewareRuntime,
  type NextFn,
} from "./middleware";

// ==========================================
// Server
// ==========================================

export {
  AppServer,
  type ServerConfig,
} from "./server";

// ==========================================
// Core Services
// ==========================================

export {
  // Logger
  createLogger,
  type Logger,
  type LogLevel,
  type LogEntry,
  type LogTransport,
  type LoggerConfig,
  ConsoleTransport,

  // Cache
  createCache,
  type Cache,
  type CacheAdapter,
  type CacheConfig,
  MemoryCacheAdapter,

  // Events
  createEvents,
  type Events,
  type EventHandler,
  type Subscription,
  type EventRecord,
  type EventAdapter,
  type EventsConfig,
  MemoryEventAdapter,

  // Cron
  createCron,
  type Cron,
  type CronTask,
  type CronConfig,

  // Jobs
  createJobs,
  type Jobs,
  type Job,
  type JobStatus,
  type JobHandler,
  type JobAdapter,
  type JobsConfig,
  MemoryJobAdapter,

  // SSE
  createSSE,
  type SSE,
  type SSEClient,
  type SSEConfig,

  // Rate Limiter
  createRateLimiter,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitAdapter,
  type RateLimiterConfig,
  MemoryRateLimitAdapter,
  extractClientIP,
  parseDuration,
  createRateLimitKey,

  // Errors
  createErrors,
  createValidationError,
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  MethodNotAllowedError,
  ConflictError,
  GoneError,
  UnprocessableEntityError,
  TooManyRequestsError,
  InternalServerError,
  NotImplementedError,
  BadGatewayError,
  ServiceUnavailableError,
  GatewayTimeoutError,
  type Errors,
  type ErrorsConfig,
  type ErrorFactory,
  type BaseErrorFactories,
  type ErrorFactories,
  type CustomErrorDefinition,
  type CustomErrorRegistry,
} from "./core/index";

// ==========================================
// Config Helper (for donkeylabs.config.ts)
// ==========================================

export interface DonkeylabsConfig {
  /** Glob patterns for plugin files */
  plugins: string[];
  /** Output directory for generated types (default: ".@donkeylabs/server") */
  outDir?: string;
  /** Client generation configuration */
  client?: {
    /** Output path for generated client */
    output: string;
  };
}

/**
 * Define configuration for donkeylabs.config.ts
 */
export function defineConfig(config: DonkeylabsConfig): DonkeylabsConfig {
  return config;
}
