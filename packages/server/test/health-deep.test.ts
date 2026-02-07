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
// Health: Concurrent check() calls
// ==========================================

describe("Health - concurrent check() calls", () => {
  it("should handle multiple concurrent check() calls without interference", async () => {
    const health = createHealth({ dbCheck: false, checkTimeout: 2000 });
    let callCount = 0;

    health.register({
      name: "counting",
      check: async () => {
        callCount++;
        await new Promise(r => setTimeout(r, 50));
        return { status: "healthy" };
      },
    });

    // Fire 5 concurrent health checks
    const results = await Promise.all([
      health.check(),
      health.check(),
      health.check(),
      health.check(),
      health.check(),
    ]);

    // Each call should produce an independent result
    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.status).toBe("healthy");
      expect(result.checks).toHaveProperty("counting");
    }

    // The check function should have been called 5 times (once per check() call)
    expect(callCount).toBe(5);
  });
});

// ==========================================
// Health: Synchronous check functions
// ==========================================

describe("Health - synchronous check functions", () => {
  it("should work with synchronous check returning HealthCheckResult", async () => {
    const health = createHealth({ dbCheck: false });

    health.register({
      name: "sync-check",
      check: () => ({ status: "healthy" as const, message: "all good" }),
    });

    const result = await health.check();
    expect(result.status).toBe("healthy");
    expect(result.checks["sync-check"].status).toBe("healthy");
    expect(result.checks["sync-check"].message).toBe("all good");
  });

  it("should catch synchronous exceptions in check functions", async () => {
    const health = createHealth({ dbCheck: false });

    health.register({
      name: "sync-throw",
      check: () => {
        throw new Error("sync exception");
      },
    });

    const result = await health.check();
    expect(result.checks["sync-throw"].status).toBe("unhealthy");
    expect(result.checks["sync-throw"].message).toBe("sync exception");
  });
});

// ==========================================
// Health: Mixed status aggregation priority
// ==========================================

describe("Health - mixed status aggregation priority", () => {
  it("should prioritize unhealthy over degraded", async () => {
    const health = createHealth({ dbCheck: false });

    health.register({
      name: "degraded-service",
      critical: false,
      check: () => ({ status: "unhealthy" as const }),
    });
    health.register({
      name: "slow-service",
      check: () => ({ status: "degraded" as const }),
    });
    health.register({
      name: "critical-down",
      critical: true,
      check: () => ({ status: "unhealthy" as const }),
    });

    const result = await health.check();
    expect(result.status).toBe("unhealthy");
  });

  it("should remain healthy when all checks return healthy", async () => {
    const health = createHealth({ dbCheck: false });

    for (let i = 0; i < 5; i++) {
      health.register({
        name: `healthy-${i}`,
        check: () => ({ status: "healthy" as const }),
      });
    }

    const result = await health.check();
    expect(result.status).toBe("healthy");
  });

  it("should be degraded when only non-critical checks fail", async () => {
    const health = createHealth({ dbCheck: false });

    health.register({
      name: "critical-ok",
      critical: true,
      check: () => ({ status: "healthy" as const }),
    });
    health.register({
      name: "noncrit-fail-1",
      critical: false,
      check: () => ({ status: "unhealthy" as const }),
    });
    health.register({
      name: "noncrit-fail-2",
      critical: false,
      check: () => ({ status: "unhealthy" as const }),
    });

    const result = await health.check();
    expect(result.status).toBe("degraded");
  });

  it("should be unhealthy when a critical check fails even if others are healthy", async () => {
    const health = createHealth({ dbCheck: false });

    health.register({
      name: "critical-fail",
      critical: true,
      check: () => ({ status: "unhealthy" as const }),
    });
    health.register({
      name: "all-good-1",
      check: () => ({ status: "healthy" as const }),
    });
    health.register({
      name: "all-good-2",
      check: () => ({ status: "healthy" as const }),
    });

    const result = await health.check();
    expect(result.status).toBe("unhealthy");
  });
});

// ==========================================
// Health: Timeout edge cases
// ==========================================

