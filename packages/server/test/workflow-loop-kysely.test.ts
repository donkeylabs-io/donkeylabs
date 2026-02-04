import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import Database from "bun:sqlite";
import { createEvents, MemoryEventAdapter } from "../src/core/events";
import { createWorkflows, workflow } from "../src/core/workflows";
import { KyselyWorkflowAdapter } from "../src/core/workflow-adapter-kysely";

describe("workflow loop step (kysely)", () => {
  it("persists loop counters in sqlite adapter", async () => {
    const dbPath = join(
      tmpdir(),
      `donkeylabs-loop-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    const sqlite = new Database(dbPath);
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: sqlite }),
    });

    await createWorkflowTable(db);

    const events = createEvents({ adapter: new MemoryEventAdapter() });
    const adapter = new KyselyWorkflowAdapter(db, { cleanupDays: 0 });
    const workflows = createWorkflows({ adapter, events });

    let count = 0;
    const loopWorkflow = workflow("loop-persist")
      .isolated(false)
      .task("increment", {
        handler: async () => {
          count += 1;
          return { count };
        },
      })
      .loop("repeat", {
        condition: (ctx) => ctx.steps.increment.count < 3,
        target: "increment",
      })
      .build();

    workflows.register(loopWorkflow);

    const instanceId = await workflows.start("loop-persist", {});
    await waitForWorkflowCompletion(workflows, instanceId);

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.stepResults.repeat.loopCount).toBe(2);

    await workflows.stop();
    await db.destroy();
    sqlite.close();
    await unlink(dbPath).catch(() => undefined);
  });
});

async function waitForWorkflowCompletion(
  workflows: ReturnType<typeof createWorkflows>,
  instanceId: string,
  timeoutMs: number = 2000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const instance = await workflows.getInstance(instanceId);
    if (instance && instance.status !== "running" && instance.status !== "pending") {
      return instance;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for workflow ${instanceId} to complete`);
}

async function createWorkflowTable(db: Kysely<any>): Promise<void> {
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
