import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PluginManager, type CoreServices, type ConfiguredPlugin } from "./core";
import { type IRouter, type RouteDefinition, type ServerContext, type HandlerRegistry } from "./router";
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
  createWorkflows,
  createProcesses,
  createAudit,
  createWebSocket,
  extractClientIP,
  HttpError,
  KyselyJobAdapter,
  KyselyProcessAdapter,
  KyselyWorkflowAdapter,
  KyselyAuditAdapter,
  type LoggerConfig,
  type CacheConfig,
  type EventsConfig,
  type CronConfig,
  type JobsConfig,
  type SSEConfig,
  type RateLimiterConfig,
  type ErrorsConfig,
  type WorkflowsConfig,
  type ProcessesConfig,
  type AuditConfig,
  type WebSocketConfig,
} from "./core/index";
import { zodSchemaToTs } from "./generator/zod-to-ts";

export interface TypeGenerationConfig {
  /** Output path for generated client types (e.g., "./src/lib/api.ts") */
  output: string;
  /** Custom base import for the client */
  baseImport?: string;
  /** Custom base class name */
  baseClass?: string;
  /** Constructor signature (e.g., "baseUrl: string, options?: ApiClientOptions") */
  constructorSignature?: string;
  /** Constructor body (e.g., "super(baseUrl, options);") */
  constructorBody?: string;
  /** Factory function code (optional, replaces default createApi) */
  factoryFunction?: string;
}

export interface ServerConfig {
  port?: number;
  db: CoreServices["db"];
  config?: Record<string, any>;
  /** Auto-generate client types on startup in dev mode */
  generateTypes?: TypeGenerationConfig;
  // Core service configurations
  logger?: LoggerConfig;
  cache?: CacheConfig;
  events?: EventsConfig;
  cron?: CronConfig;
  jobs?: JobsConfig;
  sse?: SSEConfig;
  rateLimiter?: RateLimiterConfig;
  errors?: ErrorsConfig;
  workflows?: WorkflowsConfig;
  processes?: ProcessesConfig;
  audit?: AuditConfig;
  websocket?: WebSocketConfig;
  /**
   * Use legacy separate databases for core services.
   * Set to true to keep using .donkeylabs/*.db files instead of shared DB.
   * @deprecated Migrate to shared DB for better consistency.
   */
  useLegacyCoreDatabases?: boolean;
}

export class AppServer {
  private port: number;
  private manager: PluginManager;
  private routers: IRouter[] = [];
  private routeMap: Map<string, RouteDefinition<keyof HandlerRegistry>> = new Map();
  private coreServices: CoreServices;
  private typeGenConfig?: TypeGenerationConfig;

  constructor(options: ServerConfig) {
    this.port = options.port ?? 3000;

    // Determine if we should use legacy databases
    const useLegacy = options.useLegacyCoreDatabases ?? false;

    // Initialize core services
    const logger = createLogger(options.logger);
    const cache = createCache(options.cache);
    const events = createEvents(options.events);
    const cron = createCron(options.cron);
    const sse = createSSE(options.sse);
    const rateLimiter = createRateLimiter(options.rateLimiter);
    const errors = createErrors(options.errors);

    // Create adapters - use Kysely by default, or legacy SQLite if requested
    const jobAdapter = options.jobs?.adapter ?? (useLegacy ? undefined : new KyselyJobAdapter(options.db));
    const workflowAdapter = options.workflows?.adapter ?? (useLegacy ? undefined : new KyselyWorkflowAdapter(options.db));
    const auditAdapter = options.audit?.adapter ?? new KyselyAuditAdapter(options.db);

    // Jobs can emit events and use Kysely adapter
    const jobs = createJobs({
      ...options.jobs,
      events,
      adapter: jobAdapter,
      // Disable built-in persistence when using Kysely adapter
      persist: useLegacy ? options.jobs?.persist : false,
    });

    // Workflows with Kysely adapter for persistence
    const workflows = createWorkflows({
      ...options.workflows,
      events,
      jobs,
      sse,
      adapter: workflowAdapter,
    });

    // Processes - still uses its own adapter pattern but can use Kysely
    // Note: ProcessesImpl creates its own SqliteProcessAdapter internally
    // For full Kysely support, we need to modify processes.ts
    const processes = createProcesses({
      ...options.processes,
      events,
    });

    // New services
    const audit = createAudit({
      ...options.audit,
      adapter: auditAdapter,
    });
    const websocket = createWebSocket(options.websocket);

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
      workflows,
      processes,
      audit,
      websocket,
    };

