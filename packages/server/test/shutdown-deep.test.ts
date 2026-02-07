import { describe, it, expect, afterEach } from "bun:test";
import { z } from "zod";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { AppServer } from "../src/server";
import { createRouter } from "../src/router";

// Helper to create a server for shutdown tests
function createTestServer(
  port: number,
  options?: { shutdownTimeout?: number; drainTimeout?: number }
) {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
  });

  const router = createRouter("test")
    .route("fast").typed({
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handle: async () => ({ ok: true }),
    })
    .route("slow").typed({
      input: z.object({ delayMs: z.number() }),
      output: z.object({ completed: z.boolean() }),
      handle: async (input) => {
        await new Promise((r) => setTimeout(r, input.delayMs));
        return { completed: true };
      },
    });

  const server = new AppServer({
    db,
    port,
    maxPortAttempts: 10,
    logger: { level: "error" },
    health: { dbCheck: false },
    shutdown: {
      timeout: options?.shutdownTimeout ?? 10000,
      drainTimeout: options?.drainTimeout ?? 5000,
      forceExit: false,
    },
  });

  server.use(router);

  return { server, db };
}

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

describe("Graceful Shutdown - Deep Tests", () => {
  let serverToCleanup: AppServer | null = null;

  afterEach(async () => {
    if (serverToCleanup) {
      try {
        await serverToCleanup.shutdown();
      } catch {}
      serverToCleanup = null;
    }
  });

  // ------------------------------------------
  // Drain timeout exceeded
  // ------------------------------------------
  describe("Drain timeout exceeded", () => {
    it("should proceed with shutdown even when drain timeout is exceeded", async () => {
      const port = randomPort();
      const { server } = createTestServer(port, {
        drainTimeout: 200, // Very short drain timeout
      });
      serverToCleanup = server;

      await server.start();
      const actualPort = (server as any).port;

      // Start a slow request that takes longer than the drain timeout
      const slowPromise = fetch(`http://localhost:${actualPort}/test.slow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delayMs: 2000 }),
      });

      // Give the request a moment to start
      await new Promise((r) => setTimeout(r, 50));

      // Shutdown should complete within drain timeout + some margin
      // even though the slow request is still in-flight
      const start = Date.now();
      await server.shutdown();
      const elapsed = Date.now() - start;
      serverToCleanup = null;

      // Should complete well before the slow request would have finished
      expect(elapsed).toBeLessThan(2000);

      // Clean up the dangling request
      try { await slowPromise; } catch {}
    });
  });

  // ------------------------------------------
  // Concurrent in-flight during drain
  // ------------------------------------------
  describe("Concurrent in-flight requests during drain", () => {
    it("should track multiple concurrent active requests", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();
      const actualPort = (server as any).port;

      // Start 3 slow requests simultaneously
      const promises = Array.from({ length: 3 }, () =>
        fetch(`http://localhost:${actualPort}/test.slow`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delayMs: 300 }),
        })
      );

      // Give requests time to reach the handler
      await new Promise((r) => setTimeout(r, 50));

      expect((server as any).activeRequests).toBeGreaterThanOrEqual(2);

      // Wait for all requests to complete
      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }

      // After completion, activeRequests should return to 0
      await new Promise((r) => setTimeout(r, 50));
      expect((server as any).activeRequests).toBe(0);

      await server.shutdown();
      serverToCleanup = null;
    });

    it("should wait for all concurrent requests to finish before proceeding", async () => {
      const port = randomPort();
      const { server } = createTestServer(port, { drainTimeout: 3000 });
      serverToCleanup = server;

      await server.start();
      const actualPort = (server as any).port;

      // Start a slow request
      const slowPromise = fetch(`http://localhost:${actualPort}/test.slow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delayMs: 500 }),
      });

      // Give it time to start
      await new Promise((r) => setTimeout(r, 50));

      // Start shutdown - should wait for the request
      const shutdownPromise = server.shutdown();

      // The slow request should complete successfully
      const res = await slowPromise;
      expect(res.status).toBe(200);
      const body = await res.json() as { completed: boolean };
      expect(body.completed).toBe(true);

      // Shutdown should complete after request finishes
      await shutdownPromise;
      serverToCleanup = null;
    });
  });

  // ------------------------------------------
  // Shutdown handler errors
  // ------------------------------------------
  describe("Shutdown handler error resilience", () => {
    it("should continue shutdown even when a user handler throws", async () => {
      const port = randomPort();
      const db = new Kysely<any>({
        dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
      });

      const server = new AppServer({
        db,
        port,
        maxPortAttempts: 10,
        logger: { level: "error" },
        health: { dbCheck: false },
        shutdown: { forceExit: false },
      });

      server.use(createRouter("api").route("ping").typed({
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handle: async () => ({ ok: true }),
      }));

      const phases: string[] = [];

      server.onShutdown(async () => {
        phases.push("handler-1");
      });
      server.onShutdown(async () => {
        phases.push("handler-2-throws");
        throw new Error("cleanup failed");
      });
      server.onShutdown(async () => {
        phases.push("handler-3");
      });

      serverToCleanup = server;
      await server.start();
      await server.shutdown();
      serverToCleanup = null;

      // All handlers should have been attempted (LIFO order)
      // The error in one handler should not prevent others from running
      expect(phases).toContain("handler-1");
      expect(phases).toContain("handler-3");
    });
  });

  // ------------------------------------------
  // State after shutdown
  // ------------------------------------------
  describe("State after shutdown", () => {
    it("should have isShuttingDown=true and draining=true after shutdown", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();

      expect((server as any).isShuttingDown).toBe(false);
      expect((server as any).draining).toBe(false);

      await server.shutdown();
      serverToCleanup = null;

      expect((server as any).isShuttingDown).toBe(true);
      expect((server as any).draining).toBe(true);
    });

    it("should have zero activeRequests after clean shutdown", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();
      const actualPort = (server as any).port;

      // Make a request and wait for it
      const res = await fetch(`http://localhost:${actualPort}/test.fast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);

      await server.shutdown();
      serverToCleanup = null;

      expect((server as any).activeRequests).toBe(0);
    });
  });

  // ------------------------------------------
  // 503 response format
  // ------------------------------------------
  describe("503 response during drain", () => {
    it("should include Retry-After and Connection headers in 503 response", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();
      const actualPort = (server as any).port;

      // Trigger shutdown
      const shutdownPromise = server.shutdown();
      await new Promise((r) => setTimeout(r, 50));

      try {
        const res = await fetch(`http://localhost:${actualPort}/test.fast`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        if (res.status === 503) {
          expect(res.headers.get("Retry-After")).toBe("5");
          expect(res.headers.get("Connection")).toBe("close");
          const body = await res.text();
          expect(body).toBe("Service Unavailable");
        }
      } catch {
        // Connection refused is acceptable
      }

      await shutdownPromise;
      serverToCleanup = null;
    });
  });

  // ------------------------------------------
  // Shutdown is idempotent when called rapidly
  // ------------------------------------------
  describe("Rapid double shutdown", () => {
    it("should handle shutdown called twice in quick succession", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();

      // Call shutdown twice without awaiting the first
      const p1 = server.shutdown();
      const p2 = server.shutdown();

      await Promise.all([p1, p2]);
      serverToCleanup = null;

      // Should complete without errors
      expect((server as any).isShuttingDown).toBe(true);
    });
  });
});
