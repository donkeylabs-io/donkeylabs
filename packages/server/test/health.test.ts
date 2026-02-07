import { describe, it, expect, beforeEach } from "bun:test";
import {
  createHealth,
  createDbHealthCheck,
  type Health,
  type HealthCheck,
  type HealthCheckResult,
} from "../src/core/health";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";

// ==========================================
// Health Service Unit Tests
// ==========================================

describe("Health Service", () => {
  let health: Health;

  beforeEach(() => {
    health = createHealth({ dbCheck: false, checkTimeout: 500 });
  });

  // ------------------------------------------
  // register()
  // ------------------------------------------
  describe("register()", () => {
    it("should register a health check", async () => {
      health.register({
        name: "custom",
        check: () => ({ status: "healthy" }),
      });

      const result = await health.check();
      expect(result.checks).toHaveProperty("custom");
      expect(result.checks.custom.status).toBe("healthy");
    });

    it("should register multiple health checks", async () => {
      health.register({
        name: "check-a",
        check: () => ({ status: "healthy" }),
      });
      health.register({
        name: "check-b",
        check: () => ({ status: "healthy" }),
      });

      const result = await health.check();
      expect(Object.keys(result.checks)).toHaveLength(2);
      expect(result.checks["check-a"].status).toBe("healthy");
      expect(result.checks["check-b"].status).toBe("healthy");
    });
  });

  // ------------------------------------------
  // check() - aggregation logic
  // ------------------------------------------
  describe("check() aggregation", () => {
    it("should return healthy when all checks pass", async () => {
      health.register({
        name: "alpha",
        check: () => ({ status: "healthy" }),
      });
      health.register({
        name: "beta",
        check: () => ({ status: "healthy" }),
      });

      const result = await health.check();
      expect(result.status).toBe("healthy");
    });

    it("should return unhealthy when a critical check fails", async () => {
      health.register({
        name: "critical-db",
        critical: true,
        check: () => ({ status: "unhealthy", message: "connection refused" }),
      });
      health.register({
        name: "ok-cache",
        check: () => ({ status: "healthy" }),
      });

      const result = await health.check();
      expect(result.status).toBe("unhealthy");
    });

    it("should return degraded when a non-critical check fails", async () => {
      health.register({
        name: "optional-cache",
        critical: false,
        check: () => ({ status: "unhealthy", message: "cache down" }),
      });
      health.register({
        name: "db",
        check: () => ({ status: "healthy" }),
      });

      const result = await health.check();
      expect(result.status).toBe("degraded");
    });

    it("should return degraded when any check is degraded", async () => {
      health.register({
        name: "slow-service",
        check: () => ({ status: "degraded", message: "high latency" }),
      });
      health.register({
        name: "db",
        check: () => ({ status: "healthy" }),
      });

      const result = await health.check();
      expect(result.status).toBe("degraded");
    });

    it("should treat checks without explicit critical flag as critical (default true)", async () => {
      health.register({
        name: "implicit-critical",
        // critical is not set, should default to true
        check: () => ({ status: "unhealthy", message: "down" }),
      });

      const result = await health.check();
      expect(result.status).toBe("unhealthy");
    });

    it("should return healthy with no registered checks", async () => {
      const result = await health.check();
      expect(result.status).toBe("healthy");
      expect(Object.keys(result.checks)).toHaveLength(0);
    });

    it("should include uptime and timestamp in response", async () => {
      const result = await health.check();
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
      // Verify timestamp is a valid ISO string
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });

    it("should include latencyMs for each check result", async () => {
      health.register({
        name: "with-latency",
        check: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { status: "healthy" as const };
        },
      });

      const result = await health.check();
      expect(result.checks["with-latency"].latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should preserve latencyMs from check if provided", async () => {
      health.register({
        name: "explicit-latency",
        check: () => ({ status: "healthy", latencyMs: 42 }),
      });

      const result = await health.check();
      expect(result.checks["explicit-latency"].latencyMs).toBe(42);
    });
  });

  // ------------------------------------------
  // check() - timeout handling
  // ------------------------------------------
  describe("check() timeout handling", () => {
    it("should mark check as unhealthy when it times out", async () => {
      health.register({
        name: "slow-check",
        check: async () => {
          // Exceeds the 500ms checkTimeout
          await new Promise((r) => setTimeout(r, 1000));
          return { status: "healthy" };
        },
      });

      const result = await health.check();
      expect(result.checks["slow-check"].status).toBe("unhealthy");
      expect(result.checks["slow-check"].message).toContain("timed out");
    });

    it("should mark overall status unhealthy when critical check times out", async () => {
      health.register({
        name: "critical-slow",
        critical: true,
        check: async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return { status: "healthy" };
        },
      });

      const result = await health.check();
      expect(result.status).toBe("unhealthy");
    });

    it("should mark overall status degraded when non-critical check times out", async () => {
      health.register({
        name: "noncritical-slow",
        critical: false,
        check: async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return { status: "healthy" };
        },
      });

      const result = await health.check();
      expect(result.status).toBe("degraded");
    });
  });

  // ------------------------------------------
  // check() - error handling
  // ------------------------------------------
  describe("check() error handling", () => {
    it("should catch exceptions thrown by check and mark as unhealthy", async () => {
      health.register({
        name: "throwing-check",
        check: () => {
          throw new Error("boom");
        },
      });

      const result = await health.check();
      expect(result.checks["throwing-check"].status).toBe("unhealthy");
      expect(result.checks["throwing-check"].message).toBe("boom");
    });

    it("should catch rejected promises and mark as unhealthy", async () => {
      health.register({
        name: "rejecting-check",
        check: async () => {
          throw new Error("async boom");
        },
      });

      const result = await health.check();
      expect(result.checks["rejecting-check"].status).toBe("unhealthy");
      expect(result.checks["rejecting-check"].message).toBe("async boom");
    });
  });

  // ------------------------------------------
  // liveness()
  // ------------------------------------------
  describe("liveness()", () => {
    it("should return healthy when not shutting down", () => {
      const result = health.liveness(false);
      expect(result.status).toBe("healthy");
    });

    it("should return unhealthy when shutting down", () => {
      const result = health.liveness(true);
      expect(result.status).toBe("unhealthy");
    });

    it("should include uptime and timestamp", () => {
      const result = health.liveness(false);
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
    });

    it("should return empty checks (no external checks run)", () => {
      health.register({
        name: "should-not-run",
        check: () => {
          throw new Error("should not be called");
        },
      });

      const result = health.liveness(false);
      expect(Object.keys(result.checks)).toHaveLength(0);
    });
  });

  // ------------------------------------------
  // createHealth with initial checks config
  // ------------------------------------------
  describe("initial config checks", () => {
    it("should register checks passed via config", async () => {
      const h = createHealth({
        dbCheck: false,
        checks: [
          { name: "from-config", check: () => ({ status: "healthy" as const }) },
        ],
      });

      const result = await h.check();
      expect(result.checks).toHaveProperty("from-config");
    });
  });
});