describe("Health - timeout edge cases", () => {
  it("should use configured checkTimeout value", async () => {
    // Use a very short timeout to trigger timeout
    const health = createHealth({ dbCheck: false, checkTimeout: 50 });

    health.register({
      name: "slow",
      check: async () => {
        await new Promise(r => setTimeout(r, 200));
        return { status: "healthy" };
      },
    });

    const result = await health.check();
    expect(result.checks["slow"].status).toBe("unhealthy");
    expect(result.checks["slow"].message).toContain("timed out");
  });

  it("should complete quickly when check finishes within timeout", async () => {
    const health = createHealth({ dbCheck: false, checkTimeout: 5000 });

    health.register({
      name: "fast",
      check: async () => {
        await new Promise(r => setTimeout(r, 10));
        return { status: "healthy" };
      },
    });

    const start = Date.now();
    const result = await health.check();
    const elapsed = Date.now() - start;

    expect(result.checks["fast"].status).toBe("healthy");
    expect(elapsed).toBeLessThan(1000); // Should finish way before timeout
  });

  it("should not affect healthy checks when one check times out", async () => {
    const health = createHealth({ dbCheck: false, checkTimeout: 100 });

    health.register({
      name: "timeouter",
      critical: false,
      check: async () => {
        await new Promise(r => setTimeout(r, 500));
        return { status: "healthy" };
      },
    });
    health.register({
      name: "fast-one",
      check: () => ({ status: "healthy" as const }),
    });

    const result = await health.check();
    expect(result.checks["fast-one"].status).toBe("healthy");
    expect(result.checks["timeouter"].status).toBe("unhealthy");
  });
});

// ==========================================
// Health: latencyMs accuracy
// ==========================================

describe("Health - latencyMs measurement", () => {
  it("should measure latency for async checks", async () => {
    const health = createHealth({ dbCheck: false, checkTimeout: 5000 });

    health.register({
      name: "timed",
      check: async () => {
        await new Promise(r => setTimeout(r, 50));
        return { status: "healthy" };
      },
    });

    const result = await health.check();
    const latency = result.checks["timed"].latencyMs!;
    expect(latency).toBeGreaterThanOrEqual(40); // Some tolerance
    expect(latency).toBeLessThan(500);
  });

  it("should measure near-zero latency for synchronous checks", async () => {
    const health = createHealth({ dbCheck: false });

    health.register({
      name: "instant",
      check: () => ({ status: "healthy" }),
    });

    const result = await health.check();
    expect(result.checks["instant"].latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checks["instant"].latencyMs!).toBeLessThan(50);
  });

  it("should not override latencyMs when check provides its own", async () => {
    const health = createHealth({ dbCheck: false });

    health.register({
      name: "custom-latency",
      check: () => ({ status: "healthy", latencyMs: 999 }),
    });

    const result = await health.check();
    expect(result.checks["custom-latency"].latencyMs).toBe(999);
  });
});

// ==========================================
// Health: liveness() details
// ==========================================

describe("Health - liveness() behavior", () => {
  it("should return increasing uptime across consecutive calls", async () => {
    const health = createHealth({ dbCheck: false });

    const result1 = health.liveness(false);
    await new Promise(r => setTimeout(r, 1100));
    const result2 = health.liveness(false);

    expect(result2.uptime).toBeGreaterThanOrEqual(result1.uptime);
  });

  it("should return valid ISO timestamp on every call", () => {
    const health = createHealth({ dbCheck: false });
    const result = health.liveness(false);

    const parsed = new Date(result.timestamp);
    expect(parsed.toISOString()).toBe(result.timestamp);
    expect(parsed.getTime()).toBeGreaterThan(0);
  });
});

// ==========================================
// Health: register() after check()
// ==========================================

describe("Health - dynamic registration", () => {
  it("should include checks registered after initial check() calls", async () => {
    const health = createHealth({ dbCheck: false });

    // First check with no checks
    const result1 = await health.check();
    expect(Object.keys(result1.checks)).toHaveLength(0);

    // Register a check
    health.register({
      name: "late-check",
      check: () => ({ status: "healthy" }),
    });

    // Should now include the new check
    const result2 = await health.check();
    expect(result2.checks).toHaveProperty("late-check");
    expect(result2.checks["late-check"].status).toBe("healthy");
  });
});

// ==========================================
// Health: createDbHealthCheck edge cases
// ==========================================

describe("Health - createDbHealthCheck detailed", () => {
  it("should include latencyMs in healthy response", async () => {
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const check = createDbHealthCheck(db);
    const result = await check.check();

    expect(result.status).toBe("healthy");
    expect(result.latencyMs).toBeDefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    await db.destroy();
  });

  it("should include latencyMs in unhealthy response", async () => {
    const brokenDb = {
      selectFrom: () => ({
        select: () => ({
          execute: () => Promise.reject(new Error("broken")),
        }),
      }),
      dynamic: { ref: (v: string) => v },
    } as unknown as Kysely<any>;

    const check = createDbHealthCheck(brokenDb);
    const result = await check.check();

    expect(result.status).toBe("unhealthy");
    expect(result.latencyMs).toBeDefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should report as critical check", () => {
    const db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    const check = createDbHealthCheck(db);
    expect(check.critical).toBe(true);
    expect(check.name).toBe("database");

    db.destroy();
  });
});
