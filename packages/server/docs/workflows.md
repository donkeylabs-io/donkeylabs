# Workflows

Workflows provide step function / state machine orchestration for complex multi-step processes. Workflows support sequential tasks with inline handlers, parallel execution, conditional branching, retries, and real-time progress via SSE.

## Overview

Use workflows when you need to:
- Orchestrate multi-step processes (order processing, onboarding, data pipelines)
- Run steps in parallel and wait for all to complete
- Make decisions based on previous step outputs
- Track progress across long-running processes
- Automatically retry failed steps with backoff

## Quick Start

### 1. Define a Workflow

```typescript
import { workflow } from "@donkeylabs/server";
import { z } from "zod";

const orderWorkflow = workflow("process-order")
  // First task: inputSchema validates workflow input
  .task("validate", {
    inputSchema: z.object({ orderId: z.string() }),
    outputSchema: z.object({ valid: z.boolean(), inStock: z.boolean(), total: z.number() }),
    handler: async (input, ctx) => {
      const order = await ctx.plugins.orders.validate(input.orderId);
      return { valid: true, inStock: order.inStock, total: order.total };
    },
  })
  .choice("check-inventory", {
    choices: [
      {
        condition: (ctx) => ctx.steps.validate.inStock,
        next: "fulfill",
      },
    ],
    default: "backorder",
  })
  .parallel("fulfill", {
    branches: [
      workflow.branch("shipping")
        .task("ship", {
          // inputSchema as function: maps previous step output to this step's input
          inputSchema: (prev) => ({ orderId: prev.orderId }),
          handler: async (input, ctx) => {
            return await ctx.plugins.shipping.createShipment(input.orderId);
          },
        })
        .build(),
      workflow.branch("notification")
        .task("notify", {
          inputSchema: (prev, workflowInput) => ({
            orderId: workflowInput.orderId,
            total: prev.total,
          }),
          handler: async (input, ctx) => {
            await ctx.plugins.email.sendConfirmation(input);
            return { sent: true };
          },
        })
        .build(),
    ],
    next: "complete",
  })
  // Subsequent tasks: inputSchema as function receives prev step output
  .task("backorder", {
    inputSchema: (prev) => ({ orderId: prev.orderId, total: prev.total }),
    handler: async (input, ctx) => {
      return await ctx.plugins.orders.createBackorder(input);
    },
    next: "complete",
  })
  .pass("complete", { end: true })
  .build();
```

### 2. Register and Start

```typescript
// Register the workflow
ctx.core.workflows.register(orderWorkflow);

// Start an instance
const instanceId = await ctx.core.workflows.start("process-order", {
  orderId: "ORD-123",
  customerId: "CUST-456",
});
```

### 3. Track Progress

```typescript
// Via Events
ctx.core.events.on("workflow.progress", (data) => {
  console.log(`${data.workflowName}: ${data.progress}%`);
});

// Via SSE (client subscribes to workflow:${instanceId})
ctx.core.events.on("workflow.progress", (data) => {
  ctx.core.sse.broadcast(`workflow:${data.instanceId}`, "progress", data);
});
```

## Step Types

### Task

Executes an inline handler function with typed input/output.

```typescript
workflow("example")
  .task("step-name", {
    // Input: Zod schema (for first step) OR mapper function (for subsequent steps)
    // First step - validates workflow input:
    inputSchema: z.object({ orderId: z.string() }),
    // Subsequent steps - maps previous output to this step's input:
    // inputSchema: (prev, workflowInput) => ({ orderId: prev.orderId }),

    // Optional: Zod schema for output validation
    outputSchema: z.object({ success: z.boolean(), data: z.any() }),

    // Required: inline handler function
    handler: async (input, ctx) => {
      // input is typed from inputSchema
      // ctx provides access to plugins, prev, steps, etc.
      return { success: true, data: await processOrder(input.orderId) };
    },

    // Optional: retry configuration
    retry: {
      maxAttempts: 3,
      intervalMs: 1000,
      backoffRate: 2,
      maxIntervalMs: 30000,
    },

    // Optional: step timeout in ms
    timeout: 60000,

    // Control flow (one of these)
    next: "next-step",  // Go to specific step
    end: true,          // End workflow (mutually exclusive with next)
  })
```

#### Input Schema Options

**Option 1: Zod Schema (first step or when validating workflow input)**
```typescript
.task("validate", {
  inputSchema: z.object({ orderId: z.string(), userId: z.string() }),
  handler: async (input, ctx) => {
    // input: { orderId: string, userId: string } - validated from workflow input
    return { valid: true };
  },
})
```

