import { describe, it, expect, beforeEach } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { PluginManager, type CoreServices } from "../core";
import { authPlugin } from "../plugins/auth";
import { counterPlugin } from "../plugins/counter";
import { statsPlugin } from "../plugins/stats";
import {
  createLogger,
  createCache,
  createEvents,
  createCron,
  createJobs,
  createSSE,
  createRateLimiter,
  createErrors,
} from "../core/index";

// Helper to create full CoreServices for tests
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

describe("Counter Plugin", () => {
    let manager: PluginManager;
    let db: Kysely<any>;

    beforeEach(async () => {
        db = new Kysely<any>({
            dialect: new BunSqliteDialect({
                database: new Database(":memory:")
            })
        });

        const core = createTestCoreServices(db);
        manager = new PluginManager(core);
        manager.register(counterPlugin);

        await manager.migrate();
        await manager.init();
    });

    it("should run migrations and create counters table", async () => {
        // Verify table exists by inserting directly
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
                database: new Database(":memory:")
            })
        });

        const core = createTestCoreServices(db);
        manager = new PluginManager(core);

        // Register both plugins - stats depends on counter
        manager.register(counterPlugin);
        manager.register(statsPlugin);

        await manager.migrate();
        await manager.init();
    });

    it("should run migrations for both plugins", async () => {
        // Verify both tables exist
        await db.insertInto("counters").values({ name: "test", value: 0 }).execute();
        await db.insertInto("snapshots").values({ counter_name: "test", value_at_snapshot: 0 }).execute();

        const counters = await db.selectFrom("counters").selectAll().execute();
        const snapshots = await db.selectFrom("snapshots").selectAll().execute();

        expect(counters).toHaveLength(1);
        expect(snapshots).toHaveLength(1);
    });

    it("should access counter service from stats plugin", async () => {
        const { counter, stats } = manager.getServices();

        // Use counter to increment
        await counter.increment("api_calls");
        await counter.increment("api_calls");

        // Stats should be able to read counter value
        const total = await stats.getTotalIncrements("api_calls");
        expect(total).toBe(2);
    });

    it("should take snapshots of counter values", async () => {
        const { counter, stats } = manager.getServices();

        // Build up counter
        await counter.increment("requests");
        await counter.increment("requests");

        // Take snapshot
        const snapshot1 = await stats.takeSnapshot("requests");
        expect(snapshot1).toBe(2);

        // Increment more
        await counter.increment("requests");
        await counter.increment("requests");
        await counter.increment("requests");

        // Take another snapshot
        const snapshot2 = await stats.takeSnapshot("requests");
        expect(snapshot2).toBe(5);

        // Verify snapshots are stored
        const allSnapshots = await stats.getSnapshots("requests");
        expect(allSnapshots).toHaveLength(2);
        // Check both values exist (order may vary if timestamps are same)
        const values = allSnapshots.map((s: { value: number }) => s.value).sort();
        expect(values).toEqual([2, 5]);
    });

    it("should provide summary across all counters and snapshots", async () => {
        const { counter, stats } = manager.getServices();

        // Create multiple counters
        await counter.increment("users");
        await counter.increment("posts");
        await counter.increment("comments");

        // Take some snapshots
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
                database: new Database(":memory:")
            })
        });

        const manager = new PluginManager(createTestCoreServices(db));

        // Register in wrong order: stats depends on counter, but register stats first
        manager.register(statsPlugin);
        manager.register(counterPlugin);

        await manager.migrate();
        await manager.init();

        // Should still work - counter initialized before stats
        const { counter, stats } = manager.getServices();

        await counter.increment("test");
        await counter.increment("test");
        const snapshot = await stats.takeSnapshot("test");

        expect(snapshot).toBe(2);
    });

    it("should throw error when dependency is not registered", async () => {
        const pluginWithMissingDep = {
            name: "orphan",
            version: "1.0.0",
            dependencies: ["nonExistentPlugin"] as const,
            service: async () => ({ name: "orphan" })
        };

        const db = new Kysely<any>({
            dialect: new BunSqliteDialect({
                database: new Database(":memory:")
            })
        });

        const manager = new PluginManager(createTestCoreServices(db));
        manager.register(pluginWithMissingDep as any);

        await expect(manager.init()).rejects.toThrow(
            "Plugin 'orphan' depends on 'nonExistentPlugin', but it is not registered."
        );
    });

    it("should initialize plugins in correct order based on dependencies", async () => {
        const initOrder: string[] = [];

        // Create plugins that track init order
        const pluginA = {
            name: "pluginA",
            version: "1.0.0",
            dependencies: [] as const,
            service: async () => {
                initOrder.push("A");
                return { name: "A" };
            }
        };

        const pluginB = {
            name: "pluginB",
            version: "1.0.0",
            dependencies: ["pluginA"] as const,
            service: async () => {
                initOrder.push("B");
                return { name: "B" };
            }
        };

        const pluginC = {
            name: "pluginC",
            version: "1.0.0",
            dependencies: ["pluginB"] as const,
            service: async () => {
                initOrder.push("C");
                return { name: "C" };
            }
        };

        const db = new Kysely<any>({
            dialect: new BunSqliteDialect({
                database: new Database(":memory:")
            })
        });

        const manager = new PluginManager(createTestCoreServices(db));

        // Register in reverse order to test sorting
        manager.register(pluginC as any);
        manager.register(pluginA as any);
        manager.register(pluginB as any);

        await manager.init();

        // A should init before B, B before C
        expect(initOrder).toEqual(["A", "B", "C"]);
    });

    it("should provide dependency services via ctx.deps", async () => {
        let receivedDeps: any = null;

        const parentPlugin = {
            name: "parent",
            version: "1.0.0",
            dependencies: [] as const,
            service: async () => ({
                getValue: () => 42
            })
        };

        const childPlugin = {
            name: "child",
            version: "1.0.0",
            dependencies: ["parent"] as const,
            service: async (ctx: any) => {
                receivedDeps = ctx.deps;
                return {
                    getParentValue: () => ctx.deps.parent.getValue()
                };
            }
        };

        const db = new Kysely<any>({
            dialect: new BunSqliteDialect({
                database: new Database(":memory:")
            })
        });

        const manager = new PluginManager(createTestCoreServices(db));
        manager.register(parentPlugin as any);
        manager.register(childPlugin as any);

        await manager.init();

        // Verify deps were passed correctly
        expect(receivedDeps).toBeDefined();
        expect(receivedDeps.parent).toBeDefined();
        expect(receivedDeps.parent.getValue()).toBe(42);

        // Verify child can use parent service
        const services = manager.getServices();
        expect(services.child.getParentValue()).toBe(42);
    });
});

