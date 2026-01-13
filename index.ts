/// <reference path="./registry.d.ts" />
import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { AppServer } from "./server";
import { createRouter } from "./router";
import { authPlugin } from "./plugins/auth";
import { counterPlugin } from "./plugins/counter";
import { statsPlugin } from "./plugins/stats";
import { z } from "zod";
import "./registry";

// ==========================================
// 1. Setup Database
// ==========================================

const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

// ==========================================
// 2. Create Server & Register Plugins
// ==========================================

const server = new AppServer({
  port: 3000,
  db,
  config: { env: "development" },
});

// Register plugins (call factory for plugins with config)
server.registerPlugin(authPlugin({
  privateKey: "super-secret-key-for-jwt",
  tokenExpiry: 7200,
  issuer: "my-app",
}));

server.registerPlugin(counterPlugin);
server.registerPlugin(statsPlugin); // Depends on counter

// ==========================================
// 3. Define Routes
// ==========================================

const appRouter = createRouter("api")
  .route("counter.increment").typed({
    input: z.object({ name: z.string() }),
    output: z.object({ value: z.number() }),
    handle: async (input, ctx) => {
      const value = await ctx.plugins.counter.increment(input.name);
      return { value };
    },
  })
  .route("counter.get").typed({
    input: z.object({ name: z.string() }),
    output: z.object({ value: z.number() }),
    handle: async (input, ctx) => {
      const value = await ctx.plugins.counter.get(input.name);
      return { value };
    },
  })
  .route("stats.snapshot").typed({
    input: z.object({ counterName: z.string() }),
    output: z.object({ value: z.number() }),
    handle: async (input, ctx) => {
      const value = await ctx.plugins.stats.takeSnapshot(input.counterName);
      return { value };
    },
  })
  .route("stats.summary").typed({
    input: z.object({}),
    output: z.object({ totalCounters: z.number(), totalSnapshots: z.number() }),
    handle: async (_input, ctx) => {
      return ctx.plugins.stats.summary();
    },
  });

server.use(appRouter);

// ==========================================
// 4. Start Server
// ==========================================

await server.start();
