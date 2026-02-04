import { describe, it, expect } from "bun:test";
import {
  createEvents,
  MemoryEventAdapter,
  createLogs,
  MemoryLogsAdapter,
  createLogger,
  PersistentTransport,
  createWorkflows,
  MemoryWorkflowAdapter,
  workflow,
  createJobs,
  MemoryJobAdapter,
  createCron,
} from "../src/core/index";
import type { CoreServices } from "../src/core";

describe("service-scoped logs and events", () => {
  it("emits workflow logs and custom events", async () => {
    const events = createEvents({ adapter: new MemoryEventAdapter() });
    const logs = createLogs({
      adapter: new MemoryLogsAdapter(),
      events,
      flushInterval: 5,
      maxBufferSize: 1,
      minLevel: "debug",
    });
    const logger = createLogger({
      transports: [new PersistentTransport(logs, { minLevel: "debug" })],
    });

    const workflows = createWorkflows({
      adapter: new MemoryWorkflowAdapter(),
      events,
    });

    workflows.setCore({ logger, events, logs } as CoreServices);
    workflows.setPlugins({});

    const wf = workflow("log-workflow")
      .task("step", {
        handler: async (_input, ctx) => {
          ctx.log?.("info", "workflow log", { step: "step" });
          await ctx.emit?.("custom", { ok: true });
          return { ok: true };
        },
        end: true,
      })
      .build();

    workflows.register(wf);

    const instanceId = await workflows.start("log-workflow", {});
    await waitForWorkflowCompletion(workflows, instanceId);

    await logs.flush();

    const logHistory = await events.getHistory(`log.workflow.${instanceId}`, 10);
    expect(logHistory.length).toBeGreaterThan(0);

    const customHistory = await events.getHistory(`workflow.${instanceId}.event`, 10);
    expect(customHistory[0]?.data?.event).toBe("custom");

    await workflows.stop();
    logs.stop();
  });

  it("emits job logs and custom events", async () => {
    const events = createEvents({ adapter: new MemoryEventAdapter() });
    const logs = createLogs({
      adapter: new MemoryLogsAdapter(),
      events,
      flushInterval: 5,
      maxBufferSize: 1,
      minLevel: "debug",
    });
    const logger = createLogger({
      transports: [new PersistentTransport(logs, { minLevel: "debug" })],
    });

    const jobs = createJobs({
      adapter: new MemoryJobAdapter(),
      events,
      logger,
      persist: false,
    });

    jobs.register("custom-job", async (_data, ctx) => {
      ctx?.log?.("info", "job log");
      await ctx?.emit?.("custom", { ok: true });
      return { ok: true };
    });

    jobs.start();
    const jobId = await jobs.enqueue("custom-job", {});
    await waitForJobCompletion(jobs, jobId);

    await logs.flush();

    const logHistory = await events.getHistory(`log.job.${jobId}`, 10);
    expect(logHistory.length).toBeGreaterThan(0);

    const customHistory = await events.getHistory(`job.${jobId}.event`, 10);
    expect(customHistory[0]?.data?.event).toBe("custom");

    await jobs.stop();
    logs.stop();
  });

  it("emits cron logs and custom events", async () => {
    const events = createEvents({ adapter: new MemoryEventAdapter() });
    const logs = createLogs({
      adapter: new MemoryLogsAdapter(),
      events,
      flushInterval: 5,
      maxBufferSize: 1,
      minLevel: "debug",
    });
    const logger = createLogger({
      transports: [new PersistentTransport(logs, { minLevel: "debug" })],
    });

    const cron = createCron({ logger, events });
    const taskId = cron.schedule(
      "0 * * * *",
      async (_logger, ctx) => {
        ctx?.log?.("info", "cron log");
        await ctx?.emit?.("custom", { ok: true });
      },
      { name: "hourly" }
    );

    await cron.trigger(taskId);
    await logs.flush();

    const logHistory = await events.getHistory("log.cron.hourly", 10);
    expect(logHistory.length).toBeGreaterThan(0);

    const customHistory = await events.getHistory("cron.hourly.event", 10);
    expect(customHistory[0]?.data?.event).toBe("custom");

    await cron.stop();
    logs.stop();
  });
});

async function waitForWorkflowCompletion(
  workflows: ReturnType<typeof createWorkflows>,
  instanceId: string,
  timeoutMs: number = 3000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const instance = await workflows.getInstance(instanceId);
    if (instance && instance.status !== "running" && instance.status !== "pending") {
      return instance;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for workflow ${instanceId} to complete`);
}

async function waitForJobCompletion(
  jobs: ReturnType<typeof createJobs>,
  jobId: string,
  timeoutMs: number = 3000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await jobs.get(jobId);
    if (job && job.status !== "running" && job.status !== "pending" && job.status !== "scheduled") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId} to complete`);
}
