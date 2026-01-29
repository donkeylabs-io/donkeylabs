// @donkeylabs/server - Main exports

// Server
export {
  AppServer,
  type ServerConfig,
  // Lifecycle hooks
  type HookContext,
  type OnReadyHandler,
  type OnShutdownHandler,
  type OnErrorHandler,
  // Custom services
  defineService,
  type ServiceDefinition,
  type ServiceFactory,
} from "./server";

// Router
export {
  createRouter,
  defineRoute,
  type Router,
  type RouteBuilder,
  type ServerContext,
  type IRouter,
  type IRouteBuilder,
  type IMiddlewareBuilder,
  type TypedRouteConfig,
} from "./router";

// Handlers
export {
  createHandler,
  TypedHandler,
  RawHandler,
  Handlers,
  type HandlerRuntime,
  type TypedFn,
  type TypedHandler as TypedHandlerType,
  type RawFn,
  type RawHandler as RawHandlerType,
} from "./handlers";

// Core Plugin System
export {
  createPlugin,
  PluginManager,
  PluginContext,
  // Events
  defineEvents,
  type EventRegistry,
  type EventSchemas,
  type PluginRegistry,
  type PluginHandlerRegistry,
  type PluginMiddlewareRegistry,
  type CoreServices,
  type GlobalContext,
  type Register,
  type InferService,
  type InferSchema,
  type InferHandlers,
  type InferMiddleware,
  type InferDependencies,
  // Custom services registry
  type ServiceRegistry,
} from "./core";

// Middleware
export { createMiddleware } from "./middleware";

// Config helper
export interface DonkeylabsConfig {
  /** Glob patterns for plugin files */
  plugins: string[];
  /** Output directory for generated types */
  outDir: string;
  /** Server entry file for route extraction */
  entry?: string;
  /** Route files pattern */
  routes?: string;
  /** Client generation options */
  client?: { output: string };
  /** Adapter package for framework-specific generation (e.g., "@donkeylabs/adapter-sveltekit") */
  adapter?: string;
}

export function defineConfig(config: DonkeylabsConfig): DonkeylabsConfig {
  return config;
}

// Re-export HttpError for custom error creation
export { HttpError } from "./core/errors";

// Workflows (step functions)
export {
  workflow,
  WorkflowBuilder,
  type WorkflowDefinition,
  type WorkflowInstance,
  type WorkflowStatus,
  type WorkflowContext,
  type Workflows,
} from "./core/workflows";

// Processes (managed subprocesses)
export {
  type Processes,
  type ProcessDefinition,
  type ProcessStats,
  type ManagedProcess,
  type ProcessConfig,
  type ProcessStatus,
  type SpawnOptions,
} from "./core/processes";

// Admin Dashboard
export {
  type AdminConfig,
  isAdminEnabled,
  createAdmin,
  createAdminRouter,
} from "./admin";

// Test Harness - for plugin and integration testing
export {
  createTestHarness,
  createIntegrationHarness,
  TestApiClient,
  type IntegrationHarnessOptions,
  type IntegrationHarnessResult,
} from "./harness";
