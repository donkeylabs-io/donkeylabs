import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import Database from "bun:sqlite";
import {
  createEvents,
  createJobs,
  createSSE,
  createWorkflows,
  KyselyJobAdapter,
  KyselyWorkflowAdapter,
} from "../src/core/index";
import { MemoryWorkflowAdapter } from "../src/core/workflows";
import { initProbePlugin, initProbeWorkflow } from "./fixtures/isolated-workflow";

const fixtureUrl = new URL("./fixtures/isolated-workflow.ts", import.meta.url).href;

describe("isolated workflows", () => {
  it("initializes plugins inside the subprocess", async () => {
    const dbPath = join(
      tmpdir(),
      `donkeylabs-isolated-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    const sqlite = new Database(dbPath);
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: sqlite }),
    });

    await createWorkflowTables(db);
    await createJobsTable(db);

    const events = createEvents();
    const sse = createSSE();
    const jobs = createJobs({
      events,
      adapter: new KyselyJobAdapter(db, { cleanupDays: 0 }),
      persist: false,
    });
    const workflows = createWorkflows({
      events,
      jobs,
      sse,
      adapter: new KyselyWorkflowAdapter(db, { cleanupDays: 0 }),
      dbPath,
    });

    workflows.register(initProbeWorkflow, { modulePath: fixtureUrl });
    workflows.setPluginMetadata({
      names: ["initProbe"],
      modulePaths: {
        initProbe: (initProbePlugin as any)._modulePath ?? fixtureUrl,
      },
      configs: {},
      dependencies: {},
      customErrors: {},
    });

    const instanceId = await workflows.start("init-probe-workflow", {});
    const instance = await waitForWorkflowCompletion(workflows, instanceId);

    expect(instance?.status).toBe("completed");
    expect(instance?.output?.initialized).toBe(true);

    await workflows.stop();
    await jobs.stop();
    await db.destroy();
    sqlite.close();
    await unlink(dbPath).catch(() => undefined);
  });

  it("rejects non-serializable plugin configs for isolated workflows", async () => {
    const workflows = createWorkflows({
      adapter: new MemoryWorkflowAdapter(),
      dbPath: "/tmp/donkeylabs-isolated-config-test.db",
    });

    workflows.register(initProbeWorkflow, { modulePath: fixtureUrl });
    workflows.setPluginMetadata({
      names: ["initProbe"],
      modulePaths: {
        initProbe: (initProbePlugin as any)._modulePath ?? fixtureUrl,
      },
      configs: {
        initProbe: { bad: () => "nope" },
      },
      dependencies: {},
      customErrors: {},
    });

    await expect(workflows.start("init-probe-workflow", {})).rejects.toThrow(
      "Non-serializable plugin config"
    );

    await workflows.stop();
  });
});

async function waitForWorkflowCompletion(
  workflows: ReturnType<typeof createWorkflows>,
  instanceId: string,
  timeoutMs: number = 5000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const instance = await workflows.getInstance(instanceId);
    if (instance && instance.status !== "running" && instance.status !== "pending") {
      return instance;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for workflow ${instanceId} to complete`);
}

async function createJobsTable(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("__donkeylabs_jobs__")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("data", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("run_at", "text")
    .addColumn("started_at", "text")
    .addColumn("completed_at", "text")
    .addColumn("result", "text")
    .addColumn("error", "text")
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("max_attempts", "integer", (col) => col.notNull().defaultTo(3))
    .addColumn("external", "integer", (col) => col.defaultTo(0))
    .addColumn("pid", "integer")
    .addColumn("socket_path", "text")
    .addColumn("tcp_port", "integer")
    .addColumn("last_heartbeat", "text")
    .addColumn("process_state", "text")
    .execute();
}

async function createWorkflowTables(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("__donkeylabs_workflow_instances__")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("workflow_name", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("current_step", "text")
    .addColumn("input", "text", (col) => col.notNull())
    .addColumn("output", "text")
    .addColumn("error", "text")
    .addColumn("step_results", "text", (col) => col.notNull().defaultTo("{}"))
    .addColumn("branch_instances", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("started_at", "text")
    .addColumn("completed_at", "text")
    .addColumn("parent_id", "text")
    .addColumn("branch_name", "text")
    .addColumn("metadata", "text")
    .execute();
}
