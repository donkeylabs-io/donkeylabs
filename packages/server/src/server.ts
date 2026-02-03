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
  createStorage,
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
  type StorageConfig,
} from "./core/index";
import type { AdminConfig } from "./admin";
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
  /** Server port. Can also be set via PORT environment variable. Default: 3000 */
  port?: number;
  /** Maximum port attempts if port is in use. Default: 5 */
  maxPortAttempts?: number;
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
  storage?: StorageConfig;
  /**
   * Admin dashboard configuration.
   * Automatically enabled in dev mode, disabled in production.
   */
  admin?: AdminConfig;
  /**
   * Use legacy separate databases for core services.
   * Set to true to keep using .donkeylabs/*.db files instead of shared DB.
   * @deprecated Migrate to shared DB for better consistency.
   */
  useLegacyCoreDatabases?: boolean;
}

// =============================================================================
// LIFECYCLE HOOK TYPES
// =============================================================================

/**
 * Context passed to lifecycle hooks.
 * Provides access to core services, plugin services, the database, and custom services.
 */
export interface HookContext {
  /** Database instance (Kysely) */
  db: CoreServices["db"];
  /** Core services (logger, cache, events, jobs, etc.) */
  core: CoreServices;
  /** Plugin services (auth, email, permissions, etc.) */
  plugins: Record<string, any>;
  /** Server configuration */
  config: Record<string, any>;
  /** Custom user-registered services */
  services: Record<string, any>;
  /**
   * Register a custom service at runtime (useful in onReady hooks).
   * Services registered this way are immediately available in ctx.services.
   *
   * @example
   * ```ts
   * server.onReady(async (ctx) => {
   *   const nvr = new NVR(ctx.plugins.auth);
   *   await nvr.initialize();
   *   ctx.setService("nvr", nvr);
   * });
   * ```
   */
  setService: <T>(name: string, service: T) => void;
}

/**
 * Handler for onReady hook - called after server is fully initialized
 */
export type OnReadyHandler = (ctx: HookContext) => void | Promise<void>;

/**
 * Handler for onShutdown hook - called when server is shutting down.
 * Receives the same context as onReady for cleanup operations.
 */
export type OnShutdownHandler = (ctx: HookContext) => void | Promise<void>;

/**
 * Handler for onError hook - called when an unhandled error occurs
 */
export type OnErrorHandler = (error: Error, ctx?: HookContext) => void | Promise<void>;

/**
 * Factory function for creating a service.
 * Receives the hook context to access plugins, db, etc.
 */
export type ServiceFactory<T> = (ctx: HookContext) => T | Promise<T>;

/**
 * Service definition created by defineService().
 * Contains the name and factory for type-safe service registration.
 */
export interface ServiceDefinition<N extends string = string, T = any> {
  readonly name: N;
  readonly factory: ServiceFactory<T>;
  /** Type brand for inference - not used at runtime */
  readonly __type?: T;
}

/**
 * Define a custom service for registration with the server.
 * The service will be available as `ctx.services.name` in route handlers.
 * Types are automatically inferred and included in generated types.
 *
 * @example
 * ```ts
 * // services/nvr.ts
 * export const nvrService = defineService("nvr", async (ctx) => {
 *   const nvr = new NVR(ctx.plugins.auth);
 *   await nvr.initialize();
 *   return nvr;
 * });
 *
 * // server/index.ts
 * server.registerService(nvrService);
 *
 * // In routes - ctx.services.nvr is fully typed
 * handle: async (input, ctx) => {
 *   return ctx.services.nvr.getRecordings();
 * }
 * ```
 */
export function defineService<N extends string, T>(
  name: N,
  factory: ServiceFactory<T>
): ServiceDefinition<N, T> {
  return { name, factory };
}

export class AppServer {
  private port: number;
  private maxPortAttempts: number;
  private manager: PluginManager;
  private routers: IRouter[] = [];
  private routeMap: Map<string, RouteDefinition<keyof HandlerRegistry>> = new Map();
  private coreServices: CoreServices;
  private typeGenConfig?: TypeGenerationConfig;

  // Lifecycle hooks
  private readyHandlers: OnReadyHandler[] = [];
  private shutdownHandlers: OnShutdownHandler[] = [];
  private errorHandlers: OnErrorHandler[] = [];
  private isShuttingDown = false;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private generateModeSetup = false;

