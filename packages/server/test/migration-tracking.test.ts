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
  createWorkflows,
} from "../src/core/index";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// ============================================
// Test Setup Helpers
// ============================================

function createCoreServices(db: Kysely<any>): CoreServices {
  const logger = createLogger({ level: "error" });
  const cache = createCache();
  const events = createEvents();
  const cron = createCron();
  const jobs = createJobs({ events });
  const sse = createSSE();
  const rateLimiter = createRateLimiter();
  const errors = createErrors();
  const workflows = createWorkflows({ events, jobs, sse });

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
    workflows,
  };
}

function createInMemoryDb(): Kysely<any> {
  return new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
  });
}

// ============================================
// Migration Tracking Table Tests
// ============================================

describe("Migration Tracking", () => {
  let db: Kysely<any>;
  let core: CoreServices;
  let manager: PluginManager;

  beforeEach(() => {
    db = createInMemoryDb();
    core = createCoreServices(db);
    manager = new PluginManager(core);
  });

  describe("__donkeylabs_migrations__ table", () => {
    it("should create migrations tracking table on first migrate() call", async () => {
      // Register a simple plugin with no migrations
      const simplePlugin: Plugin = {
        name: "simple",
        service: async () => ({}),
      };
      manager.register(simplePlugin);

      // Run migrate
      await manager.migrate();

      // Check that tracking table exists
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='__donkeylabs_migrations__'
      `.execute(db);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0]?.name).toBe("__donkeylabs_migrations__");
    });

    it("should have correct schema for tracking table", async () => {
      const simplePlugin: Plugin = {
        name: "simple",
        service: async () => ({}),
      };
      manager.register(simplePlugin);
      await manager.migrate();

      // Check table structure using pragma
      const result = await sql<{ name: string; type: string }>`
        PRAGMA table_info(__donkeylabs_migrations__)
      `.execute(db);

      const columns = result.rows.map(r => r.name);
      expect(columns).toContain("id");
      expect(columns).toContain("plugin_name");
      expect(columns).toContain("migration_name");
      expect(columns).toContain("executed_at");
    });
  });

  describe("migration recording", () => {
    const testMigrationsDir = join(process.cwd(), "src/plugins/testmigrations/migrations");

    beforeEach(async () => {
      // Clean up any previous test migrations
      try {
        await rm(join(process.cwd(), "src/plugins/testmigrations"), { recursive: true });
      } catch {
        // Directory doesn't exist, that's fine
      }

      // Create test migrations directory
      await mkdir(testMigrationsDir, { recursive: true });
    });

    it("should record applied migrations in tracking table", async () => {
      // Create a test migration file
      const migrationCode = `
        export async function up(db) {
          await db.schema.createTable("test_table_1")
            .addColumn("id", "integer", col => col.primaryKey())
            .execute();
        }
      `;
      await writeFile(join(testMigrationsDir, "001_create_test.ts"), migrationCode);

      // Create plugin that will use this migration
      const testPlugin: Plugin = {
        name: "testmigrations",
        service: async () => ({}),
      };
      manager.register(testPlugin);

      // Run migrate
      await manager.migrate();

      // Check that migration was recorded
      const result = await sql<{ plugin_name: string; migration_name: string }>`
        SELECT plugin_name, migration_name FROM __donkeylabs_migrations__
        WHERE plugin_name = 'testmigrations'
      `.execute(db);

      expect(result.rows.length).toBe(1);
      expect(result.rows[0]?.plugin_name).toBe("testmigrations");
      expect(result.rows[0]?.migration_name).toBe("001_create_test.ts");

      // Cleanup
      await rm(join(process.cwd(), "src/plugins/testmigrations"), { recursive: true });
    });

    it("should skip already applied migrations on subsequent runs", async () => {
      // Create a test migration file with a counter to track execution
      let executionCount = 0;

      // We can't easily track execution count with file-based migrations,
      // but we can verify the migration isn't re-run by checking that the table
      // wasn't attempted to be created twice (which would fail)
      const migrationCode = `
        export async function up(db) {
          await db.schema.createTable("test_skip_table")
            .addColumn("id", "integer", col => col.primaryKey())
            .execute();
        }
      `;
      await writeFile(join(testMigrationsDir, "001_create_skip_test.ts"), migrationCode);

      const testPlugin: Plugin = {
        name: "testmigrations",
        service: async () => ({}),
      };
      manager.register(testPlugin);

      // First migrate - should run the migration
      await manager.migrate();

      // Verify table was created
      const tableCheck1 = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='test_skip_table'
      `.execute(db);
      expect(tableCheck1.rows.length).toBe(1);

      // Create a new manager with the same DB (simulating server restart)
      const manager2 = new PluginManager(core);
      manager2.register(testPlugin);

      // Second migrate - should skip the migration (if it ran again, it would fail with "table already exists")
      await manager2.migrate(); // Should not throw

      // Verify only one record in tracking table
      const trackingResult = await sql<{ count: number }>`
        SELECT COUNT(*) as count FROM __donkeylabs_migrations__
        WHERE plugin_name = 'testmigrations' AND migration_name = '001_create_skip_test.ts'
      `.execute(db);
      expect(trackingResult.rows[0]?.count).toBe(1);

      // Cleanup
      await rm(join(process.cwd(), "src/plugins/testmigrations"), { recursive: true });
    });

    it("should track migrations per-plugin independently", async () => {
      // Create migrations for two different plugins
      const plugin1MigrationsDir = join(process.cwd(), "src/plugins/plugin1/migrations");
      const plugin2MigrationsDir = join(process.cwd(), "src/plugins/plugin2/migrations");

      await mkdir(plugin1MigrationsDir, { recursive: true });
      await mkdir(plugin2MigrationsDir, { recursive: true });

      const migration1 = `
        export async function up(db) {
          await db.schema.createTable("plugin1_table")
            .addColumn("id", "integer", col => col.primaryKey())
            .execute();
        }
      `;
      const migration2 = `
        export async function up(db) {
          await db.schema.createTable("plugin2_table")
            .addColumn("id", "integer", col => col.primaryKey())
            .execute();
        }
      `;

      await writeFile(join(plugin1MigrationsDir, "001_create.ts"), migration1);
      await writeFile(join(plugin2MigrationsDir, "001_create.ts"), migration2);

      const plugin1: Plugin = { name: "plugin1", service: async () => ({}) };
      const plugin2: Plugin = { name: "plugin2", service: async () => ({}) };

      manager.register(plugin1);
      manager.register(plugin2);

      await manager.migrate();

      // Check both plugins have their migrations tracked independently
      const result = await sql<{ plugin_name: string; migration_name: string }>`
        SELECT plugin_name, migration_name FROM __donkeylabs_migrations__
        ORDER BY plugin_name
      `.execute(db);

      expect(result.rows.length).toBe(2);
      expect(result.rows[0]?.plugin_name).toBe("plugin1");
      expect(result.rows[0]?.migration_name).toBe("001_create.ts");
      expect(result.rows[1]?.plugin_name).toBe("plugin2");
      expect(result.rows[1]?.migration_name).toBe("001_create.ts");

      // Cleanup
      await rm(join(process.cwd(), "src/plugins/plugin1"), { recursive: true });
      await rm(join(process.cwd(), "src/plugins/plugin2"), { recursive: true });
    });

    it("should throw and stop on migration failure", async () => {
      // Create a migration that will fail
      const failingMigration = `
        export async function up(db) {
          // This will fail - invalid SQL
          throw new Error("Intentional migration failure");
        }
      `;
      await writeFile(join(testMigrationsDir, "001_failing.ts"), failingMigration);

      const testPlugin: Plugin = {
        name: "testmigrations",
        service: async () => ({}),
      };
      manager.register(testPlugin);

      // Migrate should throw
      await expect(manager.migrate()).rejects.toThrow("Intentional migration failure");

      // Failed migration should NOT be recorded
      const result = await sql<{ count: number }>`
        SELECT COUNT(*) as count FROM __donkeylabs_migrations__
        WHERE plugin_name = 'testmigrations'
      `.execute(db);
      expect(result.rows[0]?.count).toBe(0);

      // Cleanup
      await rm(join(process.cwd(), "src/plugins/testmigrations"), { recursive: true });
    });

    it("should run multiple migrations in order", async () => {
      const migration1 = `
        export async function up(db) {
          await db.schema.createTable("ordered_table")
            .addColumn("id", "integer", col => col.primaryKey())
            .execute();
        }
      `;
      const migration2 = `
        export async function up(db) {
          await db.schema.alterTable("ordered_table")
            .addColumn("name", "text")
            .execute();
        }
      `;
      const migration3 = `
        export async function up(db) {
          await db.schema.alterTable("ordered_table")
            .addColumn("value", "integer")
            .execute();
        }
      `;

      await writeFile(join(testMigrationsDir, "001_create.ts"), migration1);
      await writeFile(join(testMigrationsDir, "002_add_name.ts"), migration2);
      await writeFile(join(testMigrationsDir, "003_add_value.ts"), migration3);

      const testPlugin: Plugin = {
        name: "testmigrations",
        service: async () => ({}),
      };
      manager.register(testPlugin);

      await manager.migrate();

      // All three migrations should be recorded in order
      const result = await sql<{ migration_name: string }>`
        SELECT migration_name FROM __donkeylabs_migrations__
        WHERE plugin_name = 'testmigrations'
        ORDER BY id
      `.execute(db);

      expect(result.rows.length).toBe(3);
      expect(result.rows[0]?.migration_name).toBe("001_create.ts");
      expect(result.rows[1]?.migration_name).toBe("002_add_name.ts");
      expect(result.rows[2]?.migration_name).toBe("003_add_value.ts");

      // Table should have all columns
      const tableInfo = await sql<{ name: string }>`
        PRAGMA table_info(ordered_table)
      `.execute(db);
      const columns = tableInfo.rows.map(r => r.name);
      expect(columns).toContain("id");
      expect(columns).toContain("name");
      expect(columns).toContain("value");

      // Cleanup
      await rm(join(process.cwd(), "src/plugins/testmigrations"), { recursive: true });
    });
  });
});
