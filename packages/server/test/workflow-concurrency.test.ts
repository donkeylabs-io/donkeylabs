import { describe, it, expect } from "bun:test";
import { createWorkflows, MemoryWorkflowAdapter, workflow } from "../src/core/workflows";

describe("workflow concurrency guard", () => {
  it("prevents starting when limit is reached", async () => {
    const workflows = createWorkflows({
      adapter: new MemoryWorkflowAdapter(),
      concurrentWorkflows: 1,
    });

    const sleeper = workflow("limited")
      .isolated(false)
      .task("sleep", {
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { ok: true };
        },
        end: true,
      })
      .build();

    workflows.register(sleeper);

    const firstId = await workflows.start("limited", {});
    await expect(workflows.start("limited", {})).rejects.toThrow("concurrency limit");

    await waitForWorkflowCompletion(workflows, firstId);
  });

  it("supports per-workflow limits via register options", async () => {
    const workflows = createWorkflows({
      adapter: new MemoryWorkflowAdapter(),
      concurrentWorkflows: 0,
    });

    const limited = workflow("limited")
      .isolated(false)
      .task("sleep", {
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { ok: true };
        },
        end: true,
      })
      .build();

    const unlimited = workflow("unlimited")
      .isolated(false)
      .task("done", {
        handler: async () => ({ ok: true }),
        end: true,
      })
      .build();

    workflows.register(limited, { maxConcurrent: 1 });
    workflows.register(unlimited);

    const firstId = await workflows.start("limited", {});
    await expect(workflows.start("limited", {})).rejects.toThrow("concurrency limit");

    await workflows.start("unlimited", {});
    await workflows.start("unlimited", {});

    await waitForWorkflowCompletion(workflows, firstId);
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for workflow ${instanceId} to complete`);
}