  // Custom services registry
  private serviceFactories = new Map<string, ServiceFactory<any>>();
  private serviceRegistry: Record<string, any> = {};
  private generateModeTimer?: ReturnType<typeof setTimeout>;

  constructor(options: ServerConfig) {
    // Port priority: explicit config > PORT env var > default 3000
    const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
    this.port = options.port ?? envPort ?? 3000;
    this.maxPortAttempts = options.maxPortAttempts ?? 5;

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
    const storage = createStorage(options.storage);

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
      storage,
    };

    // Resolve circular dependency: workflows needs core for step handlers
    workflows.setCore(this.coreServices);

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

  // ===========================================================================
  // LIFECYCLE HOOKS & SERVICES
  // ===========================================================================

  /**
   * Register a custom service/dependency that will be available in ctx.services.
   * Services are initialized after plugins but before onReady handlers.
   *
   * Prefer using `defineService()` for automatic type generation:
   * @example
   * ```ts
   * // services/nvr.ts
   * export const nvrService = defineService("nvr", async (ctx) => {
   *   const nvr = new NVR(ctx.plugins.auth);
   *   await nvr.initialize();
   *   return nvr;
   * });
   *
   * // server/index.ts
   * server.registerService(nvrService);
   *
   * // In routes - ctx.services.nvr is fully typed!
   * handle: async (input, ctx) => {
   *   return ctx.services.nvr.getRecordings();
   * }
   * ```
   */
  registerService<N extends string, T>(definition: ServiceDefinition<N, T>): this;
  registerService<T>(name: string, factory: ServiceFactory<T>): this;
  registerService<N extends string, T>(
    nameOrDefinition: string | ServiceDefinition<N, T>,
    factory?: ServiceFactory<T>
  ): this {
    if (typeof nameOrDefinition === "string") {
      this.serviceFactories.set(nameOrDefinition, factory!);
    } else {
      this.serviceFactories.set(nameOrDefinition.name, nameOrDefinition.factory);
    }
    return this;
  }

  /**
   * Get the custom services registry.
   */
  getCustomServices(): Record<string, any> {
    return this.serviceRegistry;
  }

  /**
   * Register a handler to be called when the server is fully initialized.
   * Called after all plugins are initialized and background services are started.
   *
   * @example
   * ```ts
   * server.onReady(async (ctx) => {
   *   // Initialize app-specific services
   *   await MyService.initialize(ctx.plugins.auth);
   *
   *   // Set up event listeners
   *   ctx.core.events.on("user.created", handleUserCreated);
   *
   *   ctx.core.logger.info("Application ready!");
   * });
   * ```
   */
  onReady(handler: OnReadyHandler): this {
    this.readyHandlers.push(handler);
    return this;
  }

  /**
   * Register a handler to be called when the server is shutting down.
   * Use this to clean up resources, close connections, etc.
   *
   * @example
   * ```ts
   * server.onShutdown(async (ctx) => {
   *   await ctx.services.redis.quit();
   *   await ctx.services.externalApi.disconnect();
   *   ctx.core.logger.info("Cleanup complete");
   * });
   * ```
   */
  onShutdown(handler: OnShutdownHandler): this {
    this.shutdownHandlers.push(handler);
    return this;
  }

  /**
   * Register a global error handler for unhandled errors.
   * Use this for error reporting, logging, or recovery.
   *
   * @example
   * ```ts
   * server.onError(async (error, ctx) => {
   *   // Report to error tracking service
   *   await Sentry.captureException(error);
   *
   *   ctx?.core.logger.error("Unhandled error", { error: error.message });
   * });
   * ```
   */
  onError(handler: OnErrorHandler): this {
    this.errorHandlers.push(handler);
    return this;
  }

  /**
   * Build the hook context for lifecycle handlers.
   */
  private getHookContext(): HookContext {
    return {
      db: this.coreServices.db,
      core: this.coreServices,
      plugins: this.manager.getServices(),
      config: this.coreServices.config,
      services: this.serviceRegistry,
      setService: <T>(name: string, service: T) => {
        this.serviceRegistry[name] = service;
      },
    };
  }