describe("Auth Plugin with Middleware", () => {
    it("should initialize auth plugin and provide service", async () => {
        const db = new Kysely<any>({
            dialect: new BunSqliteDialect({
                database: new Database(":memory:")
            })
        });

        const manager = new PluginManager(createTestCoreServices(db));
        manager.register(authPlugin({
            privateKey: "test-secret-key",
            tokenExpiry: 3600,
            issuer: "test-app"
        }));

        await manager.migrate();
        await manager.init();

        const auth = manager.getServices().auth;
        expect(auth).toBeDefined();
        expect(typeof auth.getCurrentUser).toBe("function");
        expect(typeof auth.login).toBe("function");
    });
});

describe("Plugin Config System", () => {
    it("should pass config to plugin service via ctx.config", async () => {
        const db = new Kysely<any>({
            dialect: new BunSqliteDialect({
                database: new Database(":memory:")
            })
        });

        const manager = new PluginManager(createTestCoreServices(db));
        manager.register(authPlugin({
            privateKey: "my-private-key",
            tokenExpiry: 7200,
            issuer: "my-issuer"
        }));

        await manager.migrate();
        await manager.init();

        const auth = manager.getServices().auth;
        const config = auth.getConfig();

        expect(config.issuer).toBe("my-issuer");
        expect(config.tokenExpiry).toBe(7200);
    });

    it("should use default config values when not provided", async () => {
        const db = new Kysely<any>({
            dialect: new BunSqliteDialect({
                database: new Database(":memory:")
            })
        });

        const manager = new PluginManager(createTestCoreServices(db));
        manager.register(authPlugin({
            privateKey: "minimal-key"
            // tokenExpiry and issuer not provided
        }));

        await manager.migrate();
        await manager.init();

        const auth = manager.getServices().auth;
        const config = auth.getConfig();

        expect(config.issuer).toBe("app"); // default
        expect(config.tokenExpiry).toBe(3600); // default
    });

    it("should work with plugins that have no config", async () => {
        const db = new Kysely<any>({
            dialect: new BunSqliteDialect({
                database: new Database(":memory:")
            })
        });

        const manager = new PluginManager(createTestCoreServices(db));

        // Counter and stats don't require config
        manager.register(counterPlugin);
        manager.register(statsPlugin);

        await manager.migrate();
        await manager.init();

        const counter = manager.getServices().counter;
        const stats = manager.getServices().stats;

        expect(counter).toBeDefined();
        expect(stats).toBeDefined();

        // They should still work normally
        await counter.increment("test");
        expect(await counter.get("test")).toBe(1);
    });
});
