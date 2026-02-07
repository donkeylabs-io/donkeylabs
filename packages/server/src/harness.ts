import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { PluginManager, type Plugin, type CoreServices } from "./core";
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
  createLogs,
  createHealth,
  KyselyJobAdapter,
  KyselyWorkflowAdapter,
  MemoryAuditAdapter,
  MemoryLogsAdapter,
} from "./core/index";
import { AppServer, type ServerConfig } from "./server";
import type { IRouter, RouteDefinition } from "./router";
import { ApiClientBase, type ApiClientOptions } from "./client/base";

/**
 * Creates a fully functional (in-memory) testing environment for a plugin.
 *
 * @param targetPlugin The plugin you want to test.
 * @param dependencies Any other plugins this plugin needs (e.g. Auth).
 */
export async function createTestHarness(targetPlugin: Plugin, dependencies: Plugin[] = []) {
  // 1. Setup In-Memory DB
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
  });

  // 2. Initialize Core Services with Kysely adapters for in-memory testing
  const logger = createLogger({ level: "warn" }); // Less verbose in tests
  const cache = createCache();
  const events = createEvents();
  const cron = createCron();
  const sse = createSSE();
  const rateLimiter = createRateLimiter();
  const errors = createErrors();

  // Use Kysely adapters with in-memory DB for jobs and workflows
  const jobAdapter = new KyselyJobAdapter(db, { cleanupDays: 0 }); // No cleanup in tests
  const workflowAdapter = new KyselyWorkflowAdapter(db, { cleanupDays: 0 });

  const jobs = createJobs({
    events,
    adapter: jobAdapter,
    persist: false, // Using Kysely adapter
  });

  const workflows = createWorkflows({
    events,
    jobs,
    sse,
    adapter: workflowAdapter,
  });

  const processes = createProcesses({ events, autoRecoverOrphans: false });

  // Use in-memory adapter for audit in tests
  const audit = createAudit({ adapter: new MemoryAuditAdapter() });
  const websocket = createWebSocket();
  const storage = createStorage(); // Uses memory adapter by default
  const logs = createLogs({ adapter: new MemoryLogsAdapter(), events });
  const health = createHealth({ dbCheck: false }); // No DB check in unit tests

  const core: CoreServices = {
    db,
    config: { env: "test" },
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
    logs,
    health,
  };

  const manager = new PluginManager(core);

  // 3. Register Deps + Target
  for (const dep of dependencies) {
    manager.register(dep);
  }
  manager.register(targetPlugin);

  // 4. Run Migrations (Core + Plugin Migrations!)
  await manager.migrate();

  // 5. Init Plugins
  await manager.init();

  return {
    manager,
    db,
    core
  };
}

// =============================================================================
// INTEGRATION TEST HARNESS
// =============================================================================

/**
 * Configuration for the integration test harness.
 */
export interface IntegrationHarnessOptions {
  /** Routers to register with the server */
  routers?: IRouter[];
  /** Plugins to register with the server */
  plugins?: Plugin[];
  /** Starting port range (default: 10000-60000 random) */
  port?: number;
  /** Maximum port retry attempts (default: 10) */
  maxPortAttempts?: number;
  /** Logger level (default: "error" for quiet tests) */
  logLevel?: "debug" | "info" | "warn" | "error";
}

/**
 * A dynamic API client built from router definitions.
 * Provides an untyped but convenient way to call routes.
 */
export class TestApiClient extends ApiClientBase {
  private routeMap: Map<string, RouteDefinition>;

  constructor(baseUrl: string, routers: IRouter[]) {
    super(baseUrl);
    this.routeMap = new Map();
    for (const router of routers) {
      for (const route of router.getRoutes()) {
        this.routeMap.set(route.name, route);
      }
    }
  }

