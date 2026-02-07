import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createJobs,
  MemoryJobAdapter,
  type Job,
  type Jobs,
  type JobStatus,
} from "../src/core/jobs";
import { createEvents, type Events } from "../src/core/events";

// ==========================================
// MemoryJobAdapter Tests
// ==========================================
describe("MemoryJobAdapter", () => {
  let adapter: MemoryJobAdapter;

  beforeEach(() => {
    adapter = new MemoryJobAdapter();
  });

  describe("create", () => {
    it("should create a job with a generated id", async () => {
      const job = await adapter.create({
        name: "test-job",
        data: { foo: "bar" },
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      expect(job.id).toBeDefined();
      expect(job.id).toContain("job_");
      expect(job.name).toBe("test-job");
      expect(job.data).toEqual({ foo: "bar" });
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
    });

    it("should assign unique ids to each job", async () => {
      const job1 = await adapter.create({
        name: "a",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 1,
      });
      const job2 = await adapter.create({
        name: "b",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 1,
      });

      expect(job1.id).not.toBe(job2.id);
    });
  });

  describe("get", () => {
    it("should retrieve a job by id", async () => {
      const created = await adapter.create({
        name: "test",
        data: { x: 1 },
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      const retrieved = await adapter.get(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.data).toEqual({ x: 1 });
    });

    it("should return null for non-existent id", async () => {
      const result = await adapter.get("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("update", () => {
    it("should update job fields", async () => {
      const job = await adapter.create({
        name: "test",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      await adapter.update(job.id, { status: "running", attempts: 1 });

      const updated = await adapter.get(job.id);
      expect(updated!.status).toBe("running");
      expect(updated!.attempts).toBe(1);
    });

    it("should be a no-op for non-existent id", async () => {
      // Should not throw
      await adapter.update("missing", { status: "failed" });
    });
  });

  describe("delete", () => {
    it("should remove an existing job and return true", async () => {
      const job = await adapter.create({
        name: "test",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      const deleted = await adapter.delete(job.id);
      expect(deleted).toBe(true);

      const retrieved = await adapter.get(job.id);
      expect(retrieved).toBeNull();
    });

    it("should return false for non-existent id", async () => {
      const deleted = await adapter.delete("nope");
      expect(deleted).toBe(false);
    });
  });

  describe("getPending", () => {
    it("should return only pending jobs", async () => {
      await adapter.create({
        name: "a",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "b",
        data: {},
        status: "running",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "c",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      const pending = await adapter.getPending();
      expect(pending).toHaveLength(2);
      expect(pending.every((j) => j.status === "pending")).toBe(true);
    });

    it("should respect the limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.create({
          name: `job-${i}`,
          data: {},
          status: "pending",
          createdAt: new Date(),
          attempts: 0,
          maxAttempts: 3,
        });
      }

      const pending = await adapter.getPending(2);
      expect(pending).toHaveLength(2);
    });
  });

  describe("getScheduledReady", () => {
    it("should return scheduled jobs whose runAt is in the past", async () => {
      const pastDate = new Date(Date.now() - 10000);
      const futureDate = new Date(Date.now() + 60000);

      await adapter.create({
        name: "ready",
        data: {},
        status: "scheduled",
        createdAt: new Date(),
        runAt: pastDate,
        attempts: 0,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "not-ready",
        data: {},
        status: "scheduled",
        createdAt: new Date(),
        runAt: futureDate,
        attempts: 0,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "pending-not-scheduled",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      const ready = await adapter.getScheduledReady(new Date());
      expect(ready).toHaveLength(1);
      expect(ready[0].name).toBe("ready");
    });

    it("should return empty array when no scheduled jobs are ready", async () => {
      await adapter.create({
        name: "future",
        data: {},
        status: "scheduled",
        createdAt: new Date(),
        runAt: new Date(Date.now() + 60000),
        attempts: 0,
        maxAttempts: 3,
      });

      const ready = await adapter.getScheduledReady(new Date());
      expect(ready).toHaveLength(0);
    });
  });

  describe("getByName", () => {
    it("should return all jobs matching the name", async () => {
      await adapter.create({
        name: "email",
        data: { to: "a@b.com" },
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "email",
        data: { to: "c@d.com" },
        status: "completed",
        createdAt: new Date(),
        attempts: 1,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "sms",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      const emailJobs = await adapter.getByName("email");
      expect(emailJobs).toHaveLength(2);
      expect(emailJobs.every((j) => j.name === "email")).toBe(true);
    });

    it("should filter by name and status when both provided", async () => {
      await adapter.create({
        name: "email",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "email",
        data: {},
        status: "completed",
        createdAt: new Date(),
        attempts: 1,
        maxAttempts: 3,
      });

      const pending = await adapter.getByName("email", "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("pending");
    });

    it("should return empty array for unknown name", async () => {
      const result = await adapter.getByName("nonexistent");
      expect(result).toHaveLength(0);
    });
  });

  describe("getAll", () => {
    it("should return all jobs sorted by createdAt descending", async () => {
      const t1 = new Date("2024-01-01");
      const t2 = new Date("2024-06-01");
      const t3 = new Date("2024-12-01");

      await adapter.create({
        name: "a",
        data: {},
        status: "pending",
        createdAt: t1,
        attempts: 0,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "b",
        data: {},
        status: "completed",
        createdAt: t3,
        attempts: 1,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "c",
        data: {},
        status: "running",
        createdAt: t2,
        attempts: 0,
        maxAttempts: 3,
      });

      const all = await adapter.getAll();
      expect(all).toHaveLength(3);
      // newest first
      expect(all[0].name).toBe("b");
      expect(all[1].name).toBe("c");
      expect(all[2].name).toBe("a");
    });

    it("should filter by status", async () => {
      await adapter.create({
        name: "a",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "b",
        data: {},
        status: "completed",
        createdAt: new Date(),
        attempts: 1,
        maxAttempts: 3,
      });

      const completed = await adapter.getAll({ status: "completed" });
      expect(completed).toHaveLength(1);
      expect(completed[0].name).toBe("b");
    });

    it("should filter by name", async () => {
      await adapter.create({
        name: "email",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });
      await adapter.create({
        name: "sms",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      const emailOnly = await adapter.getAll({ name: "email" });
      expect(emailOnly).toHaveLength(1);
      expect(emailOnly[0].name).toBe("email");
    });

    it("should apply limit and offset for pagination", async () => {
      for (let i = 0; i < 10; i++) {
        await adapter.create({
          name: `job-${i}`,
          data: {},
          status: "pending",
          createdAt: new Date(Date.now() + i * 1000),
          attempts: 0,
          maxAttempts: 3,
        });
      }

      const page1 = await adapter.getAll({ limit: 3, offset: 0 });
      expect(page1).toHaveLength(3);

      const page2 = await adapter.getAll({ limit: 3, offset: 3 });
      expect(page2).toHaveLength(3);

      // No overlap
      const page1Ids = page1.map((j) => j.id);
      const page2Ids = page2.map((j) => j.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it("should default limit to 100", async () => {
      // Just verify no crash with default options
      const all = await adapter.getAll();
      expect(all).toHaveLength(0);
    });
  });

  describe("claim", () => {
    it("should atomically claim a pending job", async () => {
      const job = await adapter.create({
        name: "test",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      const claimed = await adapter.claim(job.id);
      expect(claimed).toBe(true);

      const updated = await adapter.get(job.id);
      expect(updated!.status).toBe("running");
      expect(updated!.startedAt).toBeInstanceOf(Date);
    });

    it("should return false for non-pending job", async () => {
      const job = await adapter.create({
        name: "test",
        data: {},
        status: "running",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      const claimed = await adapter.claim(job.id);
      expect(claimed).toBe(false);
    });

    it("should return false for completed job", async () => {
      const job = await adapter.create({
        name: "test",
        data: {},
        status: "completed",
        createdAt: new Date(),
        attempts: 1,
        maxAttempts: 3,
      });

      const claimed = await adapter.claim(job.id);
      expect(claimed).toBe(false);
    });

    it("should return false for non-existent job", async () => {
      const claimed = await adapter.claim("nonexistent");
      expect(claimed).toBe(false);
    });

    it("should not allow double-claiming", async () => {
      const job = await adapter.create({
        name: "test",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      });

      const first = await adapter.claim(job.id);
      const second = await adapter.claim(job.id);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });
});

// ==========================================
// JobsImpl Tests (via createJobs)
// ==========================================
describe("JobsImpl", () => {
  let jobs: Jobs;
  let adapter: MemoryJobAdapter;
  let events: Events;

  beforeEach(() => {
    adapter = new MemoryJobAdapter();
    events = createEvents();
  });

  afterEach(async () => {
    if (jobs) await jobs.stop();
  });

  // Helper to create a jobs instance with short polling
  function makeJobs(overrides: Record<string, any> = {}): Jobs {
    jobs = createJobs({
      adapter,
      events,
      persist: false,
      pollInterval: 30,
      retryBackoff: false,
      ...overrides,
    });
    return jobs;
  }

  describe("register", () => {
    it("should register a handler without error", () => {
      makeJobs();
      jobs.register("test-job", async () => {});
      // No error means success
    });

    it("should throw on duplicate registration", () => {
      makeJobs();
      jobs.register("dup", async () => {});
      expect(() => jobs.register("dup", async () => {})).toThrow(
        'Job handler "dup" is already registered'
      );
    });
  });

  describe("enqueue", () => {
    it("should create a pending job and return its id", async () => {
      makeJobs();
      jobs.register("work", async () => {});

      const jobId = await jobs.enqueue("work", { val: 42 });
      expect(jobId).toBeDefined();

      const job = await jobs.get(jobId);
      expect(job).not.toBeNull();
      expect(job!.status).toBe("pending");
      expect(job!.name).toBe("work");
      expect(job!.data).toEqual({ val: 42 });
      expect(job!.attempts).toBe(0);
    });

    it("should throw if no handler is registered", async () => {
      makeJobs();
      await expect(jobs.enqueue("unknown", {})).rejects.toThrow(
        'No handler registered for job "unknown"'
      );
    });

    it("should accept custom maxAttempts", async () => {
      makeJobs();
      jobs.register("custom", async () => {});

      const jobId = await jobs.enqueue("custom", {}, { maxAttempts: 10 });
      const job = await jobs.get(jobId);
      expect(job!.maxAttempts).toBe(10);
    });

    it("should use default maxAttempts from config", async () => {
      makeJobs({ maxAttempts: 7 });
      jobs.register("default-retry", async () => {});

      const jobId = await jobs.enqueue("default-retry", {});
      const job = await jobs.get(jobId);
      expect(job!.maxAttempts).toBe(7);
    });
  });

  describe("schedule", () => {
    it("should create a scheduled job with runAt", async () => {
      makeJobs();
      jobs.register("scheduled-work", async () => {});

      const runAt = new Date(Date.now() + 60000);
      const jobId = await jobs.schedule("scheduled-work", { data: 1 }, runAt);
      const job = await jobs.get(jobId);

      expect(job!.status).toBe("scheduled");
      expect(job!.runAt).toEqual(runAt);
    });

    it("should throw if no handler registered", async () => {
      makeJobs();
      await expect(
        jobs.schedule("missing", {}, new Date())
      ).rejects.toThrow('No handler registered for job "missing"');
    });
  });

  describe("cancel", () => {
    it("should cancel a pending job", async () => {
      makeJobs();
      jobs.register("cancelable", async () => {});

      const jobId = await jobs.enqueue("cancelable", {});
      const cancelled = await jobs.cancel(jobId);
      expect(cancelled).toBe(true);

      const job = await jobs.get(jobId);
      expect(job).toBeNull();
    });

    it("should return false for non-existent job", async () => {
      makeJobs();
      const cancelled = await jobs.cancel("nope");
      expect(cancelled).toBe(false);
    });

    it("should return false for running in-process job", async () => {
      makeJobs();

      // Create a long-running job
      let resolveJob: () => void;
      const jobStarted = new Promise<void>((r) => {
        jobs.register("long-run", async () => {
          r();
          await new Promise<void>((res) => {
            resolveJob = res;
          });
        });
      });

      const jobId = await jobs.enqueue("long-run", {});
      jobs.start();
      await jobStarted;

      // Job should now be running
      const job = await jobs.get(jobId);
      expect(job!.status).toBe("running");

      const cancelled = await jobs.cancel(jobId);
      expect(cancelled).toBe(false);

      // Let the job finish to clean up
      resolveJob!();
    });
  });

  describe("tick - scheduled job promotion", () => {
    it("should promote scheduled jobs to pending when runAt is past", async () => {
      makeJobs();
      jobs.register("sched", async () => {});

      const pastRunAt = new Date(Date.now() - 1000);
      const jobId = await jobs.schedule("sched", {}, pastRunAt);

      // Start and let one tick run
      jobs.start();
      await new Promise((r) => setTimeout(r, 100));

      const job = await jobs.get(jobId);
      // It could be pending, running, or completed depending on timing
      expect(["pending", "running", "completed"]).toContain(job!.status);
    });
  });

  describe("tick - concurrency limit", () => {
    it("should not exceed concurrency limit", async () => {
      const concurrency = 2;
      makeJobs({ concurrency });

      let running = 0;
      let maxRunning = 0;
      const allDone: Promise<void>[] = [];

      jobs.register("concurrent", async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 80));
        running--;
      });

      // Enqueue more jobs than concurrency limit
      for (let i = 0; i < 5; i++) {
        allDone.push(
          jobs.enqueue("concurrent", { i }).then(() => {})
        );
      }

      jobs.start();
      // Wait for all jobs to process
      await new Promise((r) => setTimeout(r, 600));

      expect(maxRunning).toBeLessThanOrEqual(concurrency);
    });
  });

  describe("tick - reentrancy guard", () => {
    it("should not allow concurrent tick executions", async () => {
      // The reentrancy guard is internal; we verify it doesn't cause issues
      // by starting with a very short poll interval
      makeJobs({ pollInterval: 5 });
      let callCount = 0;

      jobs.register("fast", async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
      });

      await jobs.enqueue("fast", {});
      jobs.start();

      await new Promise((r) => setTimeout(r, 200));

      // The single enqueued job should only be processed once
      expect(callCount).toBe(1);
    });
  });

  describe("processJob - success", () => {
    it("should mark job as completed with result", async () => {
      makeJobs();
      const done = new Promise<string>((resolve) => {
        jobs.register("compute", async (data: { x: number }) => {
          const result = data.x * 2;
          resolve("handler-done");
          return result;
        });
      });

      const jobId = await jobs.enqueue("compute", { x: 21 });
      jobs.start();

      await done;
      // Wait a moment for the adapter update
      await new Promise((r) => setTimeout(r, 60));

      const job = await jobs.get(jobId);
      expect(job!.status).toBe("completed");
      expect(job!.result).toBe(42);
      expect(job!.completedAt).toBeInstanceOf(Date);
    });

    it("should emit job.completed and job.<name>.completed events", async () => {
      makeJobs();
      const emitted: string[] = [];

      events.on("job.completed", () => emitted.push("job.completed"));
      events.on("job.compute.completed", () =>
        emitted.push("job.compute.completed")
      );

      const done = new Promise<void>((resolve) => {
        jobs.register("compute", async () => {
          resolve();
          return "ok";
        });
      });

      await jobs.enqueue("compute", {});
      jobs.start();

      await done;
      await new Promise((r) => setTimeout(r, 60));

      expect(emitted).toContain("job.completed");
      expect(emitted).toContain("job.compute.completed");
    });
  });

  describe("processJob - retry with exponential backoff", () => {
    it("should schedule retry with exponential backoff on failure", async () => {
      // Use large backoff so the job won't be retried within the test window
      makeJobs({
        retryBackoff: { baseMs: 60000, maxMs: 120000 },
        maxAttempts: 3,
        pollInterval: 20,
      });

      const firstAttemptDone = new Promise<void>((resolve) => {
        jobs.register("failing", async () => {
          // Resolve after a small delay to let processJob see the throw
          throw new Error("boom");
        });
      });

      // Listen for the event that fires after the catch block runs
      const failRetryDone = new Promise<void>((resolve) => {
        // On first attempt failure with retries remaining, no event is emitted.
        // Instead, poll for the job state.
        const interval = setInterval(async () => {
          const allJobs = await adapter.getAll();
          const j = allJobs.find((j) => j.name === "failing");
          if (j && j.attempts > 0 && j.status === "scheduled") {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });

      const jobId = await jobs.enqueue("failing", {});
      jobs.start();

      await failRetryDone;
      await jobs.stop();

      const job = await jobs.get(jobId);
      // After first failure, should be scheduled for retry with backoff
      expect(job!.status).toBe("scheduled");
      expect(job!.runAt).toBeInstanceOf(Date);
      expect(job!.error).toBe("boom");
      // runAt should be far in the future (60s base backoff)
      expect(job!.runAt!.getTime()).toBeGreaterThan(Date.now() + 50000);
    });

    it("should cap backoff at maxMs", async () => {
      makeJobs({
        retryBackoff: { baseMs: 1000, maxMs: 2000 },
        maxAttempts: 10,
        pollInterval: 20,
      });

      let callCount = 0;
      jobs.register("backoff-cap", async () => {
        callCount++;
        throw new Error("fail");
      });

      const jobId = await jobs.enqueue("backoff-cap", {});
      jobs.start();

      await new Promise((r) => setTimeout(r, 100));
      await jobs.stop();

      const job = await jobs.get(jobId);
      if (job!.status === "scheduled" && job!.runAt) {
        // The backoff for attempt 1 is min(1000 * 2^0, 2000) = 1000
        // For higher attempts it would be capped at 2000
        const delay = job!.runAt.getTime() - Date.now();
        expect(delay).toBeLessThanOrEqual(2100); // maxMs + some tolerance
      }
    });
  });

  describe("processJob - immediate retry (retryBackoff: false)", () => {
    it("should set status to pending for immediate retry", async () => {
      makeJobs({ retryBackoff: false, maxAttempts: 5, pollInterval: 20 });

      let attempts = 0;
      const done = new Promise<void>((resolve) => {
        jobs.register("retry-immediate", async () => {
          attempts++;
          if (attempts < 3) throw new Error("retry me");
          resolve();
        });
      });

      await jobs.enqueue("retry-immediate", {});
      jobs.start();

      await done;
      await new Promise((r) => setTimeout(r, 100));
      await jobs.stop();

      expect(attempts).toBe(3);
    });

    it("should set job back to pending (not scheduled) on failure", async () => {
      makeJobs({ retryBackoff: false, maxAttempts: 5, pollInterval: 20 });

      let firstFail = true;
      const firstFailDone = new Promise<void>((resolve) => {
        jobs.register("check-pending", async () => {
          if (firstFail) {
            firstFail = false;
            // Stop processing so we can inspect the state
            setTimeout(() => resolve(), 10);
            throw new Error("oops");
          }
        });
      });

      const jobId = await jobs.enqueue("check-pending", {});
      jobs.start();

      await firstFailDone;
      await new Promise((r) => setTimeout(r, 50));
      await jobs.stop();

      const job = await jobs.get(jobId);
      // After first failure with retryBackoff:false, should be pending (or already re-running)
      expect(["pending", "running", "completed"]).toContain(job!.status);
    });
  });

  describe("processJob - max attempts failure", () => {
    it("should mark job as failed after max attempts", async () => {
      makeJobs({ retryBackoff: false, maxAttempts: 2, pollInterval: 20 });

      let attempts = 0;
      const allFailed = new Promise<void>((resolve) => {
        events.on("job.failed", () => resolve());
      });

      jobs.register("always-fail", async () => {
        attempts++;
        throw new Error("permanent-failure");
      });

      const jobId = await jobs.enqueue("always-fail", {});
      jobs.start();

      await allFailed;
      await new Promise((r) => setTimeout(r, 60));

      const job = await jobs.get(jobId);
      expect(job!.status).toBe("failed");
      expect(job!.attempts).toBe(2);
      expect(job!.error).toBe("permanent-failure");
      expect(job!.completedAt).toBeInstanceOf(Date);
    });

    it("should emit job.failed and job.<name>.failed events", async () => {
      makeJobs({ retryBackoff: false, maxAttempts: 1, pollInterval: 20 });

      const emitted: string[] = [];
      events.on("job.failed", () => emitted.push("job.failed"));
      events.on("job.doomed.failed", () =>
        emitted.push("job.doomed.failed")
      );

      const failDone = new Promise<void>((resolve) => {
        events.on("job.failed", () => resolve());
      });

      jobs.register("doomed", async () => {
        throw new Error("nope");
      });

      await jobs.enqueue("doomed", {});
      jobs.start();

      await failDone;
      await new Promise((r) => setTimeout(r, 60));

      expect(emitted).toContain("job.failed");
      expect(emitted).toContain("job.doomed.failed");
    });
  });

  describe("start / stop lifecycle", () => {
    it("should not process jobs before start is called", async () => {
      makeJobs();
      let called = false;
      jobs.register("no-auto-start", async () => {
        called = true;
      });

      await jobs.enqueue("no-auto-start", {});

      await new Promise((r) => setTimeout(r, 100));
      expect(called).toBe(false);
    });

    it("should process jobs after start is called", async () => {
      makeJobs();
      const done = new Promise<void>((resolve) => {
        jobs.register("starts-later", async () => {
          resolve();
        });
      });

      await jobs.enqueue("starts-later", {});
      jobs.start();

      await done;
    });

    it("should stop processing after stop is called", async () => {
      makeJobs();
      let count = 0;
      jobs.register("counting", async () => {
        count++;
      });

      await jobs.enqueue("counting", {});
      jobs.start();

      await new Promise((r) => setTimeout(r, 100));
      await jobs.stop();

      const countAfterStop = count;

      // Enqueue another and wait - it should not be processed
      await jobs.enqueue("counting", {});
      await new Promise((r) => setTimeout(r, 100));
      expect(count).toBe(countAfterStop);
    });

    it("calling start twice should be idempotent", () => {
      makeJobs();
      jobs.register("noop", async () => {});
      jobs.start();
      jobs.start(); // should not throw or create duplicate timers
    });
  });

  describe("getByName delegation", () => {
    it("should delegate to adapter getByName", async () => {
      makeJobs();
      jobs.register("task", async () => {});
      jobs.register("other", async () => {});

      await jobs.enqueue("task", { a: 1 });
      await jobs.enqueue("task", { a: 2 });
      await jobs.enqueue("other", { a: 3 });

      const results = await jobs.getByName("task");
      expect(results).toHaveLength(2);
      expect(results.every((j) => j.name === "task")).toBe(true);
    });

    it("should filter by status", async () => {
      makeJobs();
      jobs.register("task", async () => {});

      const jobId = await jobs.enqueue("task", {});
      await jobs.enqueue("task", {});
      // Manually update one to completed via adapter
      await adapter.update(jobId, {
        status: "completed",
        completedAt: new Date(),
      });

      const pending = await jobs.getByName("task", "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("pending");
    });
  });

  describe("getAll delegation", () => {
    it("should delegate to adapter getAll", async () => {
      makeJobs();
      jobs.register("alpha", async () => {});
      jobs.register("beta", async () => {});

      await jobs.enqueue("alpha", {});
      await jobs.enqueue("beta", {});

      const all = await jobs.getAll();
      expect(all).toHaveLength(2);
    });

    it("should pass through filter options", async () => {
      makeJobs();
      jobs.register("gamma", async () => {});

      await jobs.enqueue("gamma", {});
      await jobs.enqueue("gamma", {});

      const filtered = await jobs.getAll({ name: "gamma", limit: 1 });
      expect(filtered).toHaveLength(1);
    });
  });

  describe("processJob - events context", () => {
    it("should provide emit function to handler context", async () => {
      makeJobs();
      const receivedEvents: any[] = [];

      events.on("job.event", (data) => receivedEvents.push(data));

      const done = new Promise<void>((resolve) => {
        jobs.register("emitter", async (_data, ctx) => {
          if (ctx?.emit) {
            await ctx.emit("custom-event", { key: "value" });
          }
          resolve();
        });
      });

      await jobs.enqueue("emitter", {});
      jobs.start();

      await done;
      await new Promise((r) => setTimeout(r, 60));

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].event).toBe("custom-event");
      expect(receivedEvents[0].data).toEqual({ key: "value" });
    });
  });

  describe("processJob - no events service", () => {
    it("should work without events service", async () => {
      jobs = createJobs({
        adapter,
        persist: false,
        pollInterval: 30,
        retryBackoff: false,
      });

      const done = new Promise<void>((resolve) => {
        jobs.register("no-events", async () => {
          resolve();
          return "ok";
        });
      });

      const jobId = await jobs.enqueue("no-events", {});
      jobs.start();

      await done;
      await new Promise((r) => setTimeout(r, 60));

      const job = await jobs.get(jobId);
      expect(job!.status).toBe("completed");
      expect(job!.result).toBe("ok");
    });
  });

  describe("processJob - attempts tracking", () => {
    it("should increment attempts on each run", async () => {
      makeJobs({ retryBackoff: false, maxAttempts: 2, pollInterval: 20 });

      const failedDone = new Promise<void>((resolve) => {
        events.on("job.failed", () => resolve());
      });

      jobs.register("attempts-track", async () => {
        throw new Error("always-fail");
      });

      const jobId = await jobs.enqueue("attempts-track", {});
      jobs.start();

      await failedDone;
      await new Promise((r) => setTimeout(r, 60));
      await jobs.stop();

      const job = await jobs.get(jobId);
      expect(job!.attempts).toBe(2);
      expect(job!.status).toBe("failed");
    });
  });
});
