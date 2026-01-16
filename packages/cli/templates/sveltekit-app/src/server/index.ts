// Server entry for @donkeylabs/adapter-sveltekit
import { AppServer, createRouter } from "@donkeylabs/server";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { demoPlugin } from "./plugins/demo";

// Simple in-memory database
const db = new Kysely<{}>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

// Create server
export const server = new AppServer({
  db,
  port: 0, // Port managed by adapter
});

server.registerPlugin(demoPlugin);


// Create routes
const api = createRouter("api");

// Counter routes
api.route("counter.get").typed({
  output: z.object({ count: z.number() }),
  handle: async (_input, ctx) => ({ count: ctx.plugins.demo.getCounter() }),
});

api.route("counter.increment").typed({
  output: z.object({ count: z.number() }),
  handle: async (_input, ctx) => ({ count: ctx.plugins.demo.increment() }),
});

api.route("counter.decrement").typed({
  output: z.object({ count: z.number() }),
  handle: async (_input, ctx) => ({ count: ctx.plugins.demo.decrement() }),
});

api.route("counter.reset").typed({
  output: z.object({ count: z.number() }),
  handle: async (_input, ctx) => ({ count: ctx.plugins.demo.reset() }),
});

// Cache routes
api.route("cache.set").typed({
  input: z.object({
    key: z.string(),
    value: z.any(),
    ttl: z.number().optional()
  }),
  output: z.object({ success: z.boolean() }),
  handle: async (input, ctx) => ctx.plugins.demo.cacheSet(input.key, input.value, input.ttl),
});

api.route("cache.get").typed({
  input: z.object({ key: z.string() }),
  output: z.object({ value: z.any().optional(), exists: z.boolean() }),
  handle: async (input, ctx) => ctx.plugins.demo.cacheGet(input.key),
});

api.route("cache.delete").typed({
  input: z.object({ key: z.string() }),
  output: z.object({ success: z.boolean() }),
  handle: async (input, ctx) => ctx.plugins.demo.cacheDelete(input.key),
});

api.route("cache.keys").typed({
  output: z.object({ keys: z.array(z.string()) }),
  handle: async (_input, ctx) => ctx.plugins.demo.cacheKeys(),
});

// Jobs routes
api.route("jobs.enqueue").typed({
  input: z.object({
    name: z.string().default("demo-job"),
    data: z.any().default({}),
    delay: z.number().optional()
  }),
  output: z.object({ jobId: z.string() }),
  handle: async (input, ctx) => ctx.plugins.demo.enqueueJob(input.name!, input.data, input.delay),
});

api.route("jobs.stats").typed({
  output: z.object({ pending: z.number(), running: z.number(), completed: z.number() }),
  handle: async (_input, ctx) => ctx.plugins.demo.getJobStats(),
});

// Cron routes
api.route("cron.list").typed({
  output: z.object({ tasks: z.array(z.object({
    id: z.string(),
    name: z.string(),
    expression: z.string(),
    enabled: z.boolean(),
    lastRun: z.string().optional(),
    nextRun: z.string().optional()
  })) }),
  handle: async (_input, ctx) => ({ tasks: ctx.plugins.demo.getCronTasks() }),
});

// Rate limiter routes
api.route("ratelimit.check").typed({
  input: z.object({
    key: z.string().default("demo"),
    limit: z.number().default(5),
    window: z.number().default(60000)
  }),
  output: z.object({ allowed: z.boolean(), remaining: z.number(), resetAt: z.date() }),
  handle: async (input, ctx) => ctx.plugins.demo.checkRateLimit(input.key!, input.limit!, input.window!),
});

api.route("ratelimit.reset").typed({
  input: z.object({ key: z.string().default("demo") }),
  output: z.object({ success: z.boolean() }),
  handle: async (input, ctx) => ctx.plugins.demo.resetRateLimit(input.key!),
});

// Events routes (internal pub/sub)
api.route("events.emit").typed({
  input: z.object({
    event: z.string().default("demo.test"),
    data: z.any().default({ test: true })
  }),
  output: z.object({ success: z.boolean() }),
  handle: async (input, ctx) => ctx.plugins.demo.emitEvent(input.event!, input.data),
});

// SSE routes
api.route("sseRoutes.broadcast").typed({
  input: z.object({
    channel: z.string().default("events"),
    event: z.string().default("manual"),
    data: z.any()
  }),
  output: z.object({ success: z.boolean(), recipients: z.number() }),
  handle: async (input, ctx) => ctx.plugins.demo.broadcast(input.channel!, input.event!, input.data),
});

api.route("sseRoutes.clients").typed({
  output: z.object({ total: z.number(), byChannel: z.number() }),
  handle: async (_input, ctx) => ctx.plugins.demo.getSSEClients(),
});


// Register plugin and routes
server.use(api);

// Handle DONKEYLABS_GENERATE for type generation
if (process.env.DONKEYLABS_GENERATE === "1") {
  // Extract routes and output as JSON for CLI
  const routes = api.getRoutes().map((r) => ({
    name: r.name,
    handler: r.handler || "typed",
  }));
  console.log(JSON.stringify({ routes }));
  process.exit(0);
}