  /**
   * Call any route by name with the given input.
   * Convenient for quick testing without generated types.
   *
   * @example
   * ```ts
   * const user = await client.call("users.create", { name: "Test", email: "test@example.com" });
   * ```
   */
  async call<TOutput = any>(
    route: string,
    input: any = {},
    options?: { version?: string }
  ): Promise<TOutput> {
    const routeDef = this.routeMap.get(route);
    if (!routeDef) {
      throw new Error(`Route not found: ${route}. Available routes: ${[...this.routeMap.keys()].join(", ")}`);
    }

    const versionHeaders: Record<string, string> = {};
    if (options?.version) {
      versionHeaders["X-API-Version"] = options.version;
    }

    // Handle different handler types
    if (routeDef.handler === "typed" || routeDef.handler === "formData") {
      return this.request(route, input, { headers: versionHeaders });
    } else if (routeDef.handler === "stream" || routeDef.handler === "html") {
      const response = await this.rawRequest(route, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...versionHeaders },
        body: JSON.stringify(input),
      });
      return response as any;
    } else if (routeDef.handler === "raw") {
      const response = await this.rawRequest(route, { headers: versionHeaders });
      return response as any;
    }

    return this.request(route, input, { headers: versionHeaders });
  }

  /**
   * Get a raw Response for stream/file routes.
   */
  async stream(route: string, input: any = {}): Promise<Response> {
    return this.rawRequest(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  /**
   * List all available routes.
   */
  routes(): string[] {
    return [...this.routeMap.keys()];
  }
}

/**
 * Result from createIntegrationHarness.
 */
export interface IntegrationHarnessResult {
  /** The running AppServer instance */
  server: AppServer;
  /** Base URL for API calls (e.g., "http://localhost:12345") */
  baseUrl: string;
  /** The actual port the server is running on */
  port: number;
  /** Database instance */
  db: Kysely<any>;
  /** Core services */
  core: CoreServices;
  /** Plugin services (after initialization) */
  plugins: Record<string, any>;
  /**
   * Untyped test client for quick testing.
   * Use `client.call("route.name", input)` to call any route.
   *
   * @example
   * ```ts
   * const user = await harness.client.call("users.create", { name: "Test" });
   * ```
   */
  client: TestApiClient;
  /**
   * Create a typed client using your generated client factory.
   * Pass your `createApiClient` function to get full type safety.
   *
   * @example
   * ```ts
   * import { createApiClient } from "../lib/api";
   * const api = harness.createClient(createApiClient);
   * const user = await api.users.create({ name: "Test" }); // Fully typed!
   * ```
   */
  createClient: <T>(factory: (config: { baseUrl: string }) => T) => T;
  /** Shutdown function - call this in afterAll/afterEach */
  shutdown: () => Promise<void>;
}

// Track used ports across test files running in parallel
const usedPorts = new Set<number>();

/**
 * Get a unique starting port for parallel test execution.
 * Uses random port in range 10000-60000 and tracks to avoid collisions.
 */
function getUniquePort(): number {
  const minPort = 10000;
  const maxPort = 60000;
  let port: number;
  let attempts = 0;
  const maxAttempts = 100;

  do {
    port = minPort + Math.floor(Math.random() * (maxPort - minPort));
    attempts++;
  } while (usedPorts.has(port) && attempts < maxAttempts);

  usedPorts.add(port);
  return port;
}

/**
 * Creates a full integration testing environment with a real HTTP server.
 *
 * Use this when you need to test API routes end-to-end with the generated
 * API client. The server runs in-memory (SQLite :memory:) and uses a random
 * port for parallel test execution.
 *
 * @example
 * ```ts
 * import { describe, it, expect, beforeAll, afterAll } from "bun:test";
 * import { createIntegrationHarness } from "@donkeylabs/server";
 * import { createApiClient } from "../lib/api"; // Your generated client
 * import { usersRouter } from "../server/routes/users";
 * import { usersPlugin } from "../server/plugins/users";
 *
 * describe("Users API", () => {
 *   let harness: Awaited<ReturnType<typeof createIntegrationHarness>>;
 *   let api: ReturnType<typeof createApiClient>;
 *
 *   beforeAll(async () => {
 *     harness = await createIntegrationHarness({
 *       routers: [usersRouter],
 *       plugins: [usersPlugin],
 *     });
 *     api = createApiClient({ baseUrl: harness.baseUrl });
 *   });
 *
 *   afterAll(async () => {
 *     await harness.shutdown();
 *   });
 *
 *   it("should create a user", async () => {
 *     const user = await api.users.create({ name: "Test", email: "test@example.com" });
 *     expect(user.id).toBeDefined();
 *   });
 *
 *   it("should list users", async () => {
 *     const result = await api.users.list({});
 *     expect(result.users.length).toBeGreaterThan(0);
 *   });
 * });
 * ```
 */
export async function createIntegrationHarness(
  options: IntegrationHarnessOptions = {}
): Promise<IntegrationHarnessResult> {
  const {
    routers = [],
    plugins = [],
    port = getUniquePort(),
    maxPortAttempts = 10,
    logLevel = "error",
  } = options;

  // 1. Setup In-Memory DB
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
  });

  // 2. Create server with test configuration
  const server = new AppServer({
    db,
    port,
    maxPortAttempts,
    logger: { level: logLevel },
    // Disable file generation in tests
    generateTypes: undefined,
  });

  // 3. Register plugins
  for (const plugin of plugins) {
    server.registerPlugin(plugin);
  }

  // 4. Register routers
  for (const router of routers) {
    server.use(router);
  }

  // 5. Start the server
  await server.start();

  // Get the actual port (may have changed if initial was in use)
  const actualPort = (server as any).port as number;
  const baseUrl = `http://localhost:${actualPort}`;

  // Track this port as used
  usedPorts.add(actualPort);

  // Get core services and plugins for direct access in tests
  const core = (server as any).coreServices as CoreServices;
  const pluginServices = (server as any).manager.getServices();

  // Create untyped test client
  const client = new TestApiClient(baseUrl, routers);

  // Factory for typed clients
  const createClient = <T>(factory: (config: { baseUrl: string }) => T): T => {
    return factory({ baseUrl });
  };

  // Shutdown function
  const shutdown = async () => {
    await server.shutdown();
    usedPorts.delete(actualPort);
  };

  return {
    server,
    baseUrl,
    port: actualPort,
    db,
    core,
    plugins: pluginServices,
    client,
    createClient,
    shutdown,
  };
}
