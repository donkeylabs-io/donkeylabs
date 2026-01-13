/**
 * Basic Server Example
 *
 * This example demonstrates how to use @donkeylabs/server with plugins.
 */

import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { AppServer, createRouter } from "@donkeylabs/server";
import { z } from "zod";

// Import plugins
import { authPlugin } from "./plugins/auth";
import { counterPlugin } from "./plugins/counter";
import { statsPlugin } from "./plugins/stats";

// Setup Database
const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

// Create Server
const server = new AppServer({
  port: 3000,
  db,
  config: { env: "development" },
});

// Register Plugins
server.registerPlugin(
  authPlugin({
    privateKey: "super-secret-key",
    tokenExpiry: 3600,
    issuer: "example-app",
  })
);
server.registerPlugin(counterPlugin);
server.registerPlugin(statsPlugin); // Depends on counter

// Define Routes
const router = createRouter("api")
  .route("counter.increment")
  .typed({
    input: z.object({ name: z.string() }),
    output: z.object({ value: z.number() }),
    handle: async (input, ctx) => {
      const value = await ctx.plugins.counter.increment(input.name);
      return { value };
    },
  })
  .route("counter.get")
  .typed({
    input: z.object({ name: z.string() }),
    output: z.object({ value: z.number() }),
    handle: async (input, ctx) => {
      const value = await ctx.plugins.counter.get(input.name);
      return { value };
    },
  })
  .route("stats.snapshot")
  .typed({
    input: z.object({ counterName: z.string() }),
    output: z.object({ value: z.number() }),
    handle: async (input, ctx) => {
      const value = await ctx.plugins.stats.takeSnapshot(input.counterName);
      return { value };
    },
  })
  .route("stats.summary")
  .typed({
    input: z.object({}),
    output: z.object({
      totalCounters: z.number(),
      totalSnapshots: z.number(),
    }),
    handle: async (_input, ctx) => {
      return ctx.plugins.stats.summary();
    },
  });

server.use(router);

// Start Server
await server.start();
