import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import Database from "bun:sqlite";
import { ProcessClient } from "./process-client";
import { KyselyWorkflowAdapter } from "./workflow-adapter-kysely";
import { KyselyJobAdapter } from "./job-adapter-kysely";
import { SqliteProcessAdapter } from "./process-adapter-sqlite";
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
}

const raw = process.env.DONKEYLABS_WATCHDOG_CONFIG;
if (!raw) {
  throw new Error("Missing DONKEYLABS_WATCHDOG_CONFIG");
}

const config: WatchdogConfig = JSON.parse(raw);
const client = await ProcessClient.connect();

const workflowAdapter = config.workflows?.dbPath
  ? new KyselyWorkflowAdapter(createDb(config.workflows.dbPath, config.sqlitePragmas), {
      cleanupDays: 0,
    })
  : undefined;
const jobAdapter = config.jobs?.dbPath
  ? new KyselyJobAdapter(createDb(config.jobs.dbPath, config.sqlitePragmas), {
      cleanupDays: 0,
    })
  : undefined;
const processAdapter = config.processes?.dbPath
  ? new SqliteProcessAdapter({ path: config.processes.dbPath, cleanupDays: 0 })
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

function createDb(
  dbPath: string,
  pragmas?: { busyTimeout?: number; synchronous?: string; journalMode?: string }
): Kysely<any> {
  const sqlite = new Database(dbPath);
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