  /**
   * Initialize all registered services.
   * Called after plugins but before onReady handlers.
   */
  private async initializeServices(): Promise<void> {
    const ctx = this.getHookContext();
    for (const [name, factory] of this.serviceFactories) {
      try {
        this.serviceRegistry[name] = await factory(ctx);
        this.coreServices.logger.debug(`Service initialized: ${name}`);
      } catch (error) {
        this.coreServices.logger.error(`Failed to initialize service: ${name}`, { error });
        await this.handleError(error as Error);
        throw error; // Services are critical, fail startup if they can't init
      }
    }
    if (this.serviceFactories.size > 0) {
      this.coreServices.logger.info(`Initialized ${this.serviceFactories.size} custom service(s)`);
    }
  }

  /**
   * Run all registered ready handlers.
   */
  private async runReadyHandlers(): Promise<void> {
    const ctx = this.getHookContext();
    for (const handler of this.readyHandlers) {
      try {
        await handler(ctx);
      } catch (error) {
        this.coreServices.logger.error("Error in onReady handler", { error });
        await this.handleError(error as Error);
      }
    }
  }

  /**
   * Run all registered shutdown handlers (internal helper).
   */
  private async runShutdownHandlers(): Promise<void> {
    const ctx = this.getHookContext();
    // Run shutdown handlers in reverse order (LIFO)
    for (const handler of [...this.shutdownHandlers].reverse()) {
      try {
        await handler(ctx);
      } catch (error) {
        this.coreServices.logger.error("Error in onShutdown handler", { error });
      }
    }
  }

  /**
   * Handle an error using registered error handlers.
   */
  private async handleError(error: Error): Promise<void> {
    const ctx = this.getHookContext();
    for (const handler of this.errorHandlers) {
      try {
        await handler(error, ctx);
      } catch (handlerError) {
        this.coreServices.logger.error("Error in onError handler", {
          originalError: error.message,
          handlerError: (handlerError as Error).message,
        });
      }
    }
  }