    this.manager = new PluginManager(this.coreServices);
    this.typeGenConfig = options.generateTypes;
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
  getRouteMap(): Map<string, RouteDefinition<keyof HandlerRegistry>> {
    return this.routeMap;
  }

  /**
   * Check if a route name is registered.
   */
  hasRoute(routeName: string): boolean {
    return this.routeMap.has(routeName);
  }

  /**
   * Handle CLI type generation mode.
   * Call this at the end of your server entry file after registering all routes.
   * If DONKEYLABS_GENERATE=1 is set, outputs route metadata and exits.
   * Otherwise, does nothing.
   *
   * @example
   * ```ts
   * server.use(routes);
   * server.handleGenerateMode(); // Add this line at the end
   * ```
   */
  handleGenerateMode(): void {
    if (process.env.DONKEYLABS_GENERATE === "1") {
      this.outputRoutesForGeneration();
      process.exit(0);
    }
  }

  /**
   * Output route metadata as JSON for CLI type generation.
   * Called when DONKEYLABS_GENERATE=1 environment variable is set.
   */
  private outputRoutesForGeneration(): void {
    const routes = [];

    for (const router of this.routers) {
      for (const route of router.getRoutes()) {
        routes.push({
          name: route.name,
          handler: route.handler || "typed",
          inputType: route.input ? zodSchemaToTs(route.input) : undefined,
          outputType: route.output ? zodSchemaToTs(route.output) : undefined,
        });
      }
    }

    console.log(JSON.stringify({ routes }));
  }

  /**
   * Generate client types from registered routes.
   * Called automatically on startup in dev mode if generateTypes config is provided.
   */
  private async generateTypes(): Promise<void> {
    if (!this.typeGenConfig) return;

    const { logger } = this.coreServices;
    const isDev = process.env.NODE_ENV !== "production";

    if (!isDev) {
      logger.debug("Skipping type generation in production mode");
      return;
    }

    // Collect all route metadata
    const routes: Array<{
      name: string;
      prefix: string;
      routeName: string;
      handler: "typed" | "raw";
      inputSource?: string;
      outputSource?: string;
    }> = [];

    const routesWithoutOutput: string[] = [];

    for (const router of this.routers) {
      for (const route of router.getRoutes()) {
        const parts = route.name.split(".");
        const routeName = parts[parts.length - 1] || route.name;
        const prefix = parts.slice(0, -1).join(".");

        // Track typed routes without explicit output schema
        if (route.handler === "typed" && !route.output) {
          routesWithoutOutput.push(route.name);
        }

        routes.push({
          name: route.name,
          prefix,
          routeName,
          handler: (route.handler || "typed") as "typed" | "raw",
          inputSource: route.input ? zodSchemaToTs(route.input) : undefined,
          outputSource: route.output ? zodSchemaToTs(route.output) : undefined,
        });
      }
    }

    // Warn about routes missing output schemas
    if (routesWithoutOutput.length > 0) {
      logger.warn(
        `${routesWithoutOutput.length} route(s) missing output schema - output type will be 'void'`,
        { routes: routesWithoutOutput }
      );
      logger.debug(
        "Tip: Add an 'output' Zod schema to define the return type, or ensure handlers return nothing"
      );
    }

    // Generate the client code
    const code = this.generateClientCode(routes);

    // Write to output file
    const outputDir = dirname(this.typeGenConfig.output);
    await mkdir(outputDir, { recursive: true });
    await writeFile(this.typeGenConfig.output, code);

    logger.info(`Generated API client types`, { output: this.typeGenConfig.output, routes: routes.length });
  }

