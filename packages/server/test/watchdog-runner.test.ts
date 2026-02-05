import { describe, it, expect } from "bun:test";
import { WatchdogRunner } from "../src/core/watchdog-runner";
import { MemoryWorkflowAdapter } from "../src/core/workflows";
import { MemoryJobAdapter, type Job } from "../src/core/jobs";

class MockProcessAdapter {
  private processes: any[] = [];

  constructor(processes: any[]) {
    this.processes = processes;
  }

  async getRunning() {
    return this.processes.filter((p) => p.status === "running");
  }

  async update(id: string, updates: any) {
    const proc = this.processes.find((p) => p.id === id);
    if (proc) Object.assign(proc, updates);
  }
}

describe("watchdog runner", () => {
  it("marks stale workflow as failed and emits events", async () => {
    const workflows = new MemoryWorkflowAdapter();
    const instance = await workflows.createInstance({
      workflowName: "test",
      status: "running",
      currentStep: "step",
      input: {},
      stepResults: {},
      createdAt: new Date(),
      metadata: {
        __watchdog: {
          pid: 123,
          lastHeartbeat: new Date(Date.now() - 120_000).toISOString(),
        },
      },
    });

    const events: string[] = [];
    const killed: number[] = [];
    const runner = new WatchdogRunner(
      {
        services: ["workflows"],
        killGraceMs: 0,
        workflowHeartbeatTimeoutMs: 30_000,
        jobDefaults: { heartbeatTimeoutMs: 30_000, killGraceMs: 0 },
        jobConfigs: {},
      },
      {
        workflowsAdapter: workflows,
        killProcess: (pid) => {
          killed.push(pid);
        },
        emit: async (event) => {
          events.push(event);
        },
      }
    );

    await runner.runOnce();

    const updated = await workflows.getInstance(instance.id);
    expect(updated?.status).toBe("failed");
    expect(events).toContain("workflow.watchdog.stale");
    expect(events).toContain("workflow.watchdog.killed");
    expect(killed).toContain(123);
  });

  it("kills stale external jobs", async () => {
    const jobs = new MemoryJobAdapter();
    const job = await jobs.create({
      name: "external",
      data: {},
      status: "running",
      attempts: 0,
      maxAttempts: 1,
      createdAt: new Date(),
      external: true,
      pid: 321,
      processState: "running",
      lastHeartbeat: new Date(Date.now() - 120_000),
    } as Job);

    const killed: number[] = [];
    const runner = new WatchdogRunner(
      {
        services: ["jobs"],
        killGraceMs: 0,
        workflowHeartbeatTimeoutMs: 30_000,
        jobDefaults: { heartbeatTimeoutMs: 30_000, killGraceMs: 0 },
        jobConfigs: {},
      },
      {
        jobsAdapter: jobs,
        killProcess: (pid) => {
          killed.push(pid);
        },
      }
    );

    await runner.runOnce();

    const updated = await jobs.get(job.id);
    expect(updated?.status).toBe("failed");
    expect(killed).toContain(321);
  });

  it("kills stale processes", async () => {
    const processes = new MockProcessAdapter([
      {
        id: "proc_1",
        name: "worker",
        pid: 555,
        status: "running",
        config: { heartbeat: { timeoutMs: 1000 } },
        startedAt: new Date(Date.now() - 2000),
        lastHeartbeat: new Date(Date.now() - 2000),
      },
    ]);

    const killed: number[] = [];
    const runner = new WatchdogRunner(
      {
        services: ["processes"],
        killGraceMs: 0,
        workflowHeartbeatTimeoutMs: 30_000,
        jobDefaults: { heartbeatTimeoutMs: 30_000, killGraceMs: 0 },
        jobConfigs: {},
      },
      {
        processesAdapter: processes as any,
        killProcess: (pid) => {
          killed.push(pid);
        },
      }
    );

    await runner.runOnce();

    expect(killed).toContain(555);
  });
});