  /**
   * Add a router to handle RPC routes.
   */
  use(router: IRouter): this {
    this.routers.push(router);

    // Handle CLI type generation mode with debounced timer
    // This handles SvelteKit-style entry files that don't call start()
    if (process.env.DONKEYLABS_GENERATE === "1") {
      // Clear any existing timer and set a new one
      // This ensures we wait for all use() calls to complete
      if (this.generateModeTimer) {
        clearTimeout(this.generateModeTimer);
      }
      this.generateModeTimer = setTimeout(() => {
        this.outputRoutesForGeneration();
        process.exit(0);
      }, 100); // 100ms debounce - waits for all route registrations
    }

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
   * @deprecated No longer needed - this is now handled automatically in start() and initialize().
   * You can safely remove any calls to this method.
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
      handler: "typed" | "raw" | "sse" | "stream" | "formData" | "html";
      inputSource?: string;
      outputSource?: string;
      eventsSource?: Record<string, string>;
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

        // Extract SSE event schemas
        let eventsSource: Record<string, string> | undefined;
        if (route.handler === "sse" && route.events) {
          eventsSource = {};
          for (const [eventName, eventSchema] of Object.entries(route.events)) {
            eventsSource[eventName] = zodSchemaToTs(eventSchema as any);
          }
        }

        routes.push({
          name: route.name,
          prefix,
          routeName,
          handler: (route.handler || "typed") as "typed" | "raw" | "sse" | "stream" | "formData" | "html",
          inputSource: route.input ? zodSchemaToTs(route.input) : undefined,
          outputSource: route.output ? zodSchemaToTs(route.output) : undefined,
          eventsSource,
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
      handler: "typed" | "raw" | "sse" | "stream" | "formData" | "html";
      inputSource?: string;
      outputSource?: string;
      eventsSource?: Record<string, string>;
    }>
  ): string {
    const baseImport =
      this.typeGenConfig?.baseImport ??
      'import { ApiClientBase, type ApiClientOptions, type RequestOptions } from "@donkeylabs/server/client";';
    const baseClass = this.typeGenConfig?.baseClass ?? "ApiClientBase";
    const constructorSignature =
      this.typeGenConfig?.constructorSignature ?? "baseUrl: string, options?: ApiClientOptions";
    const constructorBody =
      this.typeGenConfig?.constructorBody ?? "super(baseUrl, options);";
    const defaultFactory = `/**
 * Create an API client instance
 */
export function createApiClient(baseUrl: string, options?: ApiClientOptions) {
  return new ApiClient(baseUrl, options);
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
           const routeNs = toPascalCase(r.routeName);
           const inputType = r.inputSource ?? "Record<string, never>";

           if (r.handler === "typed" || r.handler === "formData") {
             // typed and formData have Input and Output
             const outputType = r.outputSource ?? "void";
             return `${indent}export namespace ${routeNs} {
${indent}  export type Input = Expand<${inputType}>;
${indent}  export type Output = Expand<${outputType}>;
${indent}}
${indent}export type ${routeNs} = { Input: ${routeNs}.Input; Output: ${routeNs}.Output };`;
           } else if (r.handler === "stream" || r.handler === "html") {
             // stream and html have Input only (returns Response/string)
             return `${indent}export namespace ${routeNs} {
${indent}  export type Input = Expand<${inputType}>;
${indent}}
${indent}export type ${routeNs} = { Input: ${routeNs}.Input };`;
           } else if (r.handler === "sse") {
             // Generate Events type from eventsSource
             const eventsEntries = r.eventsSource
               ? Object.entries(r.eventsSource)
                   .map(([eventName, eventType]) => `${indent}    "${eventName}": ${eventType};`)
                   .join("\n")
               : "";
             const eventsType = eventsEntries ? `{\n${eventsEntries}\n${indent}  }` : "Record<string, unknown>";
             return `${indent}export namespace ${routeNs} {
${indent}  export type Input = Expand<${inputType}>;
${indent}  export type Events = Expand<${eventsType}>;
${indent}}
${indent}export type ${routeNs} = { Input: ${routeNs}.Input; Events: ${routeNs}.Events };`;
           }
           // raw handler has no types
           return "";
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
         const pathParts = r.name.split(".");
         const typePath = ["Routes", ...pathParts.slice(0, -1).map(toPascalCase), toPascalCase(r.routeName)];

         if (r.handler === "typed") {
            const inputType = typePath.join(".") + ".Input";
            const outputType = typePath.join(".") + ".Output";
            return `${indent}${methodName}: (input: ${inputType}): Promise<${outputType}> => this.request("${r.name}", input)`;
         } else if (r.handler === "formData") {
            const inputType = typePath.join(".") + ".Input";
            const outputType = typePath.join(".") + ".Output";
            // formData needs to send multipart form data
            return `${indent}${methodName}: (fields: ${inputType}, files?: File[]): Promise<${outputType}> => this.uploadFormData("${r.name}", fields, files)`;
         } else if (r.handler === "stream" || r.handler === "html") {
            // stream and html have validated input but return Response
            const inputType = typePath.join(".") + ".Input";
            return `${indent}${methodName}: (input: ${inputType}): Promise<Response> => this.streamRequest("${r.name}", input)`;
         } else if (r.handler === "sse") {
            const inputType = typePath.join(".") + ".Input";
            const eventsType = typePath.join(".") + ".Events";
            return `${indent}${methodName}: (input: ${inputType}, options?: Omit<SSEOptions, "endpoint" | "channels">): SSESubscription<${eventsType}> => this.connectToSSERoute("${r.name}", input, options)`;
         } else {
            // raw handler
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

    // Check what additional imports we need (SSE types not in base import)
    const hasSSERoutes = routes.some(r => r.handler === "sse");

    const additionalImports: string[] = [];
    if (hasSSERoutes) {
      additionalImports.push('import { type SSEOptions, type SSESubscription } from "@donkeylabs/server/client";');
    }
    const extraImports = additionalImports.length > 0 ? '\n' + additionalImports.join('\n') : "";

    return `// Auto-generated by @donkeylabs/server
// DO NOT EDIT MANUALLY

${baseImport}${extraImports}

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

// Re-export server context for model classes (type-only to avoid bundling server code)
export type { ServerContext as AppContext } from "@donkeylabs/server";

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
    // Handle CLI type generation mode - exit early before any initialization
    if (process.env.DONKEYLABS_GENERATE === "1") {
      this.outputRoutesForGeneration();
      process.exit(0);
    }

    // Guard against multiple initializations using promise-based mutex
    // This prevents race conditions when multiple requests arrive concurrently
    if (this.isInitialized) {
      this.coreServices.logger.debug("Server already initialized, skipping");
      return;
    }
    if (this.initializationPromise) {
      this.coreServices.logger.debug("Server initialization in progress, waiting...");
      await this.initializationPromise;
      return;
    }

    // Create the initialization promise - all concurrent callers will await this same promise
    this.initializationPromise = this.doInitialize();
    await this.initializationPromise;
  }

  /**
   * Internal initialization logic - only called once via the promise mutex
   */
  private async doInitialize(): Promise<void> {
    const { logger } = this.coreServices;

    // Auto-generate types in dev mode if configured
    await this.generateTypes();

    await this.manager.migrate();
    await this.manager.init();

    // Pass plugins to workflows so handlers can access ctx.plugins
    this.coreServices.workflows.setPlugins(this.manager.getServices());

    this.isInitialized = true;

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

    // Initialize custom services, then run onReady handlers
    await this.initializeServices();
    await this.runReadyHandlers();
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
      services: this.serviceRegistry,
      ip,
      requestId: crypto.randomUUID(),
      signal: req.signal,
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
      services: this.serviceRegistry,
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
          return response.json() as Promise<TOutput>;
        }
        return response as TOutput;
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
   * 1. Check for CLI generate mode (DONKEYLABS_GENERATE=1)
   * 2. Run all plugin migrations
   * 3. Initialize all plugins in dependency order
   * 4. Start cron and jobs services
   * 5. Start the HTTP server
   */
  async start() {
    // Handle CLI type generation mode - exit early before any initialization
    if (process.env.DONKEYLABS_GENERATE === "1") {
      this.outputRoutesForGeneration();
      process.exit(0);
    }

    // Guard against multiple initializations using promise-based mutex
    // This prevents race conditions when multiple requests arrive concurrently
    if (!this.isInitialized) {
      if (this.initializationPromise) {
        this.coreServices.logger.debug("Server initialization in progress, waiting...");
        await this.initializationPromise;
      } else {
        // Create the initialization promise - all concurrent callers will await this same promise
        this.initializationPromise = this.doInitialize();
        await this.initializationPromise;
      }
    }

    const { logger } = this.coreServices;

    // 5. Start HTTP server with port retry logic
    const fetchHandler = async (req: Request, server: ReturnType<typeof Bun.serve>) => {
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
        if (req.method === "GET" && !getEnabledHandlers.includes(handlerType as string)) {
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
            services: this.serviceRegistry,
            ip,
            requestId: crypto.randomUUID(),
            signal: req.signal,
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
    };

    // Try to start server, retrying with different ports if port is in use
    let currentPort = this.port;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxPortAttempts; attempt++) {
      try {
        Bun.serve({
          port: currentPort,
          fetch: fetchHandler,
          idleTimeout: 255, // Max value (255 seconds) for SSE/long-lived connections
        });
        // Update the actual port we're running on
        this.port = currentPort;
        logger.info(`Server running at http://localhost:${this.port}`);

        // Initialize custom services, then run onReady handlers
        await this.initializeServices();
        await this.runReadyHandlers();
        return;
      } catch (error) {
        const isPortInUse =
          error instanceof Error &&
          (error.message.includes("EADDRINUSE") ||
            error.message.includes("address already in use") ||
            error.message.includes("port") && error.message.includes("in use"));

        if (isPortInUse && attempt < this.maxPortAttempts - 1) {
          logger.warn(`Port ${currentPort} is already in use, trying port ${currentPort + 1}...`);
          currentPort++;
          lastError = error as Error;
        } else {
          throw error;
        }
      }
    }

    // If we get here, all attempts failed
    throw new Error(
      `Failed to start server after ${this.maxPortAttempts} attempts. ` +
        `Ports ${this.port}-${currentPort} are all in use. ` +
        `Last error: ${lastError?.message}`
    );
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
   * Runs shutdown handlers, stops background services, and closes connections.
   * Safe to call multiple times (idempotent).
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    const { logger } = this.coreServices;
    logger.info("Shutting down server...");

    // Run user shutdown handlers first (in reverse order - LIFO)
    await this.runShutdownHandlers();

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

    // Stop storage (cleanup connections)
    this.coreServices.storage.stop();

    logger.info("Server shutdown complete");
  }

  /**
   * Set up graceful shutdown handlers for process signals.
   * Call this after start() to enable SIGTERM/SIGINT handling.
   *
   * @example
   * ```ts
   * await server.start();
   * server.enableGracefulShutdown();
   * ```
   */
  enableGracefulShutdown(): this {
    const handleSignal = async (signal: string) => {
      this.coreServices.logger.info(`Received ${signal}, initiating graceful shutdown...`);
      await this.shutdown();
      process.exit(0);
    };

    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGINT", () => handleSignal("SIGINT"));

    return this;
  }
}
