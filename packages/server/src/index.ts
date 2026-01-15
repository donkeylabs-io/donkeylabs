// @donkeylabs/server - Main exports

// Server
export { AppServer, type ServerConfig } from "./server";

// Router
export { createRouter, type Router, type RouteBuilder, type ServerContext, type IRouter, type IRouteBuilder, type IMiddlewareBuilder } from "./router";

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
