import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppServer } from "../src/index";
import { Kysely, SqliteDialect } from "kysely";
import { Database } from "bun:sqlite";

function createDatabase(options: { type: "sqlite"; inMemory?: boolean }): Kysely<any> {
  const sqlite = new Database(options.inMemory ? ":memory:" : ".donkeylabs/test.db");
  return new Kysely({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}

describe("Fresh Database Initialization", () => {
  test("should initialize server on fresh database without throwing table-does-not-exist errors", async () => {
    // Create fresh in-memory database
    const db = createDatabase({ type: "sqlite", inMemory: true });
    
    // Create server with default config (Kysely adapters, not legacy)
    // Previously this would fail with "relation __donkeylabs_processes__ does not exist"
    // because the processes adapter tried to cleanup before migrations ran
    const server = new AppServer({
      db,
      port: 0, // Don't actually start HTTP server
      workflowsResumeStrategy: "skip",
    });
    
    // This should not throw - the fix ensures migrations create tables first
    // and the adapter gracefully handles missing tables during startup
    await expect(server.initialize()).resolves.toBeUndefined();
    
    // Cleanup
    await server.getCore().processes.shutdown();
    await db.destroy();
    
    console.log("✅ Server initialized successfully on fresh database");
  });

  test("should handle processes.start() gracefully before table exists", async () => {
    const db = createDatabase({ type: "sqlite", inMemory: true });
    
    // Create adapter directly (simulating what AppServer does)
    const { KyselyProcessAdapter } = await import("../src/core/process-adapter-kysely");
    const adapter = new KyselyProcessAdapter(db, { cleanupDays: 0 });
    
    // getOrphaned should return empty array even if table doesn't exist
    // This was previously throwing "no such table" errors
    const orphaned = await adapter.getOrphaned();
    expect(orphaned).toEqual([]);
    
    adapter.stop();
    await db.destroy();
    
    console.log("✅ Adapter handles missing table gracefully");
  });
});
