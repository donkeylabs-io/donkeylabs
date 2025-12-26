import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Logger, logger, getRequestContext, runWithRequestContext, generateTraceId } from "../logger";
import { AuditLogSystem } from "../server/index";

describe("Logger persistence with global audit service", () => {
  let auditSystem: AuditLogSystem;

  beforeEach(async () => {
    // Create audit system with in-memory database
    auditSystem = new AuditLogSystem({
      dbFile: ":memory:",
      runMigrations: true,
      jwtSecret: "test-secret-that-is-long-enough-32-chars",
    });
    await auditSystem.initialize();

    // Set global audit service
    Logger.setGlobalAuditService(auditSystem.service);
  });

  afterEach(async () => {
    Logger.clearGlobalAuditService();
    await auditSystem.shutdown();
  });

  test("Logger should use global audit service", () => {
    expect(Logger.hasGlobalAuditService).toBe(true);

    const log = new Logger("Test");
    expect(log.isAuditConnected).toBe(true);
  });

  test("Pre-configured loggers should use global audit service", () => {
    expect(logger.http.isAuditConnected).toBe(true);
    expect(logger.server.isAuditConnected).toBe(true);
    expect(logger.auth.isAuditConnected).toBe(true);
  });

  test("Logs outside request context should NOT be persisted (except security)", async () => {
    const LOG = new Logger("Test");

    // Log outside context
    LOG.tag("Outside").info("This should NOT be persisted");

    await Bun.sleep(100);

    const logs = await auditSystem.service.query({
      limit: 10,
      offset: 0,
      sortBy: "timestamp",
      sortOrder: "desc"
    });

    // Should have no logs (info without context is not persisted)
    expect(logs.data.length).toBe(0);
  });

  test("Logs inside request context SHOULD be persisted", async () => {
    const LOG = new Logger("Test");
    const traceId = generateTraceId();

    await runWithRequestContext({
      traceId,
      startTime: Date.now(),
      method: "GET",
      path: "/test"
    }, async () => {
      // Verify context exists
      const ctx = getRequestContext();
      expect(ctx).toBeDefined();
      expect(ctx?.traceId).toBe(traceId);

      // Log inside context
      LOG.tag("Inside").info("This SHOULD be persisted");
      LOG.tag("Inside").warn("This warning SHOULD be persisted");

      // Wait inside the context for async writes to complete
      await Bun.sleep(100);
    });

    // Additional wait after context exits
    await Bun.sleep(100);

    const logs = await auditSystem.service.query({
      limit: 10,
      offset: 0,
      sortBy: "timestamp",
      sortOrder: "desc"
    });

    // Should have 2 logs
    expect(logs.data.length).toBe(2);

    // Both should have the trace ID
    logs.data.forEach(log => {
      expect(log.traceId).toBe(traceId);
    });
  });

  test("Pre-configured loggers should persist inside request context", async () => {
    const traceId = generateTraceId();

    await runWithRequestContext({
      traceId,
      startTime: Date.now(),
      method: "POST",
      path: "/api/test"
    }, async () => {
      logger.http.info("HTTP request received");
      logger.auth.warn("Auth warning");
      // Wait inside context
      await Bun.sleep(100);
    });

    await Bun.sleep(100);

    const logs = await auditSystem.service.query({
      limit: 10,
      offset: 0,
      sortBy: "timestamp",
      sortOrder: "desc"
    });

    expect(logs.data.length).toBe(2);
    logs.data.forEach(log => {
      expect(log.traceId).toBe(traceId);
    });
  });

  test("Security logs should ALWAYS persist (even without context)", async () => {
    const LOG = new Logger("Test");

    // Security log outside context
    LOG.tag("Auth").security("suspicious_activity", { ip: "1.2.3.4" });

    await Bun.sleep(200);

    const logs = await auditSystem.service.query({
      limit: 10,
      offset: 0,
      sortBy: "timestamp",
      sortOrder: "desc"
    });

    // Security logs are always persisted
    expect(logs.data.length).toBe(1);
    expect(logs.data[0].level).toBe("security");
  });

  test("Context should include user info when set", async () => {
    const LOG = new Logger("Test");
    const traceId = generateTraceId();

    await runWithRequestContext({
      traceId,
      startTime: Date.now(),
      method: "GET",
      path: "/test",
      userId: 123,
      username: "testuser",
      employeeId: 456,
    }, async () => {
      LOG.tag("User").info("User action");
      // Wait inside context
      await Bun.sleep(100);
    });

    await Bun.sleep(100);

    const logs = await auditSystem.service.query({
      limit: 10,
      offset: 0,
      sortBy: "timestamp",
      sortOrder: "desc"
    });

    expect(logs.data.length).toBe(1);
    expect(logs.data[0].userId).toBe(123);
    expect(logs.data[0].username).toBe("testuser");
    expect(logs.data[0].employeeId).toBe(456);
  });
});
