// @donkeylabs/server - Main exports

// Server
export { AppServer, type ServerConfig } from "./server";

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
  type EventSchemas,
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