  /**
   * Generate client code from route metadata.
   */
  private generateClientCode(
    routes: Array<{
      name: string;
      prefix: string;
      routeName: string;
      handler: "typed" | "raw";
      inputSource?: string;
      outputSource?: string;
    }>
  ): string {
    const baseImport =
      this.typeGenConfig?.baseImport ??
      'import { UnifiedApiClientBase, type ClientOptions } from "@donkeylabs/adapter-sveltekit/client";';
    const baseClass = this.typeGenConfig?.baseClass ?? "UnifiedApiClientBase";
    const constructorSignature =
      this.typeGenConfig?.constructorSignature ?? "options?: ClientOptions";
    const constructorBody =
      this.typeGenConfig?.constructorBody ?? "super(options);";
    const defaultFactory = `/**
 * Create an API client instance
 */
export function createApi(options?: ClientOptions) {
  return new ApiClient(options);
}`;
    const factoryFunction = this.typeGenConfig?.factoryFunction ?? defaultFactory;

    // Helper functions
    const toPascalCase = (str: string): string =>
      str
        .split(/[._-]/)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join("");

    const toCamelCase = (str: string): string => {
      const pascal = toPascalCase(str);
      return pascal.charAt(0).toLowerCase() + pascal.slice(1);
    };

    // Common prefix stripping is disabled to respect explicit router nesting (e.g. api.health)
    const routesToProcess = routes;
    const commonPrefix = "";

    // Build recursive tree for nested routes
    type RouteNode = {
      children: Map<string, RouteNode>;
      routes: typeof routes;
    };
    const rootNode: RouteNode = { children: new Map(), routes: [] };

    for (const route of routesToProcess) {
      const parts = route.name.split(".");
      let currentNode = rootNode;
      // Navigate/Build tree
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        if (!currentNode.children.has(part)) {
          currentNode.children.set(part, { children: new Map(), routes: [] });
        }
        currentNode = currentNode.children.get(part)!;
      }
      // Add route to the leaf node (last part is the method name)
      currentNode.routes.push({
        ...route,
        routeName: parts[parts.length - 1]! // precise method name
      });
    }

    // Recursive function to generate Type definitions
    function generateTypeBlock(node: RouteNode, indent: string): string {
      const blocks: string[] = [];
      
      // 1. Valid Input/Output types for routes at this level
      if (node.routes.length > 0) {
        const routeTypes = node.routes.map(r => {
           if (r.handler !== "typed") return "";
           const routeNs = toPascalCase(r.routeName);
           const inputType = r.inputSource ?? "Record<string, never>";
           const outputType = r.outputSource ?? "void";
           return `${indent}export namespace ${routeNs} {
${indent}  export type Input = Expand<${inputType}>;
${indent}  export type Output = Expand<${outputType}>;
${indent}}
${indent}export type ${routeNs} = { Input: ${routeNs}.Input; Output: ${routeNs}.Output };`;
        }).filter(Boolean);
        if (routeTypes.length) blocks.push(routeTypes.join("\n\n"));
      }

      // 2. Nested namespaces
      for (const [name, child] of node.children) {
        const nsName = toPascalCase(name);
        blocks.push(`${indent}export namespace ${nsName} {\n${generateTypeBlock(child, indent + "  ")}\n${indent}}`);
      }
      return blocks.join("\n\n");
    }

    // Recursive function to generate Client Methods
    function generateMethodBlock(node: RouteNode, indent: string, parentPath: string, isTopLevel: boolean): string {
      const blocks: string[] = [];

      // 1. Methods at this level
      const methods = node.routes.map(r => {
         const methodName = toCamelCase(r.routeName);
         // r.name is the full path e.g. "api.v1.users.get"
         
         if (r.handler === "typed") {
            const pathParts = r.name.split(".");
            const typePath = ["Routes", ...pathParts.slice(0, -1).map(toPascalCase), toPascalCase(r.routeName)];
            const inputType = typePath.join(".") + ".Input";
            const outputType = typePath.join(".") + ".Output";
            
            return `${indent}${methodName}: (input: ${inputType}): Promise<${outputType}> => this.request("${r.name}", input)`;
         } else {
            return `${indent}${methodName}: (init?: RequestInit): Promise<Response> => this.rawRequest("${r.name}", init)`;
         }
      });
      if (methods.length) blocks.push(methods.join(",\n"));

      // 2. Nested Objects
      for (const [name, child] of node.children) {
         const camelName = toCamelCase(name); 
         const separator = isTopLevel ? " = " : ": ";
         const terminator = isTopLevel ? ";" : "";
         // For top level, we output `name = { ... };` 
         // For nested, we output `name: { ... }` (comma handled by join)
         
         blocks.push(`${indent}${camelName}${separator}{\n${generateMethodBlock(child, indent + "  ", "", false)}\n${indent}}${terminator}`);
      }
      // Top level blocks are separated by nothing (class members). Nested by comma.
      // Wait, blocks.join needs care.
      // If isTopLevel, join with "\n\n". If nested, join with ",\n".
      return blocks.join(isTopLevel ? "\n\n" : ",\n");
    }

