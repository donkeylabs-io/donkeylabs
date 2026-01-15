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
      // Middleware is resolved and stored in _resolvedMiddleware during plugin init
      const resolved = (plugin as any)._resolvedMiddleware as Record<string, MiddlewareRuntime<any>> | undefined;
      if (resolved && resolved[name]) {
        return resolved[name];
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
   * Get the internal route map for adapter introspection.
   */
  getRouteMap(): Map<string, RouteDefinition> {
    return this.routeMap;
  }

  /**
   * Check if a route name is registered.
   */
  hasRoute(routeName: string): boolean {
    return this.routeMap.has(routeName);
  }

  /**
   * Initialize server without starting HTTP server.
   * Used by adapters (e.g., SvelteKit) that manage their own HTTP server.
   */
  async initialize(): Promise<void> {
    const { logger } = this.coreServices;

    await this.manager.migrate();
    await this.manager.init();

    this.coreServices.cron.start();
    this.coreServices.jobs.start();
    logger.info("Background services started (cron, jobs)");

    for (const router of this.routers) {
      for (const route of router.getRoutes()) {
        if (this.routeMap.has(route.name)) {
          logger.warn(`Duplicate route detected`, { route: route.name });
        }
        this.routeMap.set(route.name, route);
      }
    }
    logger.info(`Loaded ${this.routeMap.size} RPC routes`);
    logger.info("Server initialized (adapter mode)");
  }

  /**
   * Handle a single API request. Used by adapters.
   * Returns null if the route is not found.
   */
  async handleRequest(
    req: Request,
    routeName: string,
    ip: string,
    options?: { corsHeaders?: Record<string, string> }
  ): Promise<Response | null> {
    const { logger } = this.coreServices;
    const corsHeaders = options?.corsHeaders ?? {};

    const route = this.routeMap.get(routeName);
    if (!route) {
      return null;
    }

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

    if (!handler) {
      logger.error("Handler not found", { handler: type, route: routeName });
      return Response.json(
        { error: "HANDLER_NOT_FOUND", message: "Handler not found" },
        { status: 500, headers: corsHeaders }
      );
    }

    // Build context
    const ctx: ServerContext = {
      db: this.coreServices.db,
      plugins: this.manager.getServices(),
      core: this.coreServices,
      errors: this.coreServices.errors,
      config: this.coreServices.config,
      ip,
      requestId: crypto.randomUUID(),
    };

    // Get middleware stack
    const middlewareStack = route.middleware || [];

    // Final handler
    const finalHandler = async () => {
      const response = await handler.execute(req, route, route.handle, ctx);
      // Add CORS headers if provided
      if (Object.keys(corsHeaders).length > 0 && response instanceof Response) {
        const newHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }
      return response;
    };

    try {
      if (middlewareStack.length > 0) {
        return await this.executeMiddlewareChain(req, ctx, middlewareStack, finalHandler);
      } else {
        return await finalHandler();
      }
    } catch (error) {
      if (error instanceof HttpError) {
        logger.warn("HTTP error thrown", {
          route: routeName,
          status: error.status,
          code: error.code,
          message: error.message,
        });
        return Response.json(error.toJSON(), {
          status: error.status,
          headers: corsHeaders,
        });
      }
      throw error;
    }
  }

  /**
   * Call a route directly without HTTP (for SSR).
   * This bypasses the HTTP layer and calls the route handler directly.
   *
   * @param routeName - The route name (e.g., "api.counter.get")
   * @param input - The input data for the route
   * @param ip - Client IP address (optional, defaults to "127.0.0.1")
   * @returns The route handler result
   */
  async callRoute<TOutput = any>(
    routeName: string,
    input: any,
    ip: string = "127.0.0.1"
  ): Promise<TOutput> {
    const { logger } = this.coreServices;

    const route = this.routeMap.get(routeName);
    if (!route) {
      throw new Error(`Route "${routeName}" not found`);
    }

    // Build context
    const ctx: ServerContext = {
      db: this.coreServices.db,
      plugins: this.manager.getServices(),
      core: this.coreServices,
      errors: this.coreServices.errors,
      config: this.coreServices.config,
      ip,
      requestId: crypto.randomUUID(),
    };

    // Validate input if schema exists
    if (route.input) {
      const result = route.input.safeParse(input);
      if (!result.success) {
        throw new HttpError(400, "VALIDATION_ERROR", result.error.message);
      }
      input = result.data;
    }

    // Execute through middleware chain if present
    const middlewareStack = route.middleware || [];

    const finalHandler = async () => {
      return route.handle(input, ctx);
    };

    try {
      if (middlewareStack.length > 0) {
        // Create a fake request for middleware compatibility
        const fakeReq = new Request("http://localhost/" + routeName, {
          method: "POST",
          body: JSON.stringify(input),
        });
        const response = await this.executeMiddlewareChain(
          fakeReq,
          ctx,
          middlewareStack,
          async () => {
            const result = await finalHandler();
            // Return as Response for middleware chain, we'll extract later
            return Response.json(result);
          }
        );
        // Extract result from Response
        if (response instanceof Response) {
          return response.json();
        }
        return response;
      } else {
        return await finalHandler();
      }
    } catch (error) {
      if (error instanceof HttpError) {
        logger.warn("Route error (SSR)", {
          route: routeName,
          status: error.status,
          code: error.code,
        });
        // Re-throw as a proper error for SSR
        throw error;
      }
      throw error;
    }
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

        // Handle SSE endpoint
        if (url.pathname === "/sse" && req.method === "GET") {
          return this.handleSSE(req, ip);
        }

        // We only allow POST for RPC routes
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
              config: this.coreServices.config,
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
   * Handle SSE (Server-Sent Events) connections.
   * Used by both standalone server and adapters.
   */
  handleSSE(req: Request, ip: string): Response {
    const url = new URL(req.url);
    const channels = url.searchParams.get("channels")?.split(",").filter(Boolean) || [];
    const lastEventId = req.headers.get("last-event-id") || undefined;

    const { client, response } = this.coreServices.sse.addClient({ lastEventId });

    // Subscribe to requested channels
    for (const channel of channels) {
      this.coreServices.sse.subscribe(client.id, channel);
    }

    // Clean up when connection closes
    req.signal.addEventListener("abort", () => {
      this.coreServices.sse.removeClient(client.id);
    });

    return response;
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
