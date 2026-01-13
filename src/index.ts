// @donkeylabs/server - Main exports

// Server
export { AppServer, type ServerConfig } from "./server";

// Router
export { createRouter, type Router, type RouteBuilder, type ServerContext, type IRouter, type IRouteBuilder, type IMiddlewareBuilder } from "./router";

// Handlers and Route types
export {
  createHandler,
  createRoute,
  TypedHandler,
  RawHandler,
  type Handler,
  type Route,
  type RouteContract,
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
export function defineConfig(config: {
  plugins: string[];
  outDir: string;
  routes?: string;
  client?: { output: string };
}) {
  return config;
}

// Re-export HttpError for custom error creation
export { HttpError } from "./core/errors";
