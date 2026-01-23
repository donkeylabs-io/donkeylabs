import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { AppServer } from "../src/server";

describe("AppServer port handling", () => {
  let db: Kysely<{}>;
  let servers: Array<{ stop: () => void }> = [];

  beforeEach(() => {
    db = new Kysely<{}>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });
    servers = [];
  });

  afterEach(async () => {
    // Clean up any servers we started
    for (const server of servers) {
      try {
        server.stop();
      } catch {}
    }
    await db.destroy();
  });

  it("should use PORT environment variable when no explicit port is set", () => {
    const originalPort = process.env.PORT;
    try {
      process.env.PORT = "4567";
      const server = new AppServer({ db });
      // Access private port via any cast
      expect((server as any).port).toBe(4567);
    } finally {
      if (originalPort !== undefined) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
    }
  });

  it("should prefer explicit port over PORT environment variable", () => {
    const originalPort = process.env.PORT;
    try {
      process.env.PORT = "4567";
      const server = new AppServer({ db, port: 3456 });
      expect((server as any).port).toBe(3456);
    } finally {
      if (originalPort !== undefined) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
    }
  });

  it("should default to port 3000 when no config or env variable", () => {
    const originalPort = process.env.PORT;
    try {
      delete process.env.PORT;
      const server = new AppServer({ db });
      expect((server as any).port).toBe(3000);
    } finally {
      if (originalPort !== undefined) {
        process.env.PORT = originalPort;
      }
    }
  });

  it("should retry with incremented port when port is in use", async () => {
    // Start a server on port 9500
    const blockerServer = Bun.serve({
      port: 9500,
      fetch: () => new Response("blocker"),
    });
    servers.push(blockerServer);

    // Now try to start AppServer on same port - it should auto-increment
    const server = new AppServer({ db, port: 9500 });
    await server.start();

    // The server should have moved to port 9501
    expect((server as any).port).toBe(9501);

    // Verify the server is actually running on 9501
    const response = await fetch("http://localhost:9501/nonexistent");
    expect(response.status).toBe(404); // Not Found from our server

    // Stop our AppServer (Bun.serve returns the server from start)
    // Note: AppServer doesn't expose the server instance, so we can't stop it cleanly
    // For testing, we'll just verify the port increment worked
  });

  it("should fail after maxPortAttempts attempts", async () => {
    // Block ports 9600-9604
    for (let i = 0; i < 5; i++) {
      const blocker = Bun.serve({
        port: 9600 + i,
        fetch: () => new Response("blocker"),
      });
      servers.push(blocker);
    }

    // Try to start AppServer with only 5 attempts
    const server = new AppServer({ db, port: 9600, maxPortAttempts: 5 });

    await expect(server.start()).rejects.toThrow(/port.*in use/i);
  });

  it("should respect custom maxPortAttempts configuration", async () => {
    // Block ports 9700-9701
    for (let i = 0; i < 2; i++) {
      const blocker = Bun.serve({
        port: 9700 + i,
        fetch: () => new Response("blocker"),
      });
      servers.push(blocker);
    }

    // With maxPortAttempts: 2, it should fail (ports 9700 and 9701 both blocked)
    const server = new AppServer({ db, port: 9700, maxPortAttempts: 2 });

    await expect(server.start()).rejects.toThrow(/port.*in use/i);
  });
});
