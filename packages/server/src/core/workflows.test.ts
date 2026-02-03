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

  it("should auto-detect sourceModule as a valid file:// URL after build()", () => {
    const wf = workflow("auto-detect")
      .task("s", { handler: async () => 1 })
      .build();

    expect(wf.sourceModule).toBeDefined();
    expect(wf.sourceModule).toMatch(/^file:\/\//);
    // Should point to this test file
    expect(wf.sourceModule).toContain("workflows.test.ts");
  });
});

describe("register() with auto-detected sourceModule", () => {
  let workflows: ReturnType<typeof createWorkflows>;
  let adapter: MemoryWorkflowAdapter;

  beforeEach(() => {
    adapter = new MemoryWorkflowAdapter();
    workflows = createWorkflows({ adapter });
  });

  afterEach(async () => {
    await workflows.stop();
  });

  it("should not warn when registering isolated workflow with auto-detected sourceModule", () => {
    const wf = workflow("auto-isolated")
      .task("s", { handler: async () => 1 })
      .build();

    // sourceModule should be set by build()
    expect(wf.sourceModule).toBeDefined();

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(" "));
    try {
      workflows.register(wf);
    } finally {
      console.warn = origWarn;
    }

    expect(warnings.filter((w) => w.includes("no modulePath"))).toHaveLength(0);
  });

  it("should prefer explicit modulePath over auto-detected sourceModule", () => {
    const wf = workflow("explicit-path")
      .task("s", { handler: async () => 1 })
      .build();

    // Register with explicit modulePath
    expect(() => {
      workflows.register(wf, { modulePath: "file:///explicit/path.ts" });
    }).not.toThrow();
  });
});

describe("Choice steps (inline)", () => {
  let workflows: ReturnType<typeof createWorkflows>;
  let adapter: MemoryWorkflowAdapter;

  beforeEach(() => {
    adapter = new MemoryWorkflowAdapter();
    workflows = createWorkflows({ adapter });
  });

  afterEach(async () => {
    await workflows.stop();
  });

  it("should register workflow with choice step (no restriction)", () => {
    const wf = workflow("with-choice")
      .isolated(false)
      .task("start", { handler: async () => ({ type: "express" }) })
      .choice("route", {
        choices: [
          { condition: (ctx) => ctx.prev?.type === "express", next: "fast-path" },
          { condition: (ctx) => ctx.prev?.type === "standard", next: "slow-path" },
        ],
        default: "slow-path",
      })
      .task("fast-path", { handler: async () => ({ speed: "fast" }), end: true })
      .task("slow-path", { handler: async () => ({ speed: "slow" }), end: true })
      .build();

    // Should not throw - choice is allowed now
    expect(() => workflows.register(wf)).not.toThrow();
  });

  it("should execute choice step and follow matching branch", async () => {
    const wf = workflow("choice-test")
      .isolated(false)
      .task("start", { handler: async () => ({ type: "express" }) })
      .choice("route", {
        choices: [
          { condition: (ctx) => ctx.prev?.type === "express", next: "fast-path" },
        ],
        default: "slow-path",
      })
      .task("fast-path", { handler: async () => ({ speed: "fast" }), end: true })
      .task("slow-path", { handler: async () => ({ speed: "slow" }), end: true })
      .build();

    workflows.register(wf);
    const instanceId = await workflows.start("choice-test", {});

    await new Promise((r) => setTimeout(r, 200));

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("completed");
    expect(instance?.output).toEqual({ speed: "fast" });
  });

  it("should use default when no choice matches", async () => {
    const wf = workflow("choice-default")
      .isolated(false)
      .task("start", { handler: async () => ({ type: "unknown" }) })
      .choice("route", {
        choices: [
          { condition: (ctx) => ctx.prev?.type === "express", next: "fast-path" },
        ],
        default: "slow-path",
      })
      .task("fast-path", { handler: async () => ({ speed: "fast" }), end: true })
      .task("slow-path", { handler: async () => ({ speed: "slow" }), end: true })
      .build();

    workflows.register(wf);
    const instanceId = await workflows.start("choice-default", {});

    await new Promise((r) => setTimeout(r, 200));

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("completed");
    expect(instance?.output).toEqual({ speed: "slow" });
  });

  it("should fail when no choice matches and no default", async () => {
    const wf = workflow("choice-no-default")
      .isolated(false)
      .task("start", { handler: async () => ({ type: "unknown" }) })
      .choice("route", {
        choices: [
          { condition: (ctx) => ctx.prev?.type === "express", next: "fast-path" },
        ],
      })
      .task("fast-path", { handler: async () => ({ speed: "fast" }), end: true })
      .build();

    workflows.register(wf);
    const instanceId = await workflows.start("choice-no-default", {});

    await new Promise((r) => setTimeout(r, 200));

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("failed");
    expect(instance?.error).toContain("No choice condition matched");
  });
});

