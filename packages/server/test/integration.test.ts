import { describe, it, expect, beforeEach } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { PluginManager, type CoreServices, type Plugin } from "../src/core";
import {
  createLogger,
  createCache,
  createEvents,
  createCron,
  createJobs,
  createSSE,
  createRateLimiter,
  createErrors,
} from "../src/core/index";

// ============================================
// Test Plugins (defined as plain objects for testing)
// ============================================

interface CounterSchema {
  counters: {
    id: number;
    name: string;
    value: number;
  };
}

// Simple plugin objects for testing (not using createPlugin since we need inline migrations)
const counterPlugin: Plugin = {
  name: "counter",
  version: "1.0.0",
  dependencies: [],
  service: async (ctx) => ({
    async increment(name: string): Promise<number> {
      const existing = await ctx.db
        .selectFrom("counters")
        .select(["id", "value"])
        .where("name", "=", name)
        .executeTakeFirst();

      if (existing) {
        const newValue = (existing.value ?? 0) + 1;
        await ctx.db
          .updateTable("counters")
          .set({ value: newValue })
          .where("id", "=", existing.id)
          .execute();
        return newValue;
      } else {
        await ctx.db.insertInto("counters").values({ name, value: 1 }).execute();
        return 1;
      }
    },
    async decrement(name: string): Promise<number> {
      const existing = await ctx.db
        .selectFrom("counters")
        .select(["id", "value"])
        .where("name", "=", name)
        .executeTakeFirst();

      if (existing && (existing.value ?? 0) > 0) {
        const newValue = (existing.value ?? 0) - 1;
        await ctx.db
          .updateTable("counters")
          .set({ value: newValue })
          .where("id", "=", existing.id)
          .execute();
        return newValue;
      }
      return 0;
    },
    async get(name: string): Promise<number> {
      const result = await ctx.db
        .selectFrom("counters")
        .select("value")
        .where("name", "=", name)
        .executeTakeFirst();
      return result?.value ?? 0;
    },
    async getAll(): Promise<{ name: string; value: number }[]> {
      const results = await ctx.db
        .selectFrom("counters")
        .select(["name", "value"])
        .execute();
      return results.map((r) => ({ name: r.name, value: r.value ?? 0 }));
    },
  }),
};

interface SnapshotSchema {
  snapshots: {
    id: number;
    counter_name: string;
    value_at_snapshot: number;
    created_at: string;
  };
}

const statsPlugin: Plugin = {
  name: "stats",
  version: "1.0.0",
  dependencies: ["counter"],
  service: async (ctx) => ({
    async getTotalIncrements(name: string): Promise<number> {
      return ctx.deps.counter.get(name);
    },
    async takeSnapshot(name: string): Promise<number> {
      const value = await ctx.deps.counter.get(name);
      await ctx.db
        .insertInto("snapshots")
        .values({
          counter_name: name,
          value_at_snapshot: value,
          created_at: new Date().toISOString(),
        })
        .execute();
      return value;
    },
    async getSnapshots(name: string): Promise<{ value: number; created_at: string }[]> {
      const results = await ctx.db
        .selectFrom("snapshots")
        .select(["value_at_snapshot", "created_at"])
        .where("counter_name", "=", name)
        .execute();
      return results.map((r) => ({
        value: r.value_at_snapshot,
        created_at: r.created_at,
      }));
    },
    async summary(): Promise<{ totalCounters: number; totalSnapshots: number }> {
      const counters = await ctx.db.selectFrom("counters").selectAll().execute();
      const snapshots = await ctx.db.selectFrom("snapshots").selectAll().execute();
      return {
        totalCounters: counters.length,
        totalSnapshots: snapshots.length,
      };
    },
  }),
};

// ============================================
// Helper Functions
// ============================================

function createTestCoreServices(db: Kysely<any>): CoreServices {
  const logger = createLogger({ level: "error" }); // Quiet in tests
  const cache = createCache();
  const events = createEvents();
  const cron = createCron();
  const jobs = createJobs({ events });
  const sse = createSSE();
  const rateLimiter = createRateLimiter();
  const errors = createErrors();

  return {
    db,
    config: { env: "test" },
    logger,
    cache,
    events,
    cron,
    jobs,
    sse,
    rateLimiter,
    errors,
  };
}

