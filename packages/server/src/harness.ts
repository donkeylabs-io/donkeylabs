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
  KyselyJobAdapter,
  KyselyWorkflowAdapter,
  MemoryAuditAdapter,
} from "./core/index";

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
