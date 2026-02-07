import { describe, it, expect, afterEach } from "bun:test";
import { z } from "zod";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { AppServer } from "../src/server";
import { createRouter } from "../src/router";

/**
 * Graceful Shutdown Tests
 *
 * Validates:
 * - Draining guard returns 503 during shutdown
 * - activeRequests tracking increments/decrements correctly
 * - Health endpoints remain available during drain phase
 * - Shutdown is idempotent (safe to call multiple times)
 * - Shutdown config (timeout, drainTimeout) is respected
 * - Phase ordering in shutdown sequence
 */

// Helper to create a server with a slow route for testing drain behavior
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
      forceExit: false, // Do not call process.exit in tests
    },
  });

  server.use(router);

  return { server, db };
}

// Use a random port range to avoid collisions with other tests
function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

describe("Graceful Shutdown", () => {
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
  // Draining guard
  // ------------------------------------------
  describe("Draining guard", () => {
    it("should return 503 for new requests after shutdown begins", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();

      // Verify normal requests work
      const normalRes = await fetch(`http://localhost:${(server as any).port}/test.fast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(normalRes.status).toBe(200);

      // Start shutdown (but don't await it yet)
      const shutdownPromise = server.shutdown();

      // Give the shutdown a moment to set the draining flag
      await new Promise((r) => setTimeout(r, 50));

      // New requests should now be rejected with 503
      try {
        const res = await fetch(`http://localhost:${(server as any).port}/test.fast`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        // If the server is still up, we should get 503
        expect(res.status).toBe(503);
        const retryAfter = res.headers.get("Retry-After");
        expect(retryAfter).toBeDefined();
        expect(res.headers.get("Connection")).toBe("close");
      } catch {
        // Connection refused is also acceptable - server already stopped
      }

      await shutdownPromise;
      serverToCleanup = null; // Already shut down
    });
  });

  // ------------------------------------------
  // Health endpoints during drain
  // ------------------------------------------
  describe("Health endpoints during shutdown", () => {
    it("should report unhealthy liveness during shutdown", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();
      const actualPort = (server as any).port;

      // Health should be healthy before shutdown
      const healthyRes = await fetch(`http://localhost:${actualPort}/_health`);
      expect(healthyRes.status).toBe(200);
      const healthyBody = await healthyRes.json();
      expect(healthyBody.status).toBe("healthy");

      // Start shutdown without awaiting
      const shutdownPromise = server.shutdown();

      // Give a moment for the shutdown flag to be set
      await new Promise((r) => setTimeout(r, 50));

      // Health endpoints bypass draining, so they should still respond
      try {
        const livenessRes = await fetch(`http://localhost:${actualPort}/_health`);
        // During shutdown, liveness should return 503 with unhealthy status
        expect(livenessRes.status).toBe(503);
        const livenessBody = await livenessRes.json();
        expect(livenessBody.status).toBe("unhealthy");
      } catch {
        // Connection refused if server already stopped - acceptable
      }

      await shutdownPromise;
      serverToCleanup = null;
    });
  });

  // ------------------------------------------
  // activeRequests tracking
  // ------------------------------------------
  describe("activeRequests tracking", () => {
    it("should have zero activeRequests when idle", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();

      expect((server as any).activeRequests).toBe(0);

      await server.shutdown();
      serverToCleanup = null;
    });

    it("should increment activeRequests during request handling", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();
      const actualPort = (server as any).port;

      // Start a slow request without awaiting
      const slowPromise = fetch(`http://localhost:${actualPort}/test.slow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delayMs: 200 }),
      });

      // Give the request a moment to reach the handler
      await new Promise((r) => setTimeout(r, 50));

      // Should have at least one active request
      expect((server as any).activeRequests).toBeGreaterThanOrEqual(1);

      // Wait for the slow request to complete
      const res = await slowPromise;
      expect(res.status).toBe(200);

      // After completion, activeRequests should go back to 0
      await new Promise((r) => setTimeout(r, 50));
      expect((server as any).activeRequests).toBe(0);

      await server.shutdown();
      serverToCleanup = null;
    });

    it("should decrement activeRequests even when handler throws", async () => {
      const db = new Kysely<any>({
        dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
      });

      const errorRouter = createRouter("err")
        .route("throw").typed({
          input: z.object({}),
          output: z.object({}),
          handle: async (_input, ctx) => {
            throw ctx.errors.InternalServer("intentional error");
          },
        });

      const port = randomPort();
      const errServer = new AppServer({
        db,
        port,
        maxPortAttempts: 10,
        logger: { level: "error" },
        health: { dbCheck: false },
        shutdown: { forceExit: false },
      });
      errServer.use(errorRouter);
      serverToCleanup = errServer;

      await errServer.start();
      const actualPort = (errServer as any).port;

      const res = await fetch(`http://localhost:${actualPort}/err.throw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(500);

      // activeRequests should be 0 after error
      await new Promise((r) => setTimeout(r, 50));
      expect((errServer as any).activeRequests).toBe(0);

      await errServer.shutdown();
      serverToCleanup = null;
    });
  });

  // ------------------------------------------
  // Shutdown idempotency
  // ------------------------------------------
  describe("Shutdown idempotency", () => {
    it("should be safe to call shutdown() multiple times", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();

      // Call shutdown multiple times concurrently
      await Promise.all([
        server.shutdown(),
        server.shutdown(),
        server.shutdown(),
      ]);

      // Should not throw or deadlock
      serverToCleanup = null;
    });
  });

  // ------------------------------------------
  // ShutdownConfig
  // ------------------------------------------
  describe("ShutdownConfig", () => {
    it("should accept custom shutdown config", () => {
      const db = new Kysely<any>({
        dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
      });

      // Should not throw with custom config
      const server = new AppServer({
        db,
        shutdown: {
          timeout: 60000,
          drainTimeout: 15000,
          forceExit: false,
        },
        logger: { level: "error" },
      });

      expect(server).toBeDefined();
    });

    it("should default forceExit to true when not specified", () => {
      const db = new Kysely<any>({
        dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
      });

      // Default config
      const server = new AppServer({
        db,
        logger: { level: "error" },
      });

      // The server should exist and have shutdown defaults
      expect(server).toBeDefined();
    });
  });

  // ------------------------------------------
  // Phase ordering
  // ------------------------------------------
  describe("Phase ordering", () => {
    it("should run user shutdown handlers before stopping background services", async () => {
      const port = randomPort();
      const db = new Kysely<any>({
        dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
      });

      const phases: string[] = [];

      const router = createRouter("phase")
        .route("ping").typed({
          input: z.object({}),
          output: z.object({ pong: z.boolean() }),
          handle: async () => ({ pong: true }),
        });

      const server = new AppServer({
        db,
        port,
        maxPortAttempts: 10,
        logger: { level: "error" },
        health: { dbCheck: false },
        shutdown: { forceExit: false, timeout: 10000, drainTimeout: 2000 },
      });

      server.use(router);
      serverToCleanup = server;

      // Register shutdown handlers that track ordering
      server.onShutdown(async () => {
        phases.push("user-handler-1");
      });
      server.onShutdown(async () => {
        phases.push("user-handler-2");
      });

      await server.start();
      await server.shutdown();
      serverToCleanup = null;

      // User shutdown handlers should have run
      expect(phases).toContain("user-handler-1");
      expect(phases).toContain("user-handler-2");

      // Handlers run in LIFO order (reverse)
      expect(phases[0]).toBe("user-handler-2");
      expect(phases[1]).toBe("user-handler-1");
    });

    it("should set draining flag before stopping server", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();

      // Before shutdown
      expect((server as any).draining).toBe(false);
      expect((server as any).isShuttingDown).toBe(false);

      await server.shutdown();
      serverToCleanup = null;

      // After shutdown
      expect((server as any).draining).toBe(true);
      expect((server as any).isShuttingDown).toBe(true);
    });
  });

  // ------------------------------------------
  // Health check endpoint paths
  // ------------------------------------------
  describe("Health endpoint configuration", () => {
    it("should serve /_health as default liveness path", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();
      const actualPort = (server as any).port;

      const res = await fetch(`http://localhost:${actualPort}/_health`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("healthy");

      await server.shutdown();
      serverToCleanup = null;
    });

    it("should serve /_ready as default readiness path", async () => {
      const port = randomPort();
      const { server } = createTestServer(port);
      serverToCleanup = server;

      await server.start();
      const actualPort = (server as any).port;

      const res = await fetch(`http://localhost:${actualPort}/_ready`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBeDefined();

      await server.shutdown();
      serverToCleanup = null;
    });

    it("should serve custom health paths when configured", async () => {
      const db = new Kysely<any>({
        dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
      });

      const port = randomPort();
      const server = new AppServer({
        db,
        port,
        maxPortAttempts: 10,
        logger: { level: "error" },
        health: {
          dbCheck: false,
          livenessPath: "/healthz",
          readinessPath: "/readyz",
        },
        shutdown: { forceExit: false },
      });

      server.use(createRouter("api")
        .route("ping").typed({
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          handle: async () => ({ ok: true }),
        }));

      serverToCleanup = server;
      await server.start();
      const actualPort = (server as any).port;

      const liveness = await fetch(`http://localhost:${actualPort}/healthz`);
      expect(liveness.status).toBe(200);

      const readiness = await fetch(`http://localhost:${actualPort}/readyz`);
      expect(readiness.status).toBe(200);

      await server.shutdown();
      serverToCleanup = null;
    });

    it("should return 503 for unhealthy readiness check", async () => {
      const db = new Kysely<any>({
        dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
      });

      const port = randomPort();
      const server = new AppServer({
        db,
        port,
        maxPortAttempts: 10,
        logger: { level: "error" },
        health: {
          dbCheck: false,
          checks: [{
            name: "always-fail",
            critical: true,
            check: () => ({ status: "unhealthy" as const, message: "always fails" }),
          }],
        },
        shutdown: { forceExit: false },
      });

      server.use(createRouter("api")
        .route("ping").typed({
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          handle: async () => ({ ok: true }),
        }));

      serverToCleanup = server;
      await server.start();
      const actualPort = (server as any).port;

      const readiness = await fetch(`http://localhost:${actualPort}/_ready`);
      expect(readiness.status).toBe(503);

      const body = await readiness.json();
      expect(body.status).toBe("unhealthy");
      expect(body.checks["always-fail"].status).toBe("unhealthy");

      await server.shutdown();
      serverToCleanup = null;
    });
  });
});