**Option 2: Mapper Function (subsequent steps)**
```typescript
.task("charge", {
  // prev = output from previous step, workflowInput = original workflow input
  inputSchema: (prev, workflowInput) => ({
    amount: prev.total,
    userId: workflowInput.userId,
  }),
  handler: async (input, ctx) => {
    // input: { amount: number, userId: string } - inferred from mapper return
    return { chargeId: "ch_123" };
  },
})
```

#### Legacy API (Job-based)

For backward compatibility, you can still use job references:

```typescript
workflow("example")
  .task("step-name", {
    // Job name to execute
    job: "my-job-name",

    // Optional: transform workflow context to job input
    input: (ctx) => ({
      orderId: ctx.input.orderId,
      previousResult: ctx.steps.previousStep,
    }),

    // Optional: transform job result to step output
    output: (result, ctx) => ({
      processed: true,
      data: result.data,
    }),
  })
```

### Parallel

Runs multiple workflow branches concurrently.

```typescript
workflow("example")
  .parallel("parallel-step", {
    // Required: branches to execute
    branches: [
      workflow.branch("branch-a")
        .task("task-a1", { job: "job-a1" })
        .task("task-a2", { job: "job-a2" })
        .build(),

      workflow.branch("branch-b")
        .task("task-b1", { job: "job-b1" })
        .build(),
    ],

    // Optional: error handling
    onError: "fail-fast", // Stop all on first error (default)
    // onError: "wait-all", // Wait for all branches, collect errors

    // Control flow
    next: "next-step",
  })
```

The output of a parallel step is an object with each branch's output:

```typescript
{
  "branch-a": { /* branch-a output */ },
  "branch-b": { /* branch-b output */ }
}
```

### Choice

Conditional branching based on workflow context.

```typescript
workflow("example")
  .choice("decision-point", {
    // Evaluated in order, first match wins
    choices: [
      {
        condition: (ctx) => ctx.steps.validate.amount > 1000,
        next: "large-order-flow",
      },
      {
        condition: (ctx) => ctx.steps.validate.isPriority,
        next: "priority-flow",
      },
    ],

    // Fallback if no conditions match
    default: "standard-flow",
  })
```

### Pass

Transform data or create a no-op step.

```typescript
workflow("example")
  // Transform data
  .pass("transform", {
    transform: (ctx) => ({
      summary: {
        input: ctx.input,
        results: ctx.steps,
      },
    }),
    next: "next-step",
  })

  // Static result
  .pass("static", {
    result: { status: "initialized" },
    next: "next-step",
  })

  // End marker (shorthand)
  .end("done")
```

## Workflow Context

Every step receives a `WorkflowContext` with:

```typescript
interface WorkflowContext {
  /** Original workflow input */
  input: any;

  /** Results from completed steps (keyed by step name) */
  steps: Record<string, any>;

  /** Output from the previous step (undefined for first step) */
  prev?: any;

  /** Current workflow instance */
  instance: WorkflowInstance;

  /** Type-safe step result getter */
  getStepResult<T>(stepName: string): T | undefined;

  /** Core services (logger, events, cache, jobs, sse, etc.) */
  core: CoreServices;

  /** Plugin services - access your plugins' service methods */
  plugins: Record<string, any>;

  /** Custom metadata that persists across steps (read-only snapshot) */
  metadata: Record<string, any>;

  /** Set a metadata value that persists across workflow steps */
  setMetadata(key: string, value: any): Promise<void>;

  /** Get a typed metadata value */
  getMetadata<T>(key: string): T | undefined;
}
```

Example usage in step configuration:

```typescript
// Using inputSchema mapper function (recommended)
.task("process", {
  inputSchema: (prev, workflowInput) => ({
    orderId: workflowInput.orderId,
    validationResult: prev,  // prev = output from previous step
  }),
  handler: async (input, ctx) => {
    // Access any step's output
    const calcResult = ctx.getStepResult<{ amount: number }>("calculate");

    // Access plugin services
    const order = await ctx.plugins.orders.getById(input.orderId);

    // Use core services
    ctx.core.logger.info("Processing order", { orderId: input.orderId });

    return { processed: true, amount: calcResult?.amount };
  },
})
```

### Cross-Step Metadata

Use metadata to share data across workflow steps that isn't part of the normal step output flow:

