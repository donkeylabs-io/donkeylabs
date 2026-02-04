import { describe, it, expect } from "bun:test";
import { createEvents, MemoryEventAdapter } from "../src/core/events";
import { createWorkflows, MemoryWorkflowAdapter, workflow } from "../src/core/workflows";

describe("workflow loop steps", () => {
  it("loops until condition is false and records iterations", async () => {
    const events = createEvents({ adapter: new MemoryEventAdapter() });
    const workflows = createWorkflows({ adapter: new MemoryWorkflowAdapter(), events });

    let count = 0;
    const loopWorkflow = workflow("loop-complete")
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
        interval: 5,
      })
      .build();

    workflows.register(loopWorkflow);

    const instanceId = await workflows.start("loop-complete", {});
    await waitForWorkflowCompletion(workflows, instanceId);

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("completed");
    expect(instance?.stepResults.repeat.loopCount).toBe(2);

    const loopEvents = await events.getHistory("workflow.step.loop", 10);
    expect(loopEvents.length).toBe(2);
  });

  it("fails when loop maxIterations is exceeded", async () => {
    const events = createEvents({ adapter: new MemoryEventAdapter() });
    const workflows = createWorkflows({ adapter: new MemoryWorkflowAdapter(), events });

    const loopWorkflow = workflow("loop-max")
      .isolated(false)
      .task("check", {
        handler: async () => ({ ok: false }),
      })
      .loop("repeat", {
        condition: () => true,
        target: "check",
        maxIterations: 2,
      })
      .build();

    workflows.register(loopWorkflow);

    const instanceId = await workflows.start("loop-max", {});
    const instance = await waitForWorkflowCompletion(workflows, instanceId);

    expect(instance?.status).toBe("failed");
    expect(instance?.error).toContain("maxIterations");
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
