import { afterEach, describe, expect, it } from "bun:test";
import { serverStats } from "../index";

afterEach(() => {
  serverStats.resetStats();
});

describe("serverStats tracker", () => {
  it("aggregates request metrics and simplifies paths", () => {
    serverStats.resetStats();
    serverStats.trackRequest(
      "GET",
      "/orders/123",
      200,
      150,
      "🖥️  Desktop Browser",
      "Chrome",
      "alice",
      "MX",
    );

    const stats = serverStats.getStats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.errorCount).toBe(0);
    expect(stats.requestsByPath.get("/orders/:id")).toBe(1);
    expect(stats.requestsByCountry.get("MX")).toBe(1);
    expect(stats.authRequests).toBe(1);
    expect(stats.publicRequests).toBe(0);
    expect(stats.activeUsers.has("alice")).toBeTrue();
  });

  it("tracks database query metrics including slow queries", () => {
    serverStats.trackDatabaseQuery(50);
    serverStats.trackDatabaseQuery(150);

    const metrics = serverStats.getDbMetrics();
    expect(metrics.queryCount).toBe(2);
    expect(metrics.slowQueryCount).toBe(1);
    expect(metrics.avgQueryTime).toBeGreaterThan(0);
  });

  it("exposes system metrics with reasonable defaults", () => {
    const metrics = serverStats.getSystemMetrics();
    expect(metrics.memoryUsage.heapUsed).toBeGreaterThan(0);
    expect(metrics.cpuUsage.user).toBeGreaterThanOrEqual(0);
    expect(metrics.memoryPercentage).toBeGreaterThanOrEqual(0);
    expect(metrics.cpuPercentage).toBeGreaterThanOrEqual(0);
  });
});
