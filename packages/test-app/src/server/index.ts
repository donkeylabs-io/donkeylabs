// Server entry for @donkeylabs/adapter-sveltekit
import { AppServer, createPlugin, createRouter } from "@donkeylabs/server";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { z } from "zod";

// Simple in-memory database
const db = new Kysely<{}>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

// Random event messages for SSE demo
const eventMessages = [
  "User logged in",
  "New order placed",
  "Payment received",
  "Item shipped",
  "Review submitted",
  "Comment added",
  "File uploaded",
  "Task completed",
  "Alert triggered",
  "Sync finished",
];

// Demo plugin with all core service integrations
const demoPlugin = createPlugin.define({
  name: "demo",
  service: async (ctx) => {
    let counter = 0;

    return {
      // Counter
      getCounter: () => counter,
      increment: () => ++counter,
      decrement: () => --counter,
      reset: () => { counter = 0; return counter; },

      // Cache helpers
      cacheSet: async (key: string, value: any, ttl?: number) => {
        await ctx.core.cache.set(key, value, ttl);
        return { success: true };
      },
      cacheGet: async (key: string) => {
        const value = await ctx.core.cache.get(key);
        const exists = await ctx.core.cache.has(key);
        return { value, exists };
      },
      cacheDelete: async (key: string) => {
        await ctx.core.cache.delete(key);
        return { success: true };
      },
      cacheKeys: async () => {
        const keys = await ctx.core.cache.keys();
        return { keys, size: keys.length };
      },

      // Jobs helpers
      enqueueJob: async (name: string, data: any, delay?: number) => {
        let jobId: string;
        if (delay && delay > 0) {
          const runAt = new Date(Date.now() + delay);
          jobId = await ctx.core.jobs.schedule(name, data, runAt);
        } else {
          jobId = await ctx.core.jobs.enqueue(name, data);
        }
        return { jobId };
      },
      getJobStats: async () => {
        const pending = await ctx.core.jobs.getByName("demo-job", "pending");
        const running = await ctx.core.jobs.getByName("demo-job", "running");
        const completed = await ctx.core.jobs.getByName("demo-job", "completed");
        return {
          pending: pending.length,
          running: running.length,
          completed: completed.length,
        };
      },

      // Cron helpers
      getCronTasks: () => ctx.core.cron.list().map(t => ({
        id: t.id,
        name: t.name,
        expression: t.expression,
        enabled: t.enabled,
        lastRun: t.lastRun?.toISOString(),
        nextRun: t.nextRun?.toISOString(),
      })),

      // Rate limiter helpers
      checkRateLimit: async (key: string, limit: number, window: number) => {
        return ctx.core.rateLimiter.check(key, limit, window);
      },
      resetRateLimit: async (key: string) => {
        await ctx.core.rateLimiter.reset(key);
        return { success: true };
      },

      // Events helpers (internal pub/sub)
      emitEvent: async (event: string, data: any) => {
        await ctx.core.events.emit(event, data);
        return { success: true };
      },

      // SSE broadcast
      broadcast: (channel: string, event: string, data: any) => {
        ctx.core.sse.broadcast(channel, event, data);
        return { success: true };
      },
      getSSEClients: () => ({
        total: ctx.core.sse.getClients().length,
        byChannel: ctx.core.sse.getClientsByChannel("events").length,
      }),
    };
  },
  init: async (ctx) => {
    // Register job handler for demo
    ctx.core.jobs.register("demo-job", async (data) => {
      ctx.core.logger.info("Demo job executed", { data });
      // Broadcast job completion via SSE
      ctx.core.sse.broadcast("events", "job-completed", {
        id: Date.now(),
        message: `Job completed: ${data.message || "No message"}`,
        timestamp: new Date().toISOString(),
      });
    });

    // Schedule cron job to broadcast SSE events every 5 seconds
    ctx.core.cron.schedule("*/5 * * * * *", () => {
      const message = eventMessages[Math.floor(Math.random() * eventMessages.length)];
      ctx.core.sse.broadcast("events", "cron-event", {
        id: Date.now(),
        message,
        timestamp: new Date().toISOString(),
        source: "cron",
      });
    }, { name: "sse-broadcaster" });

    // Listen for internal events and broadcast to SSE
    ctx.core.events.on("demo.*", (data) => {
      ctx.core.sse.broadcast("events", "internal-event", {
        id: Date.now(),
        message: `Internal event: ${JSON.stringify(data)}`,
        timestamp: new Date().toISOString(),
        source: "events",
      });
    });

    ctx.core.logger.info("Demo plugin initialized with all core services");
  },
});

