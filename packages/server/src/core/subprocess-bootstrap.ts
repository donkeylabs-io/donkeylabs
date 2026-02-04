import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import Database from "bun:sqlite";
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
  KyselyJobAdapter,
  KyselyWorkflowAdapter,
  MemoryAuditAdapter,
  MemoryLogsAdapter,
} from "./index";
import { PluginManager, type CoreServices, type ConfiguredPlugin } from "../core";

export interface SubprocessPluginMetadata {
  names: string[];
  modulePaths: Record<string, string>;
  configs: Record<string, any>;
}

export interface SubprocessBootstrapOptions {
  dbPath: string;
  coreConfig?: Record<string, any>;
  pluginMetadata: SubprocessPluginMetadata;
  startServices?: {
    cron?: boolean;
    jobs?: boolean;
    workflows?: boolean;
    processes?: boolean;
  };
}

export interface SubprocessBootstrapResult {
  core: CoreServices;
  manager: PluginManager;
  db: Kysely<any>;
  workflowAdapter: KyselyWorkflowAdapter;
  cleanup: () => Promise<void>;
}

export async function bootstrapSubprocess(
  options: SubprocessBootstrapOptions
): Promise<SubprocessBootstrapResult> {
  const sqlite = new Database(options.dbPath);
  sqlite.run("PRAGMA busy_timeout = 5000");

  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: sqlite }),
  });

  const cache = createCache();
  const events = createEvents();
  const sse = createSSE();
  const rateLimiter = createRateLimiter();
  const errors = createErrors();

  const logs = createLogs({ adapter: new MemoryLogsAdapter(), events });
  const logger = createLogger();

  const cron = createCron({ logger, events });

  const jobAdapter = new KyselyJobAdapter(db, { cleanupDays: 0 });
  const workflowAdapter = new KyselyWorkflowAdapter(db, { cleanupDays: 0 });
  const auditAdapter = new MemoryAuditAdapter();

  const jobs = createJobs({
    events,
    logger,
    adapter: jobAdapter,
    persist: false,
  });

  const workflows = createWorkflows({
    events,
    jobs,
    sse,
    adapter: workflowAdapter,
  });

  const processes = createProcesses({ events, autoRecoverOrphans: false });
  const audit = createAudit({ adapter: auditAdapter });
  const websocket = createWebSocket();
  const storage = createStorage();

  const core: CoreServices = {
    db,
    config: options.coreConfig ?? {},
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
  };

  workflows.setCore(core);

  const manager = new PluginManager(core);
  const plugins = await loadConfiguredPlugins(options.pluginMetadata);

  for (const plugin of plugins) {
    manager.register(plugin);
  }

  await manager.init();
  workflows.setPlugins(manager.getServices());

  if (options.startServices?.cron) {
    core.cron.start();
  }
  if (options.startServices?.jobs) {
    core.jobs.start();
  }
  if (options.startServices?.workflows) {
    await core.workflows.resolveDbPath();
    await core.workflows.resume();
  }
  if (options.startServices?.processes) {
    core.processes.start();
  }

  const cleanup = async () => {
    await core.cron.stop();
    await core.jobs.stop();
    await core.workflows.stop();
    await core.processes.shutdown();

    if (typeof (logs as any).stop === "function") {
      (logs as any).stop();
    }

    if (typeof (audit as any).stop === "function") {
      (audit as any).stop();
    }

    await db.destroy();
    sqlite.close();
  };

  return { core, manager, db, workflowAdapter, cleanup };
}

async function loadConfiguredPlugins(
  metadata: SubprocessPluginMetadata
): Promise<ConfiguredPlugin[]> {
  const plugins: ConfiguredPlugin[] = [];

  for (const name of metadata.names) {
    const modulePath = metadata.modulePaths[name];
    if (!modulePath) {
      throw new Error(`Missing module path for plugin "${name}"`);
    }

    const module = await import(modulePath);
    const config = metadata.configs?.[name];
    const plugin = findPluginDefinition(module, name, config);

    if (!plugin) {
      throw new Error(
        `Plugin "${name}" not found in module ${modulePath}. ` +
          `Ensure the plugin is exported and its config is serializable.`
      );
    }

    plugins.push(plugin);
  }

  return plugins;
}

function findPluginDefinition(
  mod: any,
  pluginName: string,
  boundConfig?: any
): ConfiguredPlugin | null {
  for (const key of Object.keys(mod)) {
    const exported = mod[key];
    const direct = resolvePluginDefinition(exported, pluginName, boundConfig);
    if (direct) return direct;
  }

  if (mod.default) {
    const direct = resolvePluginDefinition(mod.default, pluginName, boundConfig);
    if (direct) return direct;
  }

  return null;
}

function resolvePluginDefinition(
  exported: any,
  pluginName: string,
  boundConfig?: any
): ConfiguredPlugin | null {
  if (!exported) return null;

  if (
    typeof exported === "object" &&
    exported.name === pluginName &&
    typeof exported.service === "function"
  ) {
    return exported as ConfiguredPlugin;
  }

  if (typeof exported === "function" && boundConfig !== undefined) {
    try {
      const result = exported(boundConfig);
      if (
        result &&
        typeof result === "object" &&
        result.name === pluginName &&
        typeof result.service === "function"
      ) {
        return result as ConfiguredPlugin;
      }
    } catch {
      return null;
    }
  }

  return null;
}
