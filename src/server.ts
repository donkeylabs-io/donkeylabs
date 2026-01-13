import { z } from "zod";
import { PluginManager, type CoreServices, type ConfiguredPlugin } from "./core";
import { type IRouter, type RouteDefinition, type ServerContext } from "./router";
import { Handlers } from "./handlers";
import type { MiddlewareRuntime, MiddlewareDefinition } from "./middleware";
import {
  createLogger,
  createCache,
  createEvents,
  createCron,
  createJobs,
  createSSE,
  createRateLimiter,
  createErrors,
  extractClientIP,
  HttpError,
  type LoggerConfig,
  type CacheConfig,
  type EventsConfig,
  type CronConfig,
  type JobsConfig,
  type SSEConfig,
  type RateLimiterConfig,
  type ErrorsConfig,
} from "./core/index";

export interface ServerConfig {
  port?: number;
  db: CoreServices["db"];
  config?: Record<string, any>;
  // Core service configurations
  logger?: LoggerConfig;
  cache?: CacheConfig;
  events?: EventsConfig;
  cron?: CronConfig;
  jobs?: JobsConfig;
  sse?: SSEConfig;
  rateLimiter?: RateLimiterConfig;
  errors?: ErrorsConfig;
}

export class AppServer {
  private port: number;
  private manager: PluginManager;
  private routers: IRouter[] = [];
  private routeMap: Map<string, RouteDefinition> = new Map();
  private coreServices: CoreServices;

  constructor(options: ServerConfig) {
    this.port = options.port ?? 3000;

    // Initialize core services
    const logger = createLogger(options.logger);
    const cache = createCache(options.cache);
    const events = createEvents(options.events);
    const cron = createCron(options.cron);
    const jobs = createJobs({ ...options.jobs, events }); // Jobs can emit events
    const sse = createSSE(options.sse);
    const rateLimiter = createRateLimiter(options.rateLimiter);
    const errors = createErrors(options.errors);

    this.coreServices = {
      db: options.db,
      config: options.config ?? {},
      logger,
      cache,
      events,
      cron,
      jobs,
      sse,
      rateLimiter,
      errors,
    };

    this.manager = new PluginManager(this.coreServices);
  }

  /**
   * Register a plugin.
   * For plugins with config, call the plugin factory first: registerPlugin(authPlugin({ key: "..." }))
   * Plugins are initialized in dependency order when start() is called.
   */
  registerPlugin(plugin: ConfiguredPlugin): this {
    this.manager.register(plugin);
    return this;
  }

  /**
   * Add a router to handle RPC routes.
   */
  use(router: IRouter): this {
    this.routers.push(router);
    return this;
  }

  /**
   * Get plugin services (for testing or advanced use cases).
   */
  getServices(): any {
    return this.manager.getServices();
  }

  /**
   * Get the database instance.
   */
  getDb(): CoreServices["db"] {
    return this.manager.getCore().db;
  }

  // Resolve middleware runtime from plugins
  private resolveMiddleware(name: string): MiddlewareRuntime<any> | undefined {
    for (const plugin of this.manager.getPlugins()) {
      if (plugin.middleware && plugin.middleware[name]) {
        return plugin.middleware[name] as MiddlewareRuntime<any>;
      }
    }
    return undefined;
  }

  // Execute middleware chain, then call final handler
  private async executeMiddlewareChain(
    req: Request,
    ctx: ServerContext,
    stack: MiddlewareDefinition[],
    finalHandler: () => Promise<Response>
  ): Promise<Response> {
    // Build chain from end to start (last middleware wraps first)
    let next = finalHandler;

    for (let i = stack.length - 1; i >= 0; i--) {
      const mwDef = stack[i];
      if (!mwDef) continue;

      const mwRuntime = this.resolveMiddleware(mwDef.name);

      if (!mwRuntime) {
        console.warn(`[Server] Middleware '${mwDef.name}' not found, skipping`);
        continue;
      }

      const currentNext = next;
      const config = mwDef.config;
      next = () => mwRuntime.execute(req, ctx, currentNext, config);
    }

    return next();
  }

  /**
   * Get core services (for advanced use cases).
   */
  getCore(): CoreServices {
    return this.coreServices;
  }

  /**
   * Start the server.
   * This will:
   * 1. Run all plugin migrations
   * 2. Initialize all plugins in dependency order
   * 3. Start cron and jobs services
   * 4. Start the HTTP server
   */
  async start() {
    const { logger } = this.coreServices;

    // 1. Run migrations
    await this.manager.migrate();

    // 2. Initialize plugins
    await this.manager.init();

    // 3. Start background services
    this.coreServices.cron.start();
    this.coreServices.jobs.start();
    logger.info("Background services started (cron, jobs)");

    // 4. Build route map
    for (const router of this.routers) {
      for (const route of router.getRoutes()) {
        if (this.routeMap.has(route.name)) {
          logger.warn(`Duplicate route detected`, { route: route.name });
        }
        this.routeMap.set(route.name, route);
      }
    }
    logger.info(`Loaded ${this.routeMap.size} RPC routes`);

    // 5. Start HTTP server
    Bun.serve({
      port: this.port,
      fetch: async (req, server) => {
        const url = new URL(req.url);

        // Extract client IP
        const ip = extractClientIP(req, server.requestIP(req)?.address);

        // We only allow POST
        if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

        // Extract action from URL path (e.g., "auth.login")
        const actionName = url.pathname.slice(1);

        const route = this.routeMap.get(actionName);
        if (route) {
          const type = route.handler || "typed";

          // First check core handlers
          let handler = Handlers[type as keyof typeof Handlers];

          // If not found, check plugin handlers
          if (!handler) {
            for (const config of this.manager.getPlugins()) {
              if (config.handlers && config.handlers[type]) {
                handler = config.handlers[type] as any;
                break;
              }
            }
          }

          if (handler) {
            // Build context with core services and IP
            const ctx: ServerContext = {
              db: this.coreServices.db,
              plugins: this.manager.getServices(),
              core: this.coreServices,
              errors: this.coreServices.errors, // Convenience access
              ip,
              requestId: crypto.randomUUID(),
            };

            // Get middleware stack for this route
            const middlewareStack = route.middleware || [];

            // Final handler execution
            const finalHandler = async () => {
              return await handler.execute(req, route, route.handle, ctx);
            };

            // Execute middleware chain, then handler - with HttpError handling
            try {
              if (middlewareStack.length > 0) {
                return await this.executeMiddlewareChain(req, ctx, middlewareStack, finalHandler);
              } else {
                return await finalHandler();
              }
            } catch (error) {
              // Handle HttpError (thrown via ctx.errors.*)
              if (error instanceof HttpError) {
                logger.warn("HTTP error thrown", {
                  route: actionName,
                  status: error.status,
                  code: error.code,
                  message: error.message,
                });
                return Response.json(error.toJSON(), { status: error.status });
              }
              // Re-throw unknown errors
              throw error;
            }
          } else {
            logger.error("Handler not found", { handler: type, route: actionName });
            return new Response("Handler Not Found", { status: 500 });
          }
        }

        return new Response("Not Found", { status: 404 });
      }
    });

    logger.info(`Server running at http://localhost:${this.port}`);
  }

  /**
   * Gracefully shutdown the server.
   * Stops background services and closes SSE connections.
   */
  async shutdown() {
    const { logger } = this.coreServices;
    logger.info("Shutting down server...");

    // Stop SSE (closes all client connections)
    this.coreServices.sse.shutdown();

    // Stop background services
    await this.coreServices.jobs.stop();
    await this.coreServices.cron.stop();

    logger.info("Server shutdown complete");
  }
}