async function createTestTables(db: Kysely<any>): Promise<void> {
  // Create counters table
  await db.schema
    .createTable("counters")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("value", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  // Create snapshots table
  await db.schema
    .createTable("snapshots")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("counter_name", "text", (col) => col.notNull())
    .addColumn("value_at_snapshot", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();
}

// ============================================
// Tests
// ============================================

describe("Counter Plugin", () => {
  let manager: PluginManager;
  let db: Kysely<any>;

  beforeEach(async () => {
    db = new Kysely<any>({
      dialect: new BunSqliteDialect({
        database: new Database(":memory:"),
      }),
    });

    await createTestTables(db);

    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(counterPlugin);

    await manager.init();
  });

  it("should create counters table", async () => {
    await db.insertInto("counters").values({ name: "test", value: 0 }).execute();
    const result = await db.selectFrom("counters").selectAll().execute();
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("test");
  });

  it("should increment counter", async () => {
    const counter = manager.getServices().counter;

    const v1 = await counter.increment("visitors");
    expect(v1).toBe(1);

    const v2 = await counter.increment("visitors");
    expect(v2).toBe(2);

    const v3 = await counter.increment("visitors");
    expect(v3).toBe(3);
  });

  it("should handle multiple counters independently", async () => {
    const counter = manager.getServices().counter;

    await counter.increment("page_views");
    await counter.increment("page_views");
    await counter.increment("clicks");

    expect(await counter.get("page_views")).toBe(2);
    expect(await counter.get("clicks")).toBe(1);
    expect(await counter.get("nonexistent")).toBe(0);
  });

  it("should decrement counter but not below zero", async () => {
    const counter = manager.getServices().counter;

    await counter.increment("stock");
    await counter.increment("stock");
    expect(await counter.get("stock")).toBe(2);

    await counter.decrement("stock");
    expect(await counter.get("stock")).toBe(1);

    await counter.decrement("stock");
    await counter.decrement("stock"); // Should not go below 0
    expect(await counter.get("stock")).toBe(0);
  });

  it("should list all counters", async () => {
    const counter = manager.getServices().counter;

    await counter.increment("a");
    await counter.increment("b");
    await counter.increment("b");
    await counter.increment("c");

    const all = await counter.getAll();
    expect(all).toHaveLength(3);
    expect(all.find((c: { name: string; value: number }) => c.name === "a")?.value).toBe(1);
    expect(all.find((c: { name: string; value: number }) => c.name === "b")?.value).toBe(2);
    expect(all.find((c: { name: string; value: number }) => c.name === "c")?.value).toBe(1);
  });
});

describe("Stats Plugin (with Counter dependency)", () => {
  let manager: PluginManager;
  let db: Kysely<any>;

  beforeEach(async () => {
    db = new Kysely<any>({
      dialect: new BunSqliteDialect({
        database: new Database(":memory:"),
      }),
    });

    await createTestTables(db);

    const core = createTestCoreServices(db);
    manager = new PluginManager(core);

    // Register both plugins - stats depends on counter
    manager.register(counterPlugin);
    manager.register(statsPlugin);

    await manager.init();
  });

  it("should create tables for both plugins", async () => {
    await db.insertInto("counters").values({ name: "test", value: 0 }).execute();
    await db.insertInto("snapshots").values({
      counter_name: "test",
      value_at_snapshot: 0,
      created_at: new Date().toISOString(),
    }).execute();

    const counters = await db.selectFrom("counters").selectAll().execute();
    const snapshots = await db.selectFrom("snapshots").selectAll().execute();

    expect(counters).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
  });

  it("should access counter service from stats plugin", async () => {
    const { counter, stats } = manager.getServices();

    await counter.increment("api_calls");
    await counter.increment("api_calls");

    const total = await stats.getTotalIncrements("api_calls");
    expect(total).toBe(2);
  });

  it("should take snapshots of counter values", async () => {
    const { counter, stats } = manager.getServices();

    await counter.increment("requests");
    await counter.increment("requests");

    const snapshot1 = await stats.takeSnapshot("requests");
    expect(snapshot1).toBe(2);

    await counter.increment("requests");
    await counter.increment("requests");
    await counter.increment("requests");

    const snapshot2 = await stats.takeSnapshot("requests");
    expect(snapshot2).toBe(5);

    const allSnapshots = await stats.getSnapshots("requests");
    expect(allSnapshots).toHaveLength(2);
    const values = allSnapshots.map((s: { value: number }) => s.value).sort();
    expect(values).toEqual([2, 5]);
  });

  it("should provide summary across all counters and snapshots", async () => {
    const { counter, stats } = manager.getServices();

    await counter.increment("users");
    await counter.increment("posts");
    await counter.increment("comments");

    await stats.takeSnapshot("users");
    await stats.takeSnapshot("posts");

    const summary = await stats.summary();
    expect(summary.totalCounters).toBe(3);
    expect(summary.totalSnapshots).toBe(2);
  });
});

describe("Plugin Dependency Resolution", () => {
  it("should work regardless of plugin registration order", async () => {
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({
        database: new Database(":memory:"),
      }),
    });

    await createTestTables(db);

    const manager = new PluginManager(createTestCoreServices(db));

    // Register in wrong order: stats depends on counter, but register stats first
    manager.register(statsPlugin);
    manager.register(counterPlugin);

    await manager.init();

    const { counter, stats } = manager.getServices();

    await counter.increment("test");
    await counter.increment("test");
    const snapshot = await stats.takeSnapshot("test");

    expect(snapshot).toBe(2);
  });

  it("should throw error when dependency is not registered", async () => {
    const pluginWithMissingDep: Plugin = {
      name: "orphan",
      version: "1.0.0",
      dependencies: ["nonExistentPlugin"],
      service: async () => ({ name: "orphan" }),
    };

    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({
        database: new Database(":memory:"),
      }),
    });

    const manager = new PluginManager(createTestCoreServices(db));
    manager.register(pluginWithMissingDep);

    await expect(manager.init()).rejects.toThrow(
      "Plugin 'orphan' depends on 'nonExistentPlugin', but it is not registered."
    );
  });

  it("should initialize plugins in correct order based on dependencies", async () => {
    const initOrder: string[] = [];

    const pluginA: Plugin = {
      name: "pluginA",
      version: "1.0.0",
      dependencies: [],
      service: async () => {
        initOrder.push("A");
        return { name: "A" };
      },
    };

    const pluginB: Plugin = {
      name: "pluginB",
      version: "1.0.0",
      dependencies: ["pluginA"],
      service: async () => {
        initOrder.push("B");
        return { name: "B" };
      },
    };

    const pluginC: Plugin = {
      name: "pluginC",
      version: "1.0.0",
      dependencies: ["pluginB"],
      service: async () => {
        initOrder.push("C");
        return { name: "C" };
      },
    };

    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({
        database: new Database(":memory:"),
      }),
    });

    const manager = new PluginManager(createTestCoreServices(db));

    // Register in reverse order to test sorting
    manager.register(pluginC);
    manager.register(pluginA);
    manager.register(pluginB);

    await manager.init();

    expect(initOrder).toEqual(["A", "B", "C"]);
  });

  it("should provide dependency services via ctx.deps", async () => {
    let receivedDeps: any = null;

    const parentPlugin: Plugin = {
      name: "parent",
      version: "1.0.0",
      dependencies: [],
      service: async () => ({
        getValue: () => 42,
      }),
    };

    const childPlugin: Plugin = {
      name: "child",
      version: "1.0.0",
      dependencies: ["parent"],
      service: async (ctx: any) => {
        receivedDeps = ctx.deps;
        return {
          getParentValue: () => ctx.deps.parent.getValue(),
        };
      },
    };

    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({
        database: new Database(":memory:"),
      }),
    });

    const manager = new PluginManager(createTestCoreServices(db));
    manager.register(parentPlugin);
    manager.register(childPlugin);

    await manager.init();

    expect(receivedDeps).toBeDefined();
    expect(receivedDeps.parent).toBeDefined();
    expect(receivedDeps.parent.getValue()).toBe(42);

    const services = manager.getServices();
    expect(services.child.getParentValue()).toBe(42);
  });
});

describe("Plugin with Config", () => {
  it("should pass config to plugin service via ctx.config", async () => {
    let receivedConfig: any = null;

    const configuredPlugin: Plugin = {
      name: "configured",
      version: "1.0.0",
      dependencies: [],
      service: async (ctx: any) => {
        receivedConfig = ctx.config;
        return {
          getConfig: () => ctx.config,
        };
      },
    };

    // Simulate bound config
    (configuredPlugin as any)._boundConfig = {
      apiKey: "test-key",
      timeout: 5000,
    };

    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({
        database: new Database(":memory:"),
      }),
    });

    const manager = new PluginManager(createTestCoreServices(db));
    manager.register(configuredPlugin);

    await manager.init();

    expect(receivedConfig).toBeDefined();
    expect(receivedConfig.apiKey).toBe("test-key");
    expect(receivedConfig.timeout).toBe(5000);

    const service = manager.getServices().configured;
    const config = service.getConfig();

    expect(config.apiKey).toBe("test-key");
    expect(config.timeout).toBe(5000);
  });
});