```typescript
.task("validate", {
  inputSchema: z.object({ orderId: z.string() }),
  handler: async (input, ctx) => {
    // Store correlation ID for logging/tracing across steps
    await ctx.setMetadata("correlationId", crypto.randomUUID());

    // Store complex context that multiple steps need
    await ctx.setMetadata("orderContext", {
      customer: await ctx.plugins.customers.getByOrder(input.orderId),
      flags: { expedited: false, giftWrap: false },
    });

    return { valid: true };
  },
})
.task("fulfill", {
  handler: async (input, ctx) => {
    // Read metadata from previous steps
    const correlationId = ctx.getMetadata<string>("correlationId");
    const orderCtx = ctx.getMetadata<{ customer: Customer; flags: object }>("orderContext");

    ctx.core.logger.info("Fulfilling order", { correlationId, customer: orderCtx?.customer.id });

    // Update metadata for downstream steps
    await ctx.setMetadata("orderContext", {
      ...orderCtx,
      flags: { ...orderCtx?.flags, fulfilled: true },
    });

    return { shipped: true };
  },
})
```

Metadata is persisted to the database and survives server restarts.

## Retry Configuration

Configure retries at the step level or set defaults for the entire workflow:

```typescript
// Default retry for all steps
workflow("example")
  .defaultRetry({
    maxAttempts: 3,
    intervalMs: 1000,
    backoffRate: 2,
    maxIntervalMs: 30000,
  })
  .task("step1", { job: "job1" }) // Uses default
  .task("step2", {
    job: "job2",
    retry: { maxAttempts: 5 }, // Override
  })
```

Retry parameters:
- `maxAttempts`: Maximum retry attempts (including first try)
- `intervalMs`: Initial delay between retries (default: 1000)
- `backoffRate`: Multiplier for each retry (default: 2)
- `maxIntervalMs`: Maximum delay cap (default: 30000)
- `retryOn`: Array of error messages to retry on (default: all errors)

## Workflow Timeout

Set a timeout for the entire workflow:

```typescript
workflow("example")
  .timeout(3600000) // 1 hour max
  .task("step1", { job: "job1" })
  .task("step2", { job: "job2" })
  .build();
```

## Events

Workflows emit events at key points:

| Event | Data | Description |
|-------|------|-------------|
| `workflow.started` | `{ instanceId, workflowName, input }` | Workflow started |
| `workflow.progress` | `{ instanceId, workflowName, progress, currentStep, completedSteps, totalSteps }` | Progress update |
| `workflow.completed` | `{ instanceId, workflowName, output }` | Workflow completed |
| `workflow.failed` | `{ instanceId, workflowName, error }` | Workflow failed |
| `workflow.cancelled` | `{ instanceId, workflowName }` | Workflow cancelled |
| `workflow.step.started` | `{ instanceId, workflowName, stepName, stepType }` | Step started |
| `workflow.step.completed` | `{ instanceId, workflowName, stepName, output }` | Step completed |
| `workflow.step.failed` | `{ instanceId, workflowName, stepName, error, attempts }` | Step failed |
| `workflow.step.retry` | `{ instanceId, workflowName, stepName, attempt, maxAttempts, delay, error }` | Step retrying |

### Example: SSE Progress Broadcasting

```typescript
// Broadcast all workflow events to SSE
const workflowEvents = [
  "workflow.progress",
  "workflow.completed",
  "workflow.failed",
  "workflow.step.started",
  "workflow.step.completed",
];

for (const event of workflowEvents) {
  ctx.core.events.on(event, (data) => {
    ctx.core.sse.broadcast(`workflow:${data.instanceId}`, event, data);
  });
}
```

## API Reference

### Workflows Service

```typescript
interface Workflows {
  /** Register a workflow definition */
  register(definition: WorkflowDefinition): void;

  /** Start a new workflow instance */
  start<T = any>(workflowName: string, input: T): Promise<string>;

  /** Get a workflow instance by ID */
  getInstance(instanceId: string): Promise<WorkflowInstance | null>;

  /** Cancel a running workflow */
  cancel(instanceId: string): Promise<boolean>;

  /** Get all instances of a workflow */
  getInstances(workflowName: string, status?: WorkflowStatus): Promise<WorkflowInstance[]>;

  /** Resume workflows after server restart */
  resume(): Promise<void>;

  /** Stop the workflow service */
  stop(): Promise<void>;
}
```

### Workflow Instance

```typescript
interface WorkflowInstance {
  id: string;
  workflowName: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
  currentStep?: string;
  input: any;
  output?: any;
  error?: string;
  stepResults: Record<string, StepResult>;
  /** Custom metadata that persists across steps */
  metadata?: Record<string, any>;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

interface StepResult {
  stepName: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  input?: any;
  output?: any;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  attempts: number;
}
```

## Persistence

By default, workflows use a **Kysely database adapter** that stores workflow instances in the same database as your application. This provides automatic persistence and restart resilience.

