// packages/server/src/testing/database.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestDatabase,
  resetTestDatabase,
  seedTestData,
} from "./database";
import type { Kysely } from "kysely";

describe("Database Testing Utilities", () => {
  describe("createTestDatabase", () => {
    let db: Kysely<any>;

    afterEach(async () => {
      if (db) {
        await db.destroy();
      }
    });

    it("should create an isolated SQLite database", async () => {
      db = await createTestDatabase({
        type: "sqlite",
        isolated: true,
      });

      expect(db).toBeDefined();
      // Verify it's functional by creating a table
      await db.schema
        .createTable("test_table")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("name", "text")
        .execute();

      // Insert and query
      await db
        .insertInto("test_table" as any)
        .values({ id: "1", name: "Test" })
        .execute();

      const result = await db
        .selectFrom("test_table" as any)
        .selectAll()
        .executeTakeFirst();

      expect(result).toEqual({ id: "1", name: "Test" });
    });

    it("should create an in-memory SQLite database", async () => {
      db = await createTestDatabase({
        type: "sqlite",
        isolated: false,
        connectionString: ":memory:",
      });

      expect(db).toBeDefined();

      // Create and use table
      await db.schema
        .createTable("memory_test")
        .addColumn("id", "integer", (col) => col.primaryKey())
        .execute();

      await db
        .insertInto("memory_test" as any)
        .values({ id: 1 })
        .execute();

      const count = await db
        .selectFrom("memory_test" as any)
        .select(db.fn.count("id").as("count"))
        .executeTakeFirst();

      expect(Number(count?.count)).toBe(1);
    });

    it("should cleanup isolated database on destroy", async () => {
      db = await createTestDatabase({
        type: "sqlite",
        isolated: true,
      });

      await db.schema
        .createTable("cleanup_test")
        .addColumn("id", "text", (col) => col.primaryKey())
        .execute();

      // Destroy should not throw and should cleanup
      await db.destroy();

      // Clear reference so afterEach doesn't try to destroy again
      db = null as any;
    });

    it("should throw for postgres without connection string", async () => {
      const originalEnv = process.env.TEST_DATABASE_URL;
      delete process.env.TEST_DATABASE_URL;

      try {
        await expect(
          createTestDatabase({ type: "postgres" })
        ).rejects.toThrow("TEST_DATABASE_URL not set for postgres");
      } finally {
        if (originalEnv) {
          process.env.TEST_DATABASE_URL = originalEnv;
        }
      }
    });

    it("should throw for mysql without connection string", async () => {
      const originalEnv = process.env.TEST_DATABASE_URL;
      delete process.env.TEST_DATABASE_URL;

      try {
        await expect(
          createTestDatabase({ type: "mysql" })
        ).rejects.toThrow("TEST_DATABASE_URL not set for mysql");
      } finally {
        if (originalEnv) {
          process.env.TEST_DATABASE_URL = originalEnv;
        }
      }
    });

    it("should throw for unsupported database type", async () => {
      await expect(
        createTestDatabase({ type: "mongo" as any })
      ).rejects.toThrow("Unsupported database type: mongo");
    });
  });

  describe("resetTestDatabase", () => {
    let db: Kysely<any>;

    beforeEach(async () => {
      db = await createTestDatabase({
        type: "sqlite",
        isolated: true,
      });

      // Create test tables
      await db.schema
        .createTable("users")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("email", "text")
        .execute();

      await db.schema
        .createTable("posts")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("title", "text")
        .execute();
    });

    afterEach(async () => {
      if (db) {
        await db.destroy();
      }
    });

    it("should truncate all tables", async () => {
      // Insert data
      await db.insertInto("users" as any).values({ id: "1", email: "a@b.com" }).execute();
      await db.insertInto("users" as any).values({ id: "2", email: "c@d.com" }).execute();
      await db.insertInto("posts" as any).values({ id: "1", title: "Post 1" }).execute();

      // Verify data exists
      const usersBefore = await db.selectFrom("users" as any).selectAll().execute();
      const postsBefore = await db.selectFrom("posts" as any).selectAll().execute();
      expect(usersBefore.length).toBe(2);
      expect(postsBefore.length).toBe(1);

      // Reset
      await resetTestDatabase(db);

      // Verify all tables are empty
      const usersAfter = await db.selectFrom("users" as any).selectAll().execute();
      const postsAfter = await db.selectFrom("posts" as any).selectAll().execute();
      expect(usersAfter.length).toBe(0);
      expect(postsAfter.length).toBe(0);
    });

    it("should handle empty tables", async () => {
      // No data inserted, should not throw
      await resetTestDatabase(db);

      const users = await db.selectFrom("users" as any).selectAll().execute();
      expect(users.length).toBe(0);
    });
  });

  describe("seedTestData", () => {
    let db: Kysely<any>;

    beforeEach(async () => {
      db = await createTestDatabase({
        type: "sqlite",
        isolated: true,
      });

      await db.schema
        .createTable("users")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("email", "text")
        .addColumn("name", "text")
        .execute();

      await db.schema
        .createTable("orders")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("user_id", "text")
        .addColumn("total", "integer")
        .execute();
    });

    afterEach(async () => {
      if (db) {
        await db.destroy();
      }
    });

    it("should seed data into multiple tables", async () => {
      await seedTestData(db, {
        users: [
          { id: "u1", email: "user1@test.com", name: "User 1" },
          { id: "u2", email: "user2@test.com", name: "User 2" },
        ],
        orders: [
          { id: "o1", user_id: "u1", total: 100 },
          { id: "o2", user_id: "u1", total: 200 },
          { id: "o3", user_id: "u2", total: 50 },
        ],
      });

      const users = await db.selectFrom("users" as any).selectAll().execute();
      const orders = await db.selectFrom("orders" as any).selectAll().execute();

      expect(users.length).toBe(2);
      expect(orders.length).toBe(3);

      expect(users[0].email).toBe("user1@test.com");
      expect(orders[0].total).toBe(100);
    });

    it("should handle empty arrays", async () => {
      await seedTestData(db, {
        users: [],
      });

      const users = await db.selectFrom("users" as any).selectAll().execute();
      expect(users.length).toBe(0);
    });

    it("should handle single table", async () => {
      await seedTestData(db, {
        users: [{ id: "1", email: "solo@test.com", name: "Solo" }],
      });

      const users = await db.selectFrom("users" as any).selectAll().execute();
      expect(users.length).toBe(1);
      expect(users[0].name).toBe("Solo");
    });
  });
});