// ==========================================
// Database Health Check
// ==========================================
describe("createDbHealthCheck", () => {
  it("should return healthy for a working database", async () => {
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const check = createDbHealthCheck(db);
    const result = await check.check();

    expect(result.status).toBe("healthy");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    await db.destroy();
  });

  it("should be marked as critical", () => {
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const check = createDbHealthCheck(db);
    expect(check.critical).toBe(true);

    db.destroy();
  });

  it("should return unhealthy when database query fails", async () => {
    // Create a mock Kysely-like object whose queries always reject
    const brokenDb = {
      selectFrom: () => ({
        select: () => ({
          execute: () => Promise.reject(new Error("connection lost")),
        }),
      }),
      dynamic: {
        ref: (v: string) => v,
      },
    } as unknown as Kysely<any>;

    const check = createDbHealthCheck(brokenDb);
    const result = await check.check();

    expect(result.status).toBe("unhealthy");
    expect(result.message).toBeDefined();
  });
});

// ==========================================
// Aggregation Edge Cases
// ==========================================
describe("Health aggregation edge cases", () => {
  it("unhealthy critical overrides degraded non-critical", async () => {
    const health = createHealth({ dbCheck: false });

    health.register({
      name: "non-crit-down",
      critical: false,
      check: () => ({ status: "unhealthy" }),
    });
    health.register({
      name: "crit-down",
      critical: true,
      check: () => ({ status: "unhealthy" }),
    });

    const result = await health.check();
    expect(result.status).toBe("unhealthy");
  });

  it("all checks run in parallel", async () => {
    const health = createHealth({ dbCheck: false, checkTimeout: 2000 });
    const startTimes: number[] = [];

    for (let i = 0; i < 3; i++) {
      health.register({
        name: `parallel-${i}`,
        check: async () => {
          startTimes.push(Date.now());
          await new Promise((r) => setTimeout(r, 50));
          return { status: "healthy" };
        },
      });
    }

    const before = Date.now();
    await health.check();
    const elapsed = Date.now() - before;

    // If all run in parallel, total time should be < 3x50ms = 150ms
    // Allow generous margin for CI, but it should certainly be less than 200ms
    expect(elapsed).toBeLessThan(200);

    // All checks should have started at roughly the same time
    const maxDiff = Math.max(...startTimes) - Math.min(...startTimes);
    expect(maxDiff).toBeLessThan(50);
  });
});
