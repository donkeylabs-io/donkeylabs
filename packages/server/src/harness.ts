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

  // 2. Initialize Core Services
  const logger = createLogger({ level: "warn" }); // Less verbose in tests
  const cache = createCache();
  const events = createEvents();
  const cron = createCron();
  const jobs = createJobs({ events });
  const sse = createSSE();
  const rateLimiter = createRateLimiter();
  const errors = createErrors();
  const workflows = createWorkflows({ events, jobs, sse });
  const processes = createProcesses({ events, autoRecoverOrphans: false });

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
  };

  const manager = new PluginManager(core);

  // 3. Register Deps + Target
  for (const dep of dependencies) {
    manager.register(dep);
  }
  manager.register(targetPlugin);

  // 4. Run Migrations (Real Kysely Migrations!)
  await manager.migrate();

  // 5. Init Plugins
  await manager.init();

  return {
    manager,
    db,
    core
  };
}
