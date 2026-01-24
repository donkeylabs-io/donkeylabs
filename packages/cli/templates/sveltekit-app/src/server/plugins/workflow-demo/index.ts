// Workflow Demo Plugin - Demonstrates step function orchestration
import { createPlugin, workflow, type WorkflowContext, type CoreServices } from "@donkeylabs/server";
import { z } from "zod";

// Helper to simulate async work with delay
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Input/output types for better type safety
type OrderInput = {
  orderId: string;
  items: { name: string; qty: number }[];
  customerEmail: string;
};

type ValidateOutput = { valid: boolean; total: number; itemCount: number };
type PaymentOutput = { paymentId: string; status: string };

// Define an example order processing workflow with placeholder tasks
export const orderWorkflow = workflow("process-order")
  .timeout(60000) // 1 minute max
  .defaultRetry({ maxAttempts: 2 })

  // Step 1: Validate Order
  .task("validate", {
    inputSchema: z.object({
      orderId: z.string(),
      items: z.array(z.object({ name: z.string(), qty: z.number() })),
      customerEmail: z.string().email(),
    }),
    outputSchema: z.object({
      valid: z.boolean(),
      total: z.number(),
      itemCount: z.number(),
    }),
    handler: async (input: OrderInput, ctx: { core: CoreServices }): Promise<ValidateOutput> => {
      ctx.core.logger.info("Validating order", { orderId: input.orderId });
      await sleep(1000); // Simulate validation work
      const total = input.items.reduce((sum: number, item: { qty: number }) => sum + item.qty * 10, 0);
      return { valid: true, total, itemCount: input.items.length };
    },
  })

  // Step 2: Process Payment
  .task("payment", {
    inputSchema: (prev: ValidateOutput, workflowInput: OrderInput) => ({
      orderId: workflowInput.orderId,
      amount: prev.total,
      email: workflowInput.customerEmail,
    }),
    outputSchema: z.object({
      paymentId: z.string(),
      status: z.string(),
    }),
    handler: async (input: { orderId: string; amount: number; email: string }, ctx: { core: CoreServices }): Promise<PaymentOutput> => {
      ctx.core.logger.info("Processing payment", {
        orderId: input.orderId,
        amount: input.amount,
      });
      await sleep(2000); // Simulate payment processing
      return {
        paymentId: `PAY-${Date.now().toString(36).toUpperCase()}`,
        status: "completed",
      };
    },
  })

  // Step 3: Parallel - Send Notification + Prepare Shipment
  .parallel("fulfill", {
    branches: [
      workflow
        .branch("notification")
        .task("send-email", {
          handler: async (_input: unknown, ctx: { core: CoreServices }) => {
            ctx.core.logger.info("Sending confirmation email");
            await sleep(800); // Simulate email send
            return { emailSent: true, sentAt: new Date().toISOString() };
          },
        })
        .build(),

      workflow
        .branch("shipping")
        .task("prepare-shipment", {
          handler: async (_input: unknown, ctx: { core: CoreServices }) => {
            ctx.core.logger.info("Preparing shipment");
            await sleep(1500); // Simulate shipment prep
            return {
              trackingId: `SHIP-${Date.now().toString(36).toUpperCase()}`,
              carrier: "FastShip",
              estimatedDelivery: new Date(
                Date.now() + 3 * 24 * 60 * 60 * 1000
              ).toISOString(),
            };
          },
        })
        .build(),
    ],
    next: "complete",
  })

  // Step 4: Complete
  .pass("complete", {
    transform: (ctx: WorkflowContext) => ({
      orderId: ctx.input.orderId,
      paymentId: ctx.steps["payment"].paymentId,
      // Parallel branch outputs are stored directly by branch name
      tracking: ctx.steps["fulfill"].shipping.trackingId,
      emailSent: ctx.steps["fulfill"].notification.emailSent,
      completedAt: new Date().toISOString(),
    }),
    end: true,
  })
  .build();

// Plugin that registers the workflow and provides service methods
export const workflowDemoPlugin = createPlugin.define({
  name: "workflowDemo",
  service: async (ctx) => ({
    // Start a new order processing workflow
    startOrder: async (input: {
      orderId: string;
      items: { name: string; qty: number }[];
      customerEmail: string;
    }) => {
      const instanceId = await ctx.core.workflows.start("process-order", input);
      return { instanceId };
    },

    // Get workflow instance status
    getStatus: async (instanceId: string) => {
      const instance = await ctx.core.workflows.getInstance(instanceId);
      if (!instance) return null;

      return {
        id: instance.id,
        status: instance.status,
        currentStep: instance.currentStep,
        input: instance.input,
        output: instance.output,
        error: instance.error,
        stepResults: instance.stepResults,
        createdAt: instance.createdAt.toISOString(),
        startedAt: instance.startedAt?.toISOString(),
        completedAt: instance.completedAt?.toISOString(),
      };
    },

    // List all workflow instances
    listInstances: async (status?: string) => {
      const instances = await ctx.core.workflows.getInstances(
        "process-order",
        status as any
      );
      return instances.map((i) => ({
        id: i.id,
        status: i.status,
        currentStep: i.currentStep,
        createdAt: i.createdAt.toISOString(),
        completedAt: i.completedAt?.toISOString(),
      }));
    },

    // Cancel a running workflow
    cancel: async (instanceId: string) => {
      const success = await ctx.core.workflows.cancel(instanceId);
      return { success };
    },
  }),

  init: async (ctx) => {
    // Register the workflow definition
    ctx.core.workflows.register(orderWorkflow);

    // Broadcast workflow events to SSE for real-time UI updates
    const workflowEvents = [
      "workflow.started",
      "workflow.progress",
      "workflow.completed",
      "workflow.failed",
      "workflow.cancelled",
      "workflow.step.started",
      "workflow.step.completed",
      "workflow.step.failed",
    ];

    for (const event of workflowEvents) {
      ctx.core.events.on(event, (data: any) => {
        // Broadcast to workflow-specific channel
        ctx.core.sse.broadcast(`workflow:${data.instanceId}`, event, data);

        // Also broadcast to general workflow-updates channel for the demo list
        ctx.core.sse.broadcast("workflow-updates", event, data);
      });
    }

    ctx.core.logger.info("Workflow demo plugin initialized with order workflow");
  },
});
