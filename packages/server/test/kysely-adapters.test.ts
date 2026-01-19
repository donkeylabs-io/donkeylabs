import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import {
  KyselyJobAdapter,
  KyselyProcessAdapter,
  KyselyWorkflowAdapter,
} from "../src/core/index";

// Helper to create in-memory DB with all required tables
async function createTestDb() {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
  });

  // Create jobs table
  await db.schema
    .createTable("__donkeylabs_jobs__")
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

  // Create processes table
  await db.schema
    .createTable("__donkeylabs_processes__")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("pid", "integer")
    .addColumn("socket_path", "text")
    .addColumn("tcp_port", "integer")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("stopped"))
    .addColumn("config", "text", (col) => col.notNull())
    .addColumn("metadata", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("started_at", "text")
    .addColumn("stopped_at", "text")
    .addColumn("last_heartbeat", "text")
    .addColumn("restart_count", "integer", (col) => col.defaultTo(0))
    .addColumn("consecutive_failures", "integer", (col) => col.defaultTo(0))
    .addColumn("error", "text")
    .execute();

  // Create workflow instances table
  await db.schema
    .createTable("__donkeylabs_workflow_instances__")
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
    .execute();

  return db;
}

// ==========================================
// KyselyJobAdapter Tests
// ==========================================
describe("KyselyJobAdapter", () => {
  let db: Kysely<any>;
  let adapter: KyselyJobAdapter;

  beforeEach(async () => {
    db = await createTestDb();
    adapter = new KyselyJobAdapter(db, { cleanupDays: 0 }); // No cleanup in tests
  });

  afterEach(async () => {
    adapter.stop();
    await db.destroy();
  });

  it("should create a job", async () => {
    const job = await adapter.create({
      name: "test-job",
      data: { key: "value" },
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });

    expect(job.id).toMatch(/^job_/);
    expect(job.name).toBe("test-job");
    expect(job.data).toEqual({ key: "value" });
  });

  it("should get a job by id", async () => {
    const created = await adapter.create({
      name: "get-test",
      data: {},
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });

    const job = await adapter.get(created.id);
    expect(job).not.toBeNull();
    expect(job?.id).toBe(created.id);
    expect(job?.name).toBe("get-test");
  });

  it("should return null for non-existent job", async () => {
    const job = await adapter.get("nonexistent");
    expect(job).toBeNull();
  });

  it("should update a job", async () => {
    const created = await adapter.create({
      name: "update-test",
      data: {},
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });

    await adapter.update(created.id, {
      status: "running",
      startedAt: new Date(),
      attempts: 1,
    });

    const job = await adapter.get(created.id);
    expect(job?.status).toBe("running");
    expect(job?.attempts).toBe(1);
    expect(job?.startedAt).toBeInstanceOf(Date);
  });

  it("should delete a job", async () => {
    const created = await adapter.create({
      name: "delete-test",
      data: {},
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });

    const deleted = await adapter.delete(created.id);
    expect(deleted).toBe(true);

    const job = await adapter.get(created.id);
    expect(job).toBeNull();
  });

  it("should get pending jobs", async () => {
    await adapter.create({
      name: "job1",
      data: {},
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });
    await adapter.create({
      name: "job2",
      data: {},
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });
    await adapter.create({
      name: "job3",
      data: {},
      status: "running",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });

    const pending = await adapter.getPending();
    expect(pending).toHaveLength(2);
    expect(pending.every(j => j.status === "pending")).toBe(true);
  });

  it("should get jobs by name", async () => {
    await adapter.create({
      name: "send-email",
      data: { to: "a@b.com" },
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });
    await adapter.create({
      name: "send-email",
      data: { to: "c@d.com" },
      status: "completed",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });
    await adapter.create({
      name: "other-job",
      data: {},
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });

    const emailJobs = await adapter.getByName("send-email");
    expect(emailJobs).toHaveLength(2);

    const pendingEmailJobs = await adapter.getByName("send-email", "pending");
    expect(pendingEmailJobs).toHaveLength(1);
  });

  it("should get scheduled jobs ready for execution", async () => {
    const pastTime = new Date(Date.now() - 10000);
    const futureTime = new Date(Date.now() + 100000);

    await adapter.create({
      name: "ready",
      data: {},
      status: "scheduled",
      createdAt: new Date(),
      runAt: pastTime,
      attempts: 0,
      maxAttempts: 3,
    });
    await adapter.create({
      name: "not-ready",
      data: {},
      status: "scheduled",
      createdAt: new Date(),
      runAt: futureTime,
      attempts: 0,
      maxAttempts: 3,
    });

    const ready = await adapter.getScheduledReady(new Date());
    expect(ready).toHaveLength(1);
    expect(ready[0].name).toBe("ready");
  });

  it("should handle job result serialization", async () => {
    const created = await adapter.create({
      name: "result-test",
      data: {},
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
    });

    await adapter.update(created.id, {
      status: "completed",
      result: { success: true, data: [1, 2, 3] },
    });

    const job = await adapter.get(created.id);
    expect(job?.result).toEqual({ success: true, data: [1, 2, 3] });
  });

  it("should handle external job fields", async () => {
    const created = await adapter.create({
      name: "external-job",
      data: {},
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
      external: true,
    });

    await adapter.update(created.id, {
      pid: 12345,
      socketPath: "/tmp/job.sock",
      tcpPort: 9000,
      lastHeartbeat: new Date(),
      processState: "running",
    });

    const job = await adapter.get(created.id);
    expect(job?.external).toBe(true);
    expect(job?.pid).toBe(12345);
    expect(job?.socketPath).toBe("/tmp/job.sock");
    expect(job?.tcpPort).toBe(9000);
    expect(job?.processState).toBe("running");
  });
});

