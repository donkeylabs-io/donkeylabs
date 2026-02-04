import { describe, it, expect } from "bun:test";
import { createEvents, MemoryEventAdapter } from "../src/core/events";
import { createWorkflows, MemoryWorkflowAdapter, workflow } from "../src/core/workflows";

describe("workflow poll steps", () => {
  it("persists poll iterations and completes", async () => {
    const events = createEvents({ adapter: new MemoryEventAdapter() });
    const workflows = createWorkflows({ adapter: new MemoryWorkflowAdapter(), events });

    let checks = 0;
    const pollWorkflow = workflow("poll-complete")
      .isolated(false)
      .poll("wait", {
        interval: 5,
        check: async () => {
          checks += 1;
          if (checks >= 3) {
            return { done: true, result: { ok: true } };
          }
          return { done: false };
        },
      })
      .build();

    workflows.register(pollWorkflow);

    const instanceId = await workflows.start("poll-complete", {});
    await waitForWorkflowCompletion(workflows, instanceId);

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("completed");
    expect(instance?.stepResults.wait.pollCount).toBe(3);

    const pollEvents = await events.getHistory("workflow.step.poll", 10);
    expect(pollEvents.length).toBe(3);
  });

  it("fails when poll timeout is exceeded", async () => {
    const events = createEvents({ adapter: new MemoryEventAdapter() });
    const workflows = createWorkflows({ adapter: new MemoryWorkflowAdapter(), events });

    const pollWorkflow = workflow("poll-timeout")
      .isolated(false)
      .poll("wait", {
        interval: 10,
        timeout: 30,
        check: async () => ({ done: false }),
      })
      .build();

    workflows.register(pollWorkflow);

    const instanceId = await workflows.start("poll-timeout", {});
    const instance = await waitForWorkflowCompletion(workflows, instanceId);

    expect(instance?.status).toBe("failed");
    expect(instance?.error).toContain("timed out");
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