describe("Parallel steps (inline)", () => {
  let workflows: ReturnType<typeof createWorkflows>;
  let adapter: MemoryWorkflowAdapter;

  beforeEach(() => {
    adapter = new MemoryWorkflowAdapter();
    workflows = createWorkflows({ adapter });
  });

  afterEach(async () => {
    await workflows.stop();
  });

  it("should register workflow with parallel step (no restriction)", () => {
    const branch1 = workflow.branch("branch-a")
      .task("a1", { handler: async () => ({ branch: "a" }) })
      .build();

    const branch2 = workflow.branch("branch-b")
      .task("b1", { handler: async () => ({ branch: "b" }) })
      .build();

    const wf = workflow("with-parallel")
      .isolated(false)
      .parallel("fan-out", { branches: [branch1, branch2] })
      .build();

    expect(() => workflows.register(wf)).not.toThrow();
  });

  it("should execute parallel branches and aggregate results", async () => {
    const branch1 = workflow.branch("branch-a")
      .task("a1", { handler: async () => ({ result: "a" }) })
      .build();

    const branch2 = workflow.branch("branch-b")
      .task("b1", { handler: async () => ({ result: "b" }) })
      .build();

    const wf = workflow("parallel-test")
      .isolated(false)
      .parallel("fan-out", { branches: [branch1, branch2] })
      .build();

    workflows.register(wf);
    const instanceId = await workflows.start("parallel-test", {});

    await new Promise((r) => setTimeout(r, 300));

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("completed");
    expect(instance?.output).toEqual({
      "branch-a": { result: "a" },
      "branch-b": { result: "b" },
    });
  });

  it("should fail-fast when a branch fails (default)", async () => {
    const branch1 = workflow.branch("branch-ok")
      .task("ok", {
        handler: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return { ok: true };
        },
      })
      .build();

    const branch2 = workflow.branch("branch-fail")
      .task("fail", {
        handler: async () => {
          throw new Error("Branch failure");
        },
      })
      .build();

    const wf = workflow("parallel-fail-fast")
      .isolated(false)
      .parallel("fan-out", { branches: [branch1, branch2] })
      .build();

    workflows.register(wf);
    const instanceId = await workflows.start("parallel-fail-fast", {});

    await new Promise((r) => setTimeout(r, 300));

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("failed");
    expect(instance?.error).toContain("Branch failure");
  });

  it("should collect all results with wait-all and report errors", async () => {
    const branch1 = workflow.branch("branch-ok-wa")
      .task("ok", { handler: async () => ({ ok: true }) })
      .build();

    const branch2 = workflow.branch("branch-fail-wa")
      .task("fail", {
        handler: async () => {
          throw new Error("Branch error");
        },
      })
      .build();

    const wf = workflow("parallel-wait-all")
      .isolated(false)
      .parallel("fan-out", {
        branches: [branch1, branch2],
        onError: "wait-all",
      })
      .build();

    workflows.register(wf);
    const instanceId = await workflows.start("parallel-wait-all", {});

    await new Promise((r) => setTimeout(r, 300));

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("failed");
    expect(instance?.error).toContain("Parallel branches failed");
  });
});

describe("Retry logic", () => {
  let workflows: ReturnType<typeof createWorkflows>;
  let adapter: MemoryWorkflowAdapter;

  beforeEach(() => {
    adapter = new MemoryWorkflowAdapter();
    workflows = createWorkflows({ adapter });
  });

  afterEach(async () => {
    await workflows.stop();
  });

  it("should retry step on failure with exponential backoff", async () => {
    let attempts = 0;

    const wf = workflow("retry-test")
      .isolated(false)
      .task("flaky", {
        handler: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error("Temporary failure");
          }
          return { success: true };
        },
        retry: {
          maxAttempts: 3,
          intervalMs: 50,
          backoffRate: 2,
        },
      })
      .build();

    workflows.register(wf);
    const instanceId = await workflows.start("retry-test", {});

    // Wait long enough for retries (50ms + 100ms + execution time)
    await new Promise((r) => setTimeout(r, 500));

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("completed");
    expect(attempts).toBe(3);
    expect(instance?.output).toEqual({ success: true });
  });

  it("should fail after exhausting retries", async () => {
    let attempts = 0;

    const wf = workflow("retry-exhaust")
      .isolated(false)
      .task("always-fail", {
        handler: async () => {
          attempts++;
          throw new Error("Permanent failure");
        },
        retry: {
          maxAttempts: 2,
          intervalMs: 50,
        },
      })
      .build();

    workflows.register(wf);
    const instanceId = await workflows.start("retry-exhaust", {});

    await new Promise((r) => setTimeout(r, 500));

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("failed");
    expect(instance?.error).toContain("Permanent failure");
    expect(attempts).toBe(2);
  });
});

describe("Metadata persistence", () => {
  let workflows: ReturnType<typeof createWorkflows>;
  let adapter: MemoryWorkflowAdapter;

  beforeEach(() => {
    adapter = new MemoryWorkflowAdapter();
    workflows = createWorkflows({ adapter });
  });

  afterEach(async () => {
    await workflows.stop();
  });

  it("should persist metadata across steps", async () => {
    let secondStepMetadata: any;

    const wf = workflow("metadata-test")
      .isolated(false)
      .task("set-meta", {
        handler: async (_, ctx) => {
          await ctx.setMetadata("tracking", { id: "abc-123" });
          return { done: true };
        },
      })
      .task("read-meta", {
        handler: async (_, ctx) => {
          secondStepMetadata = ctx.getMetadata("tracking");
          return { meta: secondStepMetadata };
        },
      })
      .build();

    workflows.register(wf);
    const instanceId = await workflows.start("metadata-test", {});

    await new Promise((r) => setTimeout(r, 200));

    const instance = await workflows.getInstance(instanceId);
    expect(instance?.status).toBe("completed");
    expect(secondStepMetadata).toEqual({ id: "abc-123" });
  });
});