// ==========================================
// KyselyProcessAdapter Tests
// ==========================================
describe("KyselyProcessAdapter", () => {
  let db: Kysely<any>;
  let adapter: KyselyProcessAdapter;

  beforeEach(async () => {
    db = await createTestDb();
    adapter = new KyselyProcessAdapter(db, { cleanupDays: 0 });
  });

  afterEach(async () => {
    adapter.stop();
    await db.destroy();
  });

  it("should create a process", async () => {
    const process = await adapter.create({
      name: "worker",
      status: "spawning",
      config: { command: "node", args: ["worker.js"] },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    expect(process.id).toMatch(/^proc_/);
    expect(process.name).toBe("worker");
    expect(process.config.command).toBe("node");
  });

  it("should get a process by id", async () => {
    const created = await adapter.create({
      name: "test-proc",
      status: "spawning",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const process = await adapter.get(created.id);
    expect(process).not.toBeNull();
    expect(process?.name).toBe("test-proc");
  });

  it("should return null for non-existent process", async () => {
    const process = await adapter.get("nonexistent");
    expect(process).toBeNull();
  });

  it("should update a process", async () => {
    const created = await adapter.create({
      name: "update-proc",
      status: "spawning",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    await adapter.update(created.id, {
      status: "running",
      pid: 54321,
      startedAt: new Date(),
    });

    const process = await adapter.get(created.id);
    expect(process?.status).toBe("running");
    expect(process?.pid).toBe(54321);
  });

  it("should delete a process", async () => {
    const created = await adapter.create({
      name: "delete-proc",
      status: "stopped",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const deleted = await adapter.delete(created.id);
    expect(deleted).toBe(true);

    const process = await adapter.get(created.id);
    expect(process).toBeNull();
  });

  it("should get processes by name", async () => {
    await adapter.create({
      name: "worker",
      status: "running",
      config: { command: "worker" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });
    await adapter.create({
      name: "worker",
      status: "stopped",
      config: { command: "worker" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });
    await adapter.create({
      name: "other",
      status: "running",
      config: { command: "other" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const workers = await adapter.getByName("worker");
    expect(workers).toHaveLength(2);
  });

  it("should get running processes", async () => {
    await adapter.create({
      name: "proc1",
      status: "running",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });
    await adapter.create({
      name: "proc2",
      status: "spawning",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });
    await adapter.create({
      name: "proc3",
      status: "stopped",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const running = await adapter.getRunning();
    expect(running).toHaveLength(2);
  });

  it("should get orphaned processes", async () => {
    await adapter.create({
      name: "proc1",
      status: "running",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });
    await adapter.create({
      name: "proc2",
      status: "orphaned",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });
    await adapter.create({
      name: "proc3",
      status: "stopped",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const orphaned = await adapter.getOrphaned();
    expect(orphaned).toHaveLength(2); // running and orphaned
  });

  it("should handle metadata serialization", async () => {
    const created = await adapter.create({
      name: "meta-proc",
      status: "running",
      config: { command: "test" },
      metadata: { env: "production", version: "1.0.0" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const process = await adapter.get(created.id);
    expect(process?.metadata).toEqual({ env: "production", version: "1.0.0" });
  });
});

// ==========================================
// KyselyWorkflowAdapter Tests
// ==========================================
describe("KyselyWorkflowAdapter", () => {
  let db: Kysely<any>;
  let adapter: KyselyWorkflowAdapter;

  beforeEach(async () => {
    db = await createTestDb();
    adapter = new KyselyWorkflowAdapter(db, { cleanupDays: 0 });
  });

  afterEach(async () => {
    adapter.stop();
    await db.destroy();
  });

  it("should create a workflow instance", async () => {
    const instance = await adapter.createInstance({
      workflowName: "order-processing",
      status: "pending",
      input: { orderId: "123" },
      stepResults: {},
      createdAt: new Date(),
    });

    expect(instance.id).toMatch(/^wf_/);
    expect(instance.workflowName).toBe("order-processing");
    expect(instance.input).toEqual({ orderId: "123" });
  });

  it("should get an instance by id", async () => {
    const created = await adapter.createInstance({
      workflowName: "test-workflow",
      status: "pending",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });

    const instance = await adapter.getInstance(created.id);
    expect(instance).not.toBeNull();
    expect(instance?.workflowName).toBe("test-workflow");
  });

  it("should return null for non-existent instance", async () => {
    const instance = await adapter.getInstance("nonexistent");
    expect(instance).toBeNull();
  });

  it("should update an instance", async () => {
    const created = await adapter.createInstance({
      workflowName: "update-test",
      status: "pending",
      input: { data: "initial" },
      stepResults: {},
      createdAt: new Date(),
    });

    await adapter.updateInstance(created.id, {
      status: "running",
      currentStep: "step-1",
      startedAt: new Date(),
    });

    const instance = await adapter.getInstance(created.id);
    expect(instance?.status).toBe("running");
    expect(instance?.currentStep).toBe("step-1");
  });

  it("should delete an instance", async () => {
    const created = await adapter.createInstance({
      workflowName: "delete-test",
      status: "completed",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });

    const deleted = await adapter.deleteInstance(created.id);
    expect(deleted).toBe(true);

    const instance = await adapter.getInstance(created.id);
    expect(instance).toBeNull();
  });

  it("should get instances by workflow name", async () => {
    await adapter.createInstance({
      workflowName: "order-processing",
      status: "pending",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });
    await adapter.createInstance({
      workflowName: "order-processing",
      status: "completed",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });
    await adapter.createInstance({
      workflowName: "other-workflow",
      status: "pending",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });

    const orderInstances = await adapter.getInstancesByWorkflow("order-processing");
    expect(orderInstances).toHaveLength(2);

    const pendingOrders = await adapter.getInstancesByWorkflow("order-processing", "pending");
    expect(pendingOrders).toHaveLength(1);
  });

  it("should get running instances", async () => {
    await adapter.createInstance({
      workflowName: "wf1",
      status: "running",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });
    await adapter.createInstance({
      workflowName: "wf2",
      status: "pending",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });
    await adapter.createInstance({
      workflowName: "wf3",
      status: "running",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });

    const running = await adapter.getRunningInstances();
    expect(running).toHaveLength(2);
  });

  it("should handle step results serialization", async () => {
    const created = await adapter.createInstance({
      workflowName: "step-test",
      status: "running",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });

    const stepResults = {
      "step-1": {
        stepName: "step-1",
        status: "completed" as const,
        input: { x: 1 },
        output: { y: 2 },
        startedAt: new Date(),
        completedAt: new Date(),
        attempts: 1,
      },
    };

    await adapter.updateInstance(created.id, { stepResults });

    const instance = await adapter.getInstance(created.id);
    expect(instance?.stepResults["step-1"].status).toBe("completed");
    expect(instance?.stepResults["step-1"].output).toEqual({ y: 2 });
  });

  it("should handle output serialization", async () => {
    const created = await adapter.createInstance({
      workflowName: "output-test",
      status: "running",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });

    await adapter.updateInstance(created.id, {
      status: "completed",
      output: { result: "success", data: [1, 2, 3] },
      completedAt: new Date(),
    });

    const instance = await adapter.getInstance(created.id);
    expect(instance?.output).toEqual({ result: "success", data: [1, 2, 3] });
  });

  it("should handle branch instances", async () => {
    const created = await adapter.createInstance({
      workflowName: "branch-test",
      status: "running",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });

    await adapter.updateInstance(created.id, {
      branchInstances: { "branch-a": "wf_123", "branch-b": "wf_456" },
    });

    const instance = await adapter.getInstance(created.id);
    expect(instance?.branchInstances).toEqual({ "branch-a": "wf_123", "branch-b": "wf_456" });
  });

  it("should handle parent workflow references", async () => {
    const parent = await adapter.createInstance({
      workflowName: "parent-workflow",
      status: "running",
      input: {},
      stepResults: {},
      createdAt: new Date(),
    });

    const child = await adapter.createInstance({
      workflowName: "child-workflow",
      status: "pending",
      input: {},
      stepResults: {},
      createdAt: new Date(),
      parentId: parent.id,
      branchName: "parallel-branch",
    });

    const instance = await adapter.getInstance(child.id);
    expect(instance?.parentId).toBe(parent.id);
    expect(instance?.branchName).toBe("parallel-branch");
  });
});
