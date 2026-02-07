import { describe, it, expect, afterEach } from "bun:test";
import { createEvents } from "../src/core/events";
import { createJobs, MemoryJobAdapter, type JobHandlerContext } from "../src/core/jobs";

/**
 * Jobs traceId propagation tests.
 *
 * Verifies that traceId flows:
 *   enqueue(options.traceId) -> Job.traceId -> JobHandlerContext.traceId
 */

describe("Jobs - traceId propagation", () => {
  let jobs: ReturnType<typeof createJobs>;

  afterEach(async () => {
    if (jobs) await jobs.stop();
  });

  it("should store traceId on the Job record when enqueued", async () => {
    const adapter = new MemoryJobAdapter();
    jobs = createJobs({ adapter, persist: false });

    jobs.register("echo", async () => {});

    const jobId = await jobs.enqueue("echo", { value: 1 }, { traceId: "trace-abc" });
    const job = await jobs.get(jobId);

    expect(job).not.toBeNull();
    expect(job!.traceId).toBe("trace-abc");
  });

  it("should pass traceId to JobHandlerContext when processing", async () => {
    const adapter = new MemoryJobAdapter();
    const events = createEvents();
    jobs = createJobs({
      adapter,
      events,
      persist: false,
      pollInterval: 50,
      retryBackoff: false,
    });

    let receivedCtx: JobHandlerContext | undefined;
    const done = new Promise<void>((resolve) => {
      jobs.register("tracer", async (_data, ctx) => {
        receivedCtx = ctx;
        resolve();
      });
    });

    await jobs.enqueue("tracer", { hello: "world" }, { traceId: "trace-xyz-789" });
    jobs.start();

    await done;
    await jobs.stop();

    expect(receivedCtx).toBeDefined();
    expect(receivedCtx!.traceId).toBe("trace-xyz-789");
  });

  it("should have undefined traceId when not provided (backwards compat)", async () => {
    const adapter = new MemoryJobAdapter();
    jobs = createJobs({
      adapter,
      persist: false,
      pollInterval: 50,
      retryBackoff: false,
    });

    let receivedCtx: JobHandlerContext | undefined;
    const done = new Promise<void>((resolve) => {
      jobs.register("no-trace", async (_data, ctx) => {
        receivedCtx = ctx;
        resolve();
      });
    });

    // Enqueue without traceId
    await jobs.enqueue("no-trace", {});
    jobs.start();

    await done;
    await jobs.stop();

    expect(receivedCtx).toBeDefined();
    expect(receivedCtx!.traceId).toBeUndefined();
  });

  it("should store traceId on scheduled jobs", async () => {
    const adapter = new MemoryJobAdapter();
    jobs = createJobs({ adapter, persist: false });

    jobs.register("scheduled-trace", async () => {});

    const runAt = new Date(Date.now() + 60000);
    const jobId = await jobs.schedule("scheduled-trace", {}, runAt, { traceId: "sched-trace-1" });

    const job = await jobs.get(jobId);
    expect(job).not.toBeNull();
    expect(job!.traceId).toBe("sched-trace-1");
  });

  it("should preserve traceId across retry attempts", async () => {
    const adapter = new MemoryJobAdapter();
    jobs = createJobs({
      adapter,
      persist: false,
      pollInterval: 50,
      maxAttempts: 3,
      retryBackoff: false,
    });

    let attempts = 0;
    let lastTraceId: string | undefined;

    const done = new Promise<void>((resolve) => {
      jobs.register("retry-trace", async (_data, ctx) => {
        lastTraceId = ctx?.traceId;
        attempts++;
        if (attempts < 2) {
          throw new Error("retry me");
        }
        resolve();
      });
    });

    await jobs.enqueue("retry-trace", {}, { traceId: "retry-trace-001", maxAttempts: 3 });
    jobs.start();

    await done;
    await jobs.stop();

    expect(attempts).toBe(2);
    // traceId should still be present on retry since it's stored on the Job record
    expect(lastTraceId).toBe("retry-trace-001");
  });
});