The framework automatically creates and manages the `__donkeylabs_workflow_instances__` table with proper migrations.

### Built-in Kysely Adapter

The `KyselyWorkflowAdapter` is automatically configured when you provide a database connection:

```typescript
const server = new AppServer({
  db: createDatabase(),  // Workflows will automatically persist to this database
  workflows: {
    pollInterval: 1000,     // How often to check job completion
    cleanupDays: 30,        // Auto-cleanup completed workflows older than 30 days (0 to disable)
    cleanupInterval: 3600000, // Cleanup check interval (default: 1 hour)
  },
});
```

### Custom Adapter

For custom storage backends, implement the `WorkflowAdapter` interface:

```typescript
interface WorkflowAdapter {
  createInstance(instance: Omit<WorkflowInstance, "id">): Promise<WorkflowInstance>;
  getInstance(instanceId: string): Promise<WorkflowInstance | null>;
  updateInstance(instanceId: string, updates: Partial<WorkflowInstance>): Promise<void>;
  deleteInstance(instanceId: string): Promise<boolean>;
  getInstancesByWorkflow(workflowName: string, status?: WorkflowStatus): Promise<WorkflowInstance[]>;
  getRunningInstances(): Promise<WorkflowInstance[]>;
  getAllInstances(options?: GetAllWorkflowsOptions): Promise<WorkflowInstance[]>;
}
```

Configure via `ServerConfig`:

```typescript
const server = new AppServer({
  db: createDatabase(),
  workflows: {
    adapter: new MyCustomWorkflowAdapter(),
    pollInterval: 1000,
  },
});
```

## Server Restart Resilience

Workflows automatically resume after server restart:

1. On startup, `workflows.resume()` is called
2. All instances with `status: "running"` are retrieved
3. Execution continues from the current step

For this to work properly:
- Use a persistent adapter (not in-memory) in production
- Jobs should be idempotent when possible
- The Jobs service must also support restart resilience

## Complete Example

```typescript
import { AppServer, workflow, createDatabase } from "@donkeylabs/server";
import { z } from "zod";

// Define workflow with inline handlers
const onboardingWorkflow = workflow("user-onboarding")
  .timeout(86400000) // 24 hour max
  .defaultRetry({ maxAttempts: 3 })

  // First step: inputSchema validates workflow input
  .task("create-account", {
    inputSchema: z.object({
      email: z.string().email(),
      name: z.string(),
      plan: z.enum(["free", "pro", "enterprise"]),
    }),
    outputSchema: z.object({ userId: z.string() }),
    handler: async (input, ctx) => {
      const user = await ctx.plugins.users.create({
        email: input.email,
        name: input.name,
      });
      return { userId: user.id };
    },
  })

  // Subsequent steps: inputSchema maps previous output
  .task("send-welcome-email", {
    inputSchema: (prev, workflowInput) => ({
      to: workflowInput.email,
      template: "welcome" as const,
      userId: prev.userId,
    }),
    handler: async (input, ctx) => {
      await ctx.plugins.email.send(input);
      return { sent: true };
    },
  })

  .choice("check-plan", {
    choices: [
      {
        condition: (ctx) => ctx.input.plan === "enterprise",
        next: "enterprise-setup",
      },
    ],
    default: "standard-setup",
  })

  .task("enterprise-setup", {
    // After a choice step, use handler to access specific step outputs
    handler: async (input, ctx) => {
      const userId = ctx.steps["create-account"].userId;
      await ctx.plugins.accounts.setupEnterprise({
        userId,
        features: ["sso", "audit-logs", "dedicated-support"],
      });
      return { setup: "enterprise", userId };
    },
    next: "complete",
  })

  .task("standard-setup", {
    handler: async (input, ctx) => {
      const userId = ctx.steps["create-account"].userId;
      await ctx.plugins.accounts.setupStandard({ userId });
      return { setup: "standard", userId };
    },
    next: "complete",
  })

  .pass("complete", {
    transform: (ctx) => ({
      userId: ctx.steps["create-account"].userId,
      plan: ctx.input.plan,
      setupComplete: true,
    }),
    end: true,
  })
  .build();

// Setup server
const server = new AppServer({ db: createDatabase() });

// Register workflow
server.getCore().workflows.register(onboardingWorkflow);

// Start workflow from a route
router.route("onboard").typed({
  input: z.object({
    email: z.string().email(),
    name: z.string(),
    plan: z.enum(["free", "pro", "enterprise"]),
  }),
  handle: async (input, ctx) => {
    const instanceId = await ctx.core.workflows.start("user-onboarding", input);
    return { instanceId };
  },
});

await server.start();
```
