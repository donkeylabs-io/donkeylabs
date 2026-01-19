/**
 * Demo Router - Showcases @donkeylabs/server core features
 *
 * Routes delegate to the demo plugin service which handles
 * the core service integrations with proper types.
 */

import { createRouter, defineRoute } from "@donkeylabs/server";
import { z } from "zod";

const demo = createRouter("api");

// =============================================================================
// COUNTER - Uses plugin service for state
// =============================================================================

demo.route("counter.get").typed(
  defineRoute({
    output: z.object({ count: z.number() }),
    handle: async (_, ctx) => {
      return { count: ctx.plugins.demo.getCounter() };
    },
  })
);

demo.route("counter.increment").typed(
  defineRoute({
    output: z.object({ count: z.number() }),
    handle: async (_, ctx) => {
      return { count: ctx.plugins.demo.increment() };
    },
  })
);

demo.route("counter.decrement").typed(
  defineRoute({
    output: z.object({ count: z.number() }),
    handle: async (_, ctx) => {
      return { count: ctx.plugins.demo.decrement() };
    },
  })
);

demo.route("counter.reset").typed(
  defineRoute({
    output: z.object({ count: z.number() }),
    handle: async (_, ctx) => {
      return { count: ctx.plugins.demo.reset() };
    },
  })
);

// =============================================================================
// CACHE - In-memory caching (via plugin service)
// =============================================================================

demo.route("cache.set").typed(
  defineRoute({
    input: z.object({
      key: z.string(),
      value: z.any(),
      ttl: z.number().optional(),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      return ctx.plugins.demo.cacheSet(input.key, input.value, input.ttl);
    },
  })
);

demo.route("cache.get").typed(
  defineRoute({
    input: z.object({ key: z.string() }),
    output: z.object({ value: z.any().optional(), exists: z.boolean() }),
    handle: async (input, ctx) => {
      return ctx.plugins.demo.cacheGet(input.key);
    },
  })
);

demo.route("cache.delete").typed(
  defineRoute({
    input: z.object({ key: z.string() }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      return ctx.plugins.demo.cacheDelete(input.key);
    },
  })
);

demo.route("cache.keys").typed(
  defineRoute({
    output: z.object({ keys: z.array(z.string()), size: z.number() }),
    handle: async (_, ctx) => {
      return ctx.plugins.demo.cacheKeys();
    },
  })
);

// =============================================================================
// SSE - Server-Sent Events (via plugin service)
// =============================================================================

demo.route("sse.broadcast").typed(
  defineRoute({
    input: z.object({
      channel: z.string().default("events"),
      event: z.string().default("manual"),
      data: z.any(),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      const channel = input.channel ?? "events";
      const event = input.event ?? "manual";
      return ctx.plugins.demo.broadcast(channel, event, input.data);
    },
  })
);

demo.route("sse.clients").typed(
  defineRoute({
    output: z.object({ total: z.number(), byChannel: z.number() }),
    handle: async (_, ctx) => {
      return ctx.plugins.demo.getSSEClients();
    },
  })
);

// =============================================================================
// JOBS - Background job queue (via plugin service)
// =============================================================================

demo.route("jobs.enqueue").typed(
  defineRoute({
    input: z.object({
      name: z.string().default("demo-job"),
      data: z.record(z.any()).optional(),
      delay: z.number().optional(),
    }),
    output: z.object({ jobId: z.string() }),
    handle: async (input, ctx) => {
      const name = input.name ?? "demo-job";
      return ctx.plugins.demo.enqueueJob(name, input.data || {}, input.delay);
    },
  })
);

demo.route("jobs.stats").typed(
  defineRoute({
    output: z.object({
      pending: z.number(),
      running: z.number(),
      completed: z.number(),
    }),
    handle: async (_, ctx) => {
      return ctx.plugins.demo.getJobStats();
    },
  })
);

// =============================================================================
// EVENTS - Pub/sub system (via plugin service)
// =============================================================================

demo.route("events.emit").typed(
  defineRoute({
    input: z.object({
      event: z.string(),
      data: z.record(z.any()).optional(),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      return ctx.plugins.demo.emitEvent(input.event, input.data || {});
    },
  })
);

// =============================================================================
// RATE LIMITING (via plugin service)
// =============================================================================

demo.route("ratelimit.check").typed(
  defineRoute({
    input: z.object({
      key: z.string(),
      limit: z.number().default(10),
      window: z.number().default(60),
    }),
    output: z.object({
      allowed: z.boolean(),
      remaining: z.number(),
      limit: z.number(),
      resetAt: z.date(),
    }),
    handle: async (input, ctx) => {
      const limit = input.limit ?? 10;
      const window = input.window ?? 60;
      return ctx.plugins.demo.checkRateLimit(input.key, limit, window * 1000);
    },
  })
);

demo.route("ratelimit.reset").typed(
  defineRoute({
    input: z.object({ key: z.string() }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      return ctx.plugins.demo.resetRateLimit(input.key);
    },
  })
);

// =============================================================================
// CRON - Scheduled tasks info (via plugin service)
// =============================================================================

demo.route("cron.list").typed(
  defineRoute({
    output: z.object({
      tasks: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          expression: z.string(),
          enabled: z.boolean(),
          lastRun: z.string().optional(),
          nextRun: z.string().optional(),
        })
      ),
    }),
    handle: async (_, ctx) => {
      return { tasks: ctx.plugins.demo.getCronTasks() };
    },
  })
);

