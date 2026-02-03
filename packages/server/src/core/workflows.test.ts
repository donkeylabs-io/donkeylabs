import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  workflow,
  createWorkflows,
  WorkflowBuilder,
  MemoryWorkflowAdapter,
  type WorkflowDefinition,
} from "./workflows";
import { z } from "zod";

describe("WorkflowBuilder", () => {
  describe("isolated()", () => {
    it("should default to isolated: true", () => {
      const wf = workflow("test")
        .task("step1", {
          handler: async () => ({ result: "done" }),
        })
        .build();

      expect(wf.isolated).toBe(true);
    });

    it("should set isolated to false when called with false", () => {
      const wf = workflow("test")
        .isolated(false)
        .task("step1", {
          handler: async () => ({ result: "done" }),
        })
        .build();

      expect(wf.isolated).toBe(false);
    });

    it("should set isolated to true when called with true", () => {
      const wf = workflow("test")
        .isolated(true)
        .task("step1", {
          handler: async () => ({ result: "done" }),
        })
        .build();

      expect(wf.isolated).toBe(true);
    });

    it("should set isolated to true when called without argument", () => {
      const wf = workflow("test")
        .isolated()
        .task("step1", {
          handler: async () => ({ result: "done" }),
        })
        .build();

      expect(wf.isolated).toBe(true);
    });

    it("should allow chaining with other methods", () => {
      const wf = workflow("test")
        .isolated(false)
        .timeout(5000)
        .defaultRetry({ maxAttempts: 3 })
        .task("step1", {
          handler: async () => ({ result: "done" }),
        })
        .build();

      expect(wf.isolated).toBe(false);
      expect(wf.timeout).toBe(5000);
      expect(wf.defaultRetry?.maxAttempts).toBe(3);
    });
  });

  describe("task()", () => {
    it("should create task step with handler", () => {
      const wf = workflow("test")
        .task("process", {
          handler: async (input, ctx) => ({ processed: true }),
        })
        .build();

      expect(wf.steps.size).toBe(1);
      const step = wf.steps.get("process");
      expect(step?.type).toBe("task");
      expect(step?.name).toBe("process");
    });

    it("should create task step with input and output schemas", () => {
      const inputSchema = z.object({ id: z.string() });
      const outputSchema = z.object({ name: z.string() });

      const wf = workflow("test")
        .task("lookup", {
          inputSchema,
          outputSchema,
          handler: async (input) => ({ name: "John" }),
        })
        .build();

      const step = wf.steps.get("lookup") as any;
      expect(step.inputSchema).toBe(inputSchema);
      expect(step.outputSchema).toBe(outputSchema);
    });
  });

  describe("auto-linking steps", () => {
    it("should auto-link sequential steps", () => {
      const wf = workflow("test")
        .task("step1", { handler: async () => 1 })
        .task("step2", { handler: async () => 2 })
        .task("step3", { handler: async () => 3 })
        .build();

      expect(wf.startAt).toBe("step1");
      expect(wf.steps.get("step1")?.next).toBe("step2");
      expect(wf.steps.get("step2")?.next).toBe("step3");
      expect(wf.steps.get("step3")?.end).toBe(true);
    });

    it("should respect explicit next", () => {
      const wf = workflow("test")
        .task("step1", { handler: async () => 1, next: "step3" })
        .task("step2", { handler: async () => 2 })
        .task("step3", { handler: async () => 3 })
        .build();

      expect(wf.steps.get("step1")?.next).toBe("step3");
    });
  });
});

