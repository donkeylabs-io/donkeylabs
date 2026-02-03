/**
 * Simple test server to verify admin dashboard
 * Run with: bun run packages/server/test-admin.ts
 */

import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import Database from "bun:sqlite";
import { AppServer, createRouter, defineRoute } from "./src/index";
import { z } from "zod";

// Create in-memory database
const db = new Kysely<any>({
  dialect: new BunSqliteDialect({
    database: new Database(":memory:"),
  }),
});

// Create a simple test router
const apiRouter = createRouter("api");

apiRouter.route("health").typed(
  defineRoute({
    input: z.object({}),
    output: z.object({ status: z.string(), timestamp: z.string() }),
    handle: async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
    }),
  })
);

apiRouter.route("echo").typed(
  defineRoute({
    input: z.object({ message: z.string() }),
    output: z.object({ echo: z.string() }),
    handle: async ({ message }) => ({
      echo: message,
    }),
  })
);

// Create server with admin enabled
const server = new AppServer({
  port: 3000,
  db,
  admin: {
    enabled: true,
    prefix: "admin",
  },
});

// Register routes
server.use(apiRouter);

// Add some test jobs
server.onReady(async (ctx) => {
  // Register a test job handler
  ctx.core.jobs.register("test-job", async (data) => {
    console.log("Processing test job:", data);
    await new Promise((r) => setTimeout(r, 1000));
    return { processed: true };
  });

  // Enqueue some test jobs
  await ctx.core.jobs.enqueue("test-job", { id: 1 });
  await ctx.core.jobs.enqueue("test-job", { id: 2 });
  await ctx.core.jobs.enqueue("test-job", { id: 3 });

  console.log("\n===========================================");
  console.log("Test server running!");
  console.log("===========================================");
  console.log("\nAdmin Dashboard: http://localhost:3000/admin.dashboard");
  console.log("API Health:      http://localhost:3000/api.health");
  console.log("\nPress Ctrl+C to stop");
  console.log("===========================================\n");
});

// Start the server
await server.start();
server.enableGracefulShutdown();