    const typeBlocks: string[] = [generateTypeBlock(rootNode, "  ")];
    // rootNode children are top-level namespaces (api, health) -> Top Level Class Properties
    const methodBlocks: string[] = [generateMethodBlock(rootNode, "  ", "", true)];

    return `// Auto-generated by @donkeylabs/server
// DO NOT EDIT MANUALLY

${baseImport}

// Utility type that forces TypeScript to expand types on hover
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

/**
 * Handler interface for implementing route handlers in model classes.
 * @example
 * class CounterModel implements Handler<Routes.Counter.get> {
 *   handle(input: Routes.Counter.get.Input): Routes.Counter.get.Output {
 *     return { count: 0 };
 *   }
 * }
 */
export interface Handler<T extends { Input: any; Output: any }> {
  handle(input: T["Input"]): T["Output"] | Promise<T["Output"]>;
}

// Re-export server context for model classes
export { type ServerContext as AppContext } from "@donkeylabs/server";

// ============================================
// Route Types
// ============================================

export namespace Routes {
${typeBlocks.join("\n\n") || "  // No typed routes found"}
}

// ============================================
// API Client
// ============================================

export class ApiClient extends ${baseClass} {
  constructor(${constructorSignature}) {
    ${constructorBody}
  }

${methodBlocks.join("\n\n") || "  // No routes defined"}
}

${factoryFunction}
`;
  }

  /**
   * Initialize server without starting HTTP server.
   * Used by adapters (e.g., SvelteKit) that manage their own HTTP server.
   */
  async initialize(): Promise<void> {
    const { logger } = this.coreServices;

    // Auto-generate types in dev mode if configured
    await this.generateTypes();

    await this.manager.migrate();
    await this.manager.init();

    this.coreServices.cron.start();
    this.coreServices.jobs.start();
    await this.coreServices.workflows.resume();
    this.coreServices.processes.start();
    logger.info("Background services started (cron, jobs, workflows, processes)");

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
      const response = await handler.execute(req, route, route.handle as any, ctx);
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

    // Auto-generate types in dev mode if configured
    await this.generateTypes();

    // 1. Run migrations
    await this.manager.migrate();

    // 2. Initialize plugins
    await this.manager.init();

    // 3. Start background services
    this.coreServices.cron.start();
    this.coreServices.jobs.start();
    await this.coreServices.workflows.resume();
    this.coreServices.processes.start();
    logger.info("Background services started (cron, jobs, workflows, processes)");

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

        // Extract action from URL path (e.g., "auth.login")
        const actionName = url.pathname.slice(1);

        const route = this.routeMap.get(actionName);
        if (route) {
          const handlerType = route.handler || "typed";

          // Handlers that accept GET requests (for browser compatibility)
          const getEnabledHandlers = ["stream", "sse", "html", "raw"];

          // Check method based on handler type
          if (req.method === "GET" && !getEnabledHandlers.includes(handlerType)) {
            return new Response("Method Not Allowed", { status: 405 });
          }
          if (req.method !== "GET" && req.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
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
              return await handler.execute(req, route, route.handle as any, ctx);
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

    // Stop WebSocket connections
    this.coreServices.websocket.shutdown();

    // Stop background services
    await this.coreServices.processes.shutdown();
    await this.coreServices.workflows.stop();
    await this.coreServices.jobs.stop();
    await this.coreServices.cron.stop();

    // Stop audit service (cleanup timers)
    this.coreServices.audit.stop();

    logger.info("Server shutdown complete");
  }
}