// Create routes
const api = createRouter("api");

// Counter routes
api.route("counter.get").typed({
  handle: async (_input, ctx) => ({ count: ctx.plugins.demo.getCounter() }),
});

api.route("counter.increment").typed({
  handle: async (_input, ctx) => ({ count: ctx.plugins.demo.increment() }),
});

api.route("counter.decrement").typed({
  handle: async (_input, ctx) => ({ count: ctx.plugins.demo.decrement() }),
});

api.route("counter.reset").typed({
  handle: async (_input, ctx) => ({ count: ctx.plugins.demo.reset() }),
});

// Cache routes
api.route("cache.set").typed({
  input: z.object({
    key: z.string(),
    value: z.any(),
    ttl: z.number().optional()
  }),
  handle: async (input, ctx) => ctx.plugins.demo.cacheSet(input.key, input.value, input.ttl),
});

api.route("cache.get").typed({
  input: z.object({ key: z.string() }),
  handle: async (input, ctx) => ctx.plugins.demo.cacheGet(input.key),
});

api.route("cache.delete").typed({
  input: z.object({ key: z.string() }),
  handle: async (input, ctx) => ctx.plugins.demo.cacheDelete(input.key),
});

api.route("cache.keys").typed({
  handle: async (_input, ctx) => ctx.plugins.demo.cacheKeys(),
});

// Jobs routes
api.route("jobs.enqueue").typed({
  input: z.object({
    name: z.string().default("demo-job"),
    data: z.any().default({}),
    delay: z.number().optional()
  }),
  handle: async (input, ctx) => ctx.plugins.demo.enqueueJob(input.name, input.data, input.delay),
});

api.route("jobs.stats").typed({
  handle: async (_input, ctx) => ctx.plugins.demo.getJobStats(),
});

// Cron routes
api.route("cron.list").typed({
  handle: async (_input, ctx) => ({ tasks: ctx.plugins.demo.getCronTasks() }),
});

// Rate limiter routes
api.route("ratelimit.check").typed({
  input: z.object({
    key: z.string().default("demo"),
    limit: z.number().default(5),
    window: z.number().default(60000)
  }),
  handle: async (input, ctx) => ctx.plugins.demo.checkRateLimit(input.key, input.limit, input.window),
});

api.route("ratelimit.reset").typed({
  input: z.object({ key: z.string().default("demo") }),
  handle: async (input, ctx) => ctx.plugins.demo.resetRateLimit(input.key),
});

// Events routes (internal pub/sub)
api.route("events.emit").typed({
  input: z.object({
    event: z.string().default("demo.test"),
    data: z.any().default({ test: true })
  }),
  handle: async (input, ctx) => ctx.plugins.demo.emitEvent(input.event, input.data),
});

// SSE routes
api.route("sse.broadcast").typed({
  input: z.object({
    channel: z.string().default("events"),
    event: z.string().default("manual"),
    data: z.any()
  }),
  handle: async (input, ctx) => ctx.plugins.demo.broadcast(input.channel, input.event, input.data),
});

api.route("sse.clients").typed({
  handle: async (_input, ctx) => ctx.plugins.demo.getSSEClients(),
});

// Create server
export const server = new AppServer({
  db,
  port: 0, // Port managed by adapter
});

// Register plugin and routes
server.registerPlugin(demoPlugin);
server.use(api);