// =============================================================================
// WORKFLOWS - Step function orchestration (via workflowDemo plugin)
// =============================================================================

demo.route("workflow.start").typed(
  defineRoute({
    input: z.object({
      orderId: z.string().default(() => `ORD-${Date.now().toString(36).toUpperCase()}`),
      items: z
        .array(z.object({ name: z.string(), qty: z.number() }))
        .default([
          { name: "Widget A", qty: 2 },
          { name: "Gadget B", qty: 1 },
        ]),
      customerEmail: z.string().email().default("demo@example.com"),
    }),
    output: z.object({ instanceId: z.string() }),
    handle: async (input, ctx) => {
      return ctx.plugins.workflowDemo.startOrder({
        orderId: input.orderId ?? `ORD-${Date.now().toString(36).toUpperCase()}`,
        items: input.items ?? [
          { name: "Widget A", qty: 2 },
          { name: "Gadget B", qty: 1 },
        ],
        customerEmail: input.customerEmail ?? "demo@example.com",
      });
    },
  })
);

demo.route("workflow.status").typed(
  defineRoute({
    input: z.object({ instanceId: z.string() }),
    output: z.object({
      id: z.string(),
      status: z.string(),
      currentStep: z.string().optional(),
      input: z.any(),
      output: z.any().optional(),
      error: z.string().optional(),
      stepResults: z.record(z.any()),
      createdAt: z.string(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
    }).nullable(),
    handle: async (input, ctx) => {
      return ctx.plugins.workflowDemo.getStatus(input.instanceId);
    },
  })
);

demo.route("workflow.list").typed(
  defineRoute({
    input: z.object({ status: z.string().optional() }),
    output: z.object({
      instances: z.array(
        z.object({
          id: z.string(),
          status: z.string(),
          currentStep: z.string().optional(),
          createdAt: z.string(),
          completedAt: z.string().optional(),
        })
      ),
    }),
    handle: async (input, ctx) => {
      const instances = await ctx.plugins.workflowDemo.listInstances(input.status);
      return { instances };
    },
  })
);

demo.route("workflow.cancel").typed(
  defineRoute({
    input: z.object({ instanceId: z.string() }),
    output: z.object({ success: z.boolean() }),
    handle: async (input, ctx) => {
      return ctx.plugins.workflowDemo.cancel(input.instanceId);
    },
  })
);

export default demo;
