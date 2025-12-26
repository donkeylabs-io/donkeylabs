import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Logger, logger, getRequestContext, runWithRequestContext, generateTraceId } from "../logger";
import { AuditLogSystem } from "../server/index";

describe("Route-style logging (simulates router behavior)", () => {
  let auditSystem: AuditLogSystem;

  beforeEach(async () => {
    auditSystem = new AuditLogSystem({
      dbFile: ":memory:",
      runMigrations: true,
      jwtSecret: "test-secret-that-is-long-enough-32-chars",
    });
    await auditSystem.initialize();
    Logger.setGlobalAuditService(auditSystem.service);
  });

  afterEach(async () => {
    Logger.clearGlobalAuditService();
    await auditSystem.shutdown();
  });

  test("Logs from route handler should be persisted", async () => {
    const LOG = new Logger("Order");
    const traceId = generateTraceId();

    // Simulate what the router does
    await runWithRequestContext({
      traceId,
      startTime: Date.now(),
      method: "POST",
      path: "/api/order/create",
    }, async () => {
      // Router logs request.start
      logger.http.event("info", "request.start", { method: "POST", path: "/api/order/create" });

      // Route handler does its work and logs (using async to ensure persistence)
      await LOG.tag("Create").infoAsync("Order created", { orderId: 123 });

      // Router logs request.complete (awaited)
      await logger.http.eventAsync("info", "request.complete", {
        method: "POST",
        path: "/api/order/create",
        statusCode: 200,
        durationMs: 50,
      });
    });

    // Wait for any async writes
    await Bun.sleep(200);

    const logs = await auditSystem.service.query({
      limit: 10,
      offset: 0,
      sortBy: "timestamp",
      sortOrder: "asc"
    });

    console.log("Logs found:", logs.data.length);
    logs.data.forEach(log => {
      console.log("  -", log.event, "|", log.message);
    });

    // Should have 3 logs: request.start, order.create.info, request.complete
    expect(logs.data.length).toBe(3);

    // Verify the order log is there
    const orderLog = logs.data.find(l => l.event.includes("order") || l.event.includes("create"));
    expect(orderLog).toBeDefined();
  });

  test("Fire-and-forget info() logs should still be persisted", async () => {
    const LOG = new Logger("Test");
    const traceId = generateTraceId();

    await runWithRequestContext({
      traceId,
      startTime: Date.now(),
      method: "GET",
      path: "/test",
    }, async () => {
      // Fire-and-forget log
      LOG.info("This is a fire-and-forget log");

      // Give time for async write
      await Bun.sleep(50);
    });

    await Bun.sleep(100);

    const logs = await auditSystem.service.query({
      limit: 10,
      offset: 0,
      sortBy: "timestamp",
      sortOrder: "desc"
    });

    expect(logs.data.length).toBe(1);
    expect(logs.data[0].message).toContain("fire-and-forget");
  });
});
