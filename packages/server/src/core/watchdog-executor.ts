import { Kysely, PostgresDialect, MysqlDialect } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import Database from "bun:sqlite";
import { ProcessClient } from "./process-client";
import { KyselyWorkflowAdapter } from "./workflow-adapter-kysely";
import { KyselyJobAdapter } from "./job-adapter-kysely";
import { SqliteProcessAdapter } from "./process-adapter-sqlite";
import { KyselyProcessAdapter } from "./process-adapter-kysely";
import { WatchdogRunner, type WatchdogRunnerConfig } from "./watchdog-runner";

interface WatchdogConfig extends WatchdogRunnerConfig {
  intervalMs: number;
  workflows?: { dbPath?: string };
  jobs?: { dbPath?: string };
  processes?: { dbPath?: string };
  sqlitePragmas?: {
    busyTimeout?: number;
    synchronous?: "OFF" | "NORMAL" | "FULL" | "EXTRA";
    journalMode?: "DELETE" | "TRUNCATE" | "PERSIST" | "MEMORY" | "WAL" | "OFF";
  };
  database?: {
    type: "sqlite" | "postgres" | "mysql";
    connectionString: string;
  };
}

const raw = process.env.DONKEYLABS_WATCHDOG_CONFIG;
if (!raw) {
  throw new Error("Missing DONKEYLABS_WATCHDOG_CONFIG");
}

const config: WatchdogConfig = JSON.parse(raw);
const client = await ProcessClient.connect();

const workflowAdapter = config.workflows?.dbPath || config.database
  ? new KyselyWorkflowAdapter(await createDb(config.workflows?.dbPath, config), {
      cleanupDays: 0,
    })
  : undefined;
const jobAdapter = config.jobs?.dbPath || config.database
  ? new KyselyJobAdapter(await createDb(config.jobs?.dbPath, config), {
      cleanupDays: 0,
    })
  : undefined;
const processAdapter = config.processes?.dbPath
  ? new SqliteProcessAdapter({ path: config.processes.dbPath, cleanupDays: 0 })
  : config.database
    ? new KyselyProcessAdapter(await createDb(undefined, config))
    : undefined;

const runner = new WatchdogRunner(config, {
  workflowsAdapter: workflowAdapter,
  jobsAdapter: jobAdapter,
  processesAdapter: processAdapter,
  emit: async (event, data) => {
    await client.emit(event, data);
  },
});

const interval = Math.max(1000, config.intervalMs);
const timer = setInterval(() => {
  runner.runOnce().catch(() => undefined);
}, interval);

process.on("SIGTERM", async () => {
  clearInterval(timer);
  client.disconnect();
});

async function createDb(
  dbPath: string | undefined,
  config: WatchdogConfig
): Promise<Kysely<any>> {
  const dbConfig = config.database;

  if (!dbConfig || dbConfig.type === "sqlite") {
    const sqlitePath = dbConfig?.connectionString ?? dbPath;
    if (!sqlitePath) {
      throw new Error("SQLite dbPath or connectionString is required for watchdog");
    }
    const sqlite = new Database(sqlitePath);
    const pragmas = config.sqlitePragmas;
    const busyTimeout = pragmas?.busyTimeout ?? 5000;
    sqlite.run(`PRAGMA busy_timeout = ${busyTimeout}`);
    if (pragmas?.journalMode) {
      sqlite.run(`PRAGMA journal_mode = ${pragmas.journalMode}`);
    }
    if (pragmas?.synchronous) {
      sqlite.run(`PRAGMA synchronous = ${pragmas.synchronous}`);
    }

    return new Kysely<any>({
      dialect: new BunSqliteDialect({ database: sqlite }),
    });
  }

  if (dbConfig.type === "postgres") {
    // @ts-ignore optional dependency
    const { Pool: PGPool } = await import("pg");
    return new Kysely<any>({
      dialect: new PostgresDialect({
        pool: new PGPool({ connectionString: dbConfig.connectionString }),
      }),
    });
  }

  if (dbConfig.type === "mysql") {
    // @ts-ignore optional dependency
    const { createPool: createMySQLPool } = await import("mysql2");
    return new Kysely<any>({
      dialect: new MysqlDialect({
        pool: createMySQLPool(dbConfig.connectionString),
      }),
    });
  }

  throw new Error(`Unsupported database type: ${dbConfig.type}`);
}