describe("Workflows Service", () => {
  let workflows: ReturnType<typeof createWorkflows>;
  let adapter: MemoryWorkflowAdapter;

  beforeEach(() => {
    adapter = new MemoryWorkflowAdapter();
    workflows = createWorkflows({ adapter });
  });

  afterEach(async () => {
    await workflows.stop();
  });

  describe("register()", () => {
    it("should register a workflow definition", () => {
      const wf = workflow("test-workflow")
        .isolated(false)
        .task("step1", { handler: async () => "done" })
        .build();

      workflows.register(wf);

      // Can start the workflow (would throw if not registered)
      expect(async () => {
        await workflows.start("test-workflow", {});
      }).not.toThrow();
    });

    it("should throw if workflow is already registered", () => {
      const wf = workflow("duplicate")
        .isolated(false)
        .task("step1", { handler: async () => "done" })
        .build();

      workflows.register(wf);

      expect(() => {
        workflows.register(wf);
      }).toThrow('Workflow "duplicate" is already registered');
    });

    it("should accept modulePath option for isolated workflows", () => {
      const wf = workflow("isolated-test")
        .task("step1", { handler: async () => "done" })
        .build();

      // Should not throw when modulePath is provided
      expect(() => {
        workflows.register(wf, { modulePath: import.meta.url });
      }).not.toThrow();
    });
  });

  describe("start()", () => {
    it("should throw if workflow is not registered", async () => {
      await expect(
        workflows.start("nonexistent", {})
      ).rejects.toThrow('Workflow "nonexistent" is not registered');
    });

    it("should create pending instance", async () => {
      const wf = workflow("simple")
        .isolated(false)
        .task("step1", {
          handler: async (input) => {
            // Slow task to catch it in pending/running state
            await new Promise((r) => setTimeout(r, 100));
            return { result: "done" };
          },
        })
        .build();

      workflows.register(wf);
      const instanceId = await workflows.start("simple", { data: "test" });

      expect(instanceId).toMatch(/^wf_/);

      // Instance should exist
      const instance = await workflows.getInstance(instanceId);
      expect(instance).not.toBeNull();
      expect(instance?.workflowName).toBe("simple");
      expect(instance?.input).toEqual({ data: "test" });
    });
  });

  describe("inline execution (isolated=false)", () => {
    it("should execute workflow steps sequentially", async () => {
      const executionOrder: string[] = [];

      const wf = workflow("sequential")
        .isolated(false)
        .task("first", {
          handler: async () => {
            executionOrder.push("first");
            return { order: 1 };
          },
        })
        .task("second", {
          handler: async (_, ctx) => {
            executionOrder.push("second");
            return { order: 2, prev: ctx.prev };
          },
        })
        .build();

      workflows.register(wf);
      const instanceId = await workflows.start("sequential", {});

      // Wait for completion
      await new Promise((r) => setTimeout(r, 200));

      const instance = await workflows.getInstance(instanceId);
      expect(instance?.status).toBe("completed");
      expect(executionOrder).toEqual(["first", "second"]);
      expect(instance?.output).toEqual({ order: 2, prev: { order: 1 } });
    });

    it("should pass workflow input to first step", async () => {
      let receivedInput: any;

      const wf = workflow("input-test")
        .isolated(false)
        .task("check-input", {
          handler: async (input) => {
            receivedInput = input;
            return { received: true };
          },
        })
        .build();

      workflows.register(wf);
      await workflows.start("input-test", { userId: "123", action: "test" });

      await new Promise((r) => setTimeout(r, 100));

      expect(receivedInput).toEqual({ userId: "123", action: "test" });
    });

    it("should handle step failures", async () => {
      const wf = workflow("failing")
        .isolated(false)
        .task("fail-step", {
          handler: async () => {
            throw new Error("Intentional failure");
          },
        })
        .build();

      workflows.register(wf);
      const instanceId = await workflows.start("failing", {});

      await new Promise((r) => setTimeout(r, 100));

      const instance = await workflows.getInstance(instanceId);
      expect(instance?.status).toBe("failed");
      expect(instance?.error).toContain("Intentional failure");
    });
  });

  describe("cancel()", () => {
    it("should cancel a running workflow", async () => {
      const wf = workflow("cancellable")
        .isolated(false)
        .task("slow-step", {
          handler: async () => {
            await new Promise((r) => setTimeout(r, 5000));
            return { done: true };
          },
        })
        .build();

      workflows.register(wf);
      const instanceId = await workflows.start("cancellable", {});

      // Give it time to start
      await new Promise((r) => setTimeout(r, 50));

      const cancelled = await workflows.cancel(instanceId);
      expect(cancelled).toBe(true);

      const instance = await workflows.getInstance(instanceId);
      expect(instance?.status).toBe("cancelled");
    });

    it("should return false for non-running workflow", async () => {
      const wf = workflow("fast")
        .isolated(false)
        .task("quick", { handler: async () => "done" })
        .build();

      workflows.register(wf);
      const instanceId = await workflows.start("fast", {});

      await new Promise((r) => setTimeout(r, 100));

      // Already completed
      const cancelled = await workflows.cancel(instanceId);
      expect(cancelled).toBe(false);
    });
  });

  describe("getInstances()", () => {
    it("should return instances by workflow name", async () => {
      const wf = workflow("multiple")
        .isolated(false)
        .task("step", { handler: async () => "done" })
        .build();

      workflows.register(wf);

      await workflows.start("multiple", { id: 1 });
      await workflows.start("multiple", { id: 2 });
      await workflows.start("multiple", { id: 3 });

      await new Promise((r) => setTimeout(r, 100));

      const instances = await workflows.getInstances("multiple");
      expect(instances.length).toBe(3);
    });

    it("should filter by status", async () => {
      const wf = workflow("mixed-status")
        .isolated(false)
        .task("step", { handler: async () => "done" })
        .build();

      const failingWf = workflow("mixed-status-fail")
        .isolated(false)
        .task("step", {
          handler: async () => {
            throw new Error("fail");
          },
        })
        .build();

      workflows.register(wf);
      workflows.register(failingWf);

      await workflows.start("mixed-status", {});
      await workflows.start("mixed-status-fail", {});

      await new Promise((r) => setTimeout(r, 100));

      const completed = await workflows.getInstances("mixed-status", "completed");
      expect(completed.length).toBe(1);

      const failed = await workflows.getInstances("mixed-status-fail", "failed");
      expect(failed.length).toBe(1);
    });
  });

  describe("getAllInstances()", () => {
    it("should return all instances with filtering", async () => {
      const wf1 = workflow("wf1").isolated(false).task("s", { handler: async () => 1 }).build();
      const wf2 = workflow("wf2").isolated(false).task("s", { handler: async () => 2 }).build();

      workflows.register(wf1);
      workflows.register(wf2);

      await workflows.start("wf1", {});
      await workflows.start("wf1", {});
      await workflows.start("wf2", {});

      await new Promise((r) => setTimeout(r, 100));

      const all = await workflows.getAllInstances();
      expect(all.length).toBe(3);

      const wf1Only = await workflows.getAllInstances({ workflowName: "wf1" });
      expect(wf1Only.length).toBe(2);

      const withLimit = await workflows.getAllInstances({ limit: 2 });
      expect(withLimit.length).toBe(2);
    });
  });
});

describe("WorkflowDefinition", () => {
  it("should include isolated field in built definition", () => {
    const isolatedWf = workflow("isolated").task("s", { handler: async () => 1 }).build();
    const inlineWf = workflow("inline").isolated(false).task("s", { handler: async () => 1 }).build();

    expect(isolatedWf.isolated).toBe(true);
    expect(inlineWf.isolated).toBe(false);
  });
});
