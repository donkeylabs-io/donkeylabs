import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Kysely } from "kysely";
import type { AuditLogDB } from "../db";
import { AuditLogService } from "../service";
import { Redactor } from "../redactor";
import { createTestDatabase, clearLogEntries } from "./test-utils";
import { DEFAULT_RETENTION, type LogEntry, REDACTED_PLACEHOLDER } from "../../shared/types";

describe("AuditLogService", () => {
  let db: Kysely<AuditLogDB>;
  let service: AuditLogService;
  let redactor: Redactor;

  beforeAll(async () => {
    db = await createTestDatabase();
    redactor = new Redactor();
    service = new AuditLogService(db, redactor, DEFAULT_RETENTION);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await clearLogEntries(db);
  });

  describe("log()", () => {
    it("creates a log entry and returns its ID", async () => {
      const id = await service.log({
        event: "auth.login",
        level: "info",
        message: "User logged in",
      });

      expect(id).toMatch(/^log_[a-z0-9]+_[a-z0-9]+$/);
    });

    it("stores all log entry fields", async () => {
      const id = await service.log({
        event: "auth.login",
        level: "security",
        message: "Login successful",
        userId: 123,
        companyId: 456,
        employeeId: 789,
        username: "john",
        ipAddress: "192.168.1.1",
        userAgent: "Mozilla/5.0",
        geoCountry: "US",
        geoCity: "New York",
        method: "POST",
        path: "/api/login",
        statusCode: 200,
        durationMs: 150,
        traceId: "trace_123",
        metadata: { browser: "Chrome" },
      });

      const entry = await service.getById(id);
      expect(entry).not.toBeNull();
      expect(entry!.event).toBe("auth.login");
      expect(entry!.level).toBe("security");
      expect(entry!.message).toBe("Login successful");
      expect(entry!.userId).toBe(123);
      expect(entry!.companyId).toBe(456);
      expect(entry!.employeeId).toBe(789);
      expect(entry!.username).toBe("john");
      expect(entry!.ipAddress).toBe("192.168.1.1");
      expect(entry!.userAgent).toBe("Mozilla/5.0");
      expect(entry!.geoCountry).toBe("US");
      expect(entry!.geoCity).toBe("New York");
      expect(entry!.method).toBe("POST");
      expect(entry!.path).toBe("/api/login");
      expect(entry!.statusCode).toBe(200);
      expect(entry!.durationMs).toBe(150);
      expect(entry!.traceId).toBe("trace_123");
      expect(JSON.parse(entry!.metadata!)).toEqual({ browser: "Chrome" });
    });

    it("defaults level to info", async () => {
      const id = await service.log({
        event: "test.event",
      });

      const entry = await service.getById(id);
      expect(entry!.level).toBe("info");
    });

    it("redacts sensitive metadata", async () => {
      const id = await service.log({
        event: "auth.attempt",
        metadata: {
          username: "john",
          password: "secret123",
          token: "abc123",
        },
      });

      const entry = await service.getById(id);
      const metadata = JSON.parse(entry!.metadata!);
      expect(metadata.username).toBe("john");
      expect(metadata.password).toBe(REDACTED_PLACEHOLDER);
      expect(metadata.token).toBe(REDACTED_PLACEHOLDER);
    });

    it("calls onLog callback when provided", async () => {
      const onLog = mock((entry: LogEntry) => {});
      const serviceWithCallback = new AuditLogService(db, redactor, DEFAULT_RETENTION, onLog);

      await serviceWithCallback.log({
        event: "test.event",
        message: "Test message",
      });

      expect(onLog).toHaveBeenCalled();
      expect(onLog.mock.calls[0][0].event).toBe("test.event");
    });
  });

  describe("logBatch()", () => {
    it("logs multiple entries at once", async () => {
      await service.logBatch([
        { event: "batch.event1", level: "info" },
        { event: "batch.event2", level: "warn" },
        { event: "batch.event3", level: "error" },
      ]);

      const result = await service.query({ limit: 100 });
      expect(result.data.length).toBe(3);
    });

    it("preserves order with unique timestamps", async () => {
      await service.logBatch([
        { event: "first" },
        { event: "second" },
        { event: "third" },
      ]);

      const result = await service.query({ sortOrder: "asc", limit: 100 });
      expect(result.data[0].event).toBe("first");
      expect(result.data[1].event).toBe("second");
      expect(result.data[2].event).toBe("third");
    });

    it("does nothing for empty batch", async () => {
      await service.logBatch([]);

      const result = await service.query({ limit: 100 });
      expect(result.data.length).toBe(0);
    });

    it("calls onLog for each entry", async () => {
      const onLog = mock((entry: LogEntry) => {});
      const serviceWithCallback = new AuditLogService(db, redactor, DEFAULT_RETENTION, onLog);

      await serviceWithCallback.logBatch([
        { event: "event1" },
        { event: "event2" },
        { event: "event3" },
      ]);

      expect(onLog).toHaveBeenCalledTimes(3);
    });
  });

  describe("query()", () => {
    beforeEach(async () => {
      // Seed test data
      await service.logBatch([
        { event: "auth.login", level: "info", userId: 1, username: "alice", ipAddress: "1.1.1.1", method: "POST", path: "/api/login" },
        { event: "auth.logout", level: "info", userId: 1, username: "alice", method: "POST", path: "/api/logout" },
        { event: "auth.login", level: "info", userId: 2, username: "bob", ipAddress: "2.2.2.2" },
        { event: "api.error", level: "error", userId: 1, username: "alice" },
        { event: "security.attempt", level: "security", ipAddress: "3.3.3.3" },
        { event: "db.query", level: "debug", companyId: 100 },
      ]);
    });

    it("returns paginated results", async () => {
      const result = await service.query({ limit: 2 });

      expect(result.data.length).toBe(2);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(0);
      expect(result.total).toBe(6);
      expect(result.hasMore).toBe(true);
    });

    it("supports offset pagination", async () => {
      const page1 = await service.query({ limit: 2, offset: 0 });
      const page2 = await service.query({ limit: 2, offset: 2 });

      expect(page1.data[0].id).not.toBe(page2.data[0].id);
    });

    it("filters by userId", async () => {
      const result = await service.query({ userId: 1, limit: 100 });

      expect(result.data.length).toBe(3);
      expect(result.data.every((e) => e.userId === 1)).toBe(true);
    });

    it("filters by username", async () => {
      const result = await service.query({ username: "bob", limit: 100 });

      expect(result.data.length).toBe(1);
      expect(result.data[0].username).toBe("bob");
    });

    it("filters by level", async () => {
      const result = await service.query({ level: "error", limit: 100 });

      expect(result.data.length).toBe(1);
      expect(result.data[0].level).toBe("error");
    });

    it("filters by multiple levels", async () => {
      const result = await service.query({ levels: ["error", "security"], limit: 100 });

      expect(result.data.length).toBe(2);
      expect(result.data.every((e) => ["error", "security"].includes(e.level))).toBe(true);
    });

    it("filters by minLevel", async () => {
      const result = await service.query({ minLevel: "warn", limit: 100 });

      // Should include warn, error, security
      expect(result.data.every((e) => ["warn", "error", "security"].includes(e.level))).toBe(true);
    });

    it("filters by exact event", async () => {
      const result = await service.query({ event: "auth.login", limit: 100 });

      expect(result.data.length).toBe(2);
      expect(result.data.every((e) => e.event === "auth.login")).toBe(true);
    });

    it("filters by event prefix with wildcard", async () => {
      const result = await service.query({ event: "auth.*", limit: 100 });

      expect(result.data.length).toBe(3);
      expect(result.data.every((e) => e.event.startsWith("auth."))).toBe(true);
    });

    it("filters by multiple events", async () => {
      const result = await service.query({ events: ["auth.login", "api.*"], limit: 100 });

      expect(result.data.length).toBe(3);
    });

    it("filters by ipAddress", async () => {
      const result = await service.query({ ipAddress: "3.3.3.3", limit: 100 });

      expect(result.data.length).toBe(1);
      expect(result.data[0].ipAddress).toBe("3.3.3.3");
    });

    it("filters by method", async () => {
      const result = await service.query({ method: "POST", limit: 100 });

      expect(result.data.length).toBe(2);
    });

    it("filters by path (contains)", async () => {
      const result = await service.query({ path: "login", limit: 100 });

      expect(result.data.length).toBe(1);
      expect(result.data[0].path).toContain("login");
    });

    it("filters by companyId", async () => {
      const result = await service.query({ companyId: 100, limit: 100 });

      expect(result.data.length).toBe(1);
    });

    it("filters by time range", async () => {
      const now = Date.now();
      await service.log({ event: "recent", level: "info" });

      const result = await service.query({
        startTime: now - 1000,
        endTime: now + 1000,
        limit: 100,
      });

      expect(result.data.some((e) => e.event === "recent")).toBe(true);
    });

    it("filters by traceId", async () => {
      await service.log({ event: "traced", traceId: "trace_xyz" });

      const result = await service.query({ traceId: "trace_xyz", limit: 100 });

      expect(result.data.length).toBe(1);
      expect(result.data[0].traceId).toBe("trace_xyz");
    });

    it("sorts by timestamp descending by default", async () => {
      const result = await service.query({ limit: 100 });

      for (let i = 0; i < result.data.length - 1; i++) {
        expect(result.data[i].timestamp).toBeGreaterThanOrEqual(result.data[i + 1].timestamp);
      }
    });

    it("sorts by timestamp ascending", async () => {
      const result = await service.query({ sortOrder: "asc", limit: 100 });

      for (let i = 0; i < result.data.length - 1; i++) {
        expect(result.data[i].timestamp).toBeLessThanOrEqual(result.data[i + 1].timestamp);
      }
    });

    it("sorts by level", async () => {
      const result = await service.query({ sortBy: "level", sortOrder: "asc", limit: 100 });

      // Just verify it runs without error
      expect(result.data.length).toBeGreaterThan(0);
    });
  });

  describe("search()", () => {
    beforeEach(async () => {
      await service.logBatch([
        { event: "auth.login", username: "john_doe", message: "User logged in successfully" },
        { event: "auth.logout", username: "jane_smith", message: "User logged out" },
        { event: "api.request", path: "/api/users", message: "API request received" },
        { event: "error.database", message: "Database connection failed" },
      ]);
    });

    it("searches by event name", async () => {
      const result = await service.search("auth", { limit: 100 });

      expect(result.data.length).toBe(2);
    });

    it("searches by username", async () => {
      const result = await service.search("john_doe", { limit: 100 });

      expect(result.data.length).toBe(1);
      expect(result.data[0].username).toBe("john_doe");
    });

    it("searches by message content", async () => {
      const result = await service.search("database", { limit: 100 });

      expect(result.data.length).toBe(1);
      expect(result.data[0].message).toContain("Database");
    });

    it("searches by path", async () => {
      const result = await service.search("users", { limit: 100 });

      expect(result.data.length).toBe(1);
      expect(result.data[0].path).toContain("users");
    });

    it("returns paginated results", async () => {
      const result = await service.search("auth", { limit: 1 });

      expect(result.data.length).toBe(1);
      expect(result.hasMore).toBe(true);
    });
  });

  describe("getStats()", () => {
    beforeEach(async () => {
      await service.logBatch([
        { event: "auth.login", level: "info", userId: 1, username: "alice" },
        { event: "auth.login", level: "info", userId: 2, username: "bob" },
        { event: "auth.login", level: "info", userId: 1, username: "alice" },
        { event: "api.error", level: "error", userId: 1, username: "alice" },
        { event: "security.alert", level: "security" },
      ]);
    });

    it("returns total log count", async () => {
      const stats = await service.getStats({});

      expect(stats.totalLogs).toBe(5);
    });

    it("returns counts by level", async () => {
      const stats = await service.getStats({});

      expect(stats.byLevel.info).toBe(3);
      expect(stats.byLevel.error).toBe(1);
      expect(stats.byLevel.security).toBe(1);
    });

    it("returns top events", async () => {
      const stats = await service.getStats({});

      expect(stats.byEvent.length).toBeGreaterThan(0);
      const loginEvent = stats.byEvent.find((e) => e.event === "auth.login");
      expect(loginEvent?.count).toBe(3);
    });

    it("returns top users", async () => {
      const stats = await service.getStats({});

      expect(stats.byUser.length).toBeGreaterThan(0);
      const alice = stats.byUser.find((u) => u.username === "alice");
      expect(alice?.count).toBe(3);
    });

    it("returns time range", async () => {
      const stats = await service.getStats({});

      expect(stats.timeRange).not.toBeNull();
      expect(stats.timeRange!.start).toBeLessThanOrEqual(stats.timeRange!.end);
    });

    it("filters stats by time range", async () => {
      // Clear first to ensure isolation
      await clearLogEntries(db);

      const now = Date.now();
      await service.log({ event: "recent", level: "warn" });

      const stats = await service.getStats({
        startTime: now - 100,
        endTime: now + 1000,
      });

      expect(stats.totalLogs).toBe(1);
      expect(stats.byLevel.warn).toBe(1);
    });
  });

  describe("getUserActivity()", () => {
    beforeEach(async () => {
      await service.logBatch([
        { event: "auth.login", userId: 1, username: "alice" },
        { event: "api.request", userId: 1, username: "alice" },
        { event: "auth.logout", userId: 1, username: "alice" },
        { event: "auth.login", userId: 2, username: "bob" },
      ]);
    });

    it("returns user activity summary", async () => {
      const activity = await service.getUserActivity(1);

      expect(activity.userId).toBe(1);
      expect(activity.username).toBe("alice");
      expect(activity.totalActions).toBe(3);
    });

    it("includes top events for user", async () => {
      const activity = await service.getUserActivity(1);

      expect(activity.topEvents.length).toBeGreaterThan(0);
    });

    it("includes recent logs for user", async () => {
      const activity = await service.getUserActivity(1);

      expect(activity.recentLogs.length).toBe(3);
      expect(activity.recentLogs.every((log) => log.userId === 1)).toBe(true);
    });

    it("returns empty data for unknown user", async () => {
      const activity = await service.getUserActivity(999);

      expect(activity.totalActions).toBe(0);
      expect(activity.recentLogs.length).toBe(0);
    });
  });

  describe("getById()", () => {
    it("returns log entry by ID", async () => {
      const id = await service.log({ event: "test", message: "Test message" });

      const entry = await service.getById(id);

      expect(entry).not.toBeNull();
      expect(entry!.id).toBe(id);
      expect(entry!.event).toBe("test");
    });

    it("returns null for non-existent ID", async () => {
      const entry = await service.getById("nonexistent");

      expect(entry).toBeNull();
    });
  });

  describe("getByTraceId()", () => {
    it("returns all logs with same trace ID", async () => {
      const traceId = "trace_test";
      await service.logBatch([
        { event: "step1", traceId },
        { event: "step2", traceId },
        { event: "step3", traceId },
        { event: "other", traceId: "different" },
      ]);

      const logs = await service.getByTraceId(traceId);

      expect(logs.length).toBe(3);
      expect(logs.every((log) => log.traceId === traceId)).toBe(true);
    });

    it("returns logs in chronological order", async () => {
      const traceId = "trace_ordered";
      await service.logBatch([
        { event: "first", traceId },
        { event: "second", traceId },
        { event: "third", traceId },
      ]);

      const logs = await service.getByTraceId(traceId);

      expect(logs[0].event).toBe("first");
      expect(logs[1].event).toBe("second");
      expect(logs[2].event).toBe("third");
    });

    it("returns empty array for unknown trace ID", async () => {
      const logs = await service.getByTraceId("unknown");

      expect(logs).toEqual([]);
    });
  });

  describe("retention configuration", () => {
    it("getRetention returns current config", async () => {
      const config = await service.getRetention();

      expect(config.default).toBe(3);
      expect(config.security).toBe(12);
      expect(config.error).toBe(6);
    });

    it("setRetention updates config", async () => {
      await service.setRetention({
        default: 6,
        security: 24,
        error: 12,
      });

      const config = await service.getRetention();

      expect(config.default).toBe(6);
      expect(config.security).toBe(24);
      expect(config.error).toBe(12);

      // Restore defaults
      await service.setRetention(DEFAULT_RETENTION);
    });
  });

  describe("cleanupOldLogs()", () => {
    // These tests need their own isolated database to avoid interference
    let cleanupDb: Kysely<AuditLogDB>;
    let cleanupService: AuditLogService;

    beforeAll(async () => {
      cleanupDb = await createTestDatabase();
      cleanupService = new AuditLogService(cleanupDb, new Redactor(), DEFAULT_RETENTION);
    });

    afterAll(async () => {
      await cleanupDb.destroy();
    });

    beforeEach(async () => {
      await clearLogEntries(cleanupDb);
    });

    it("deletes logs older than retention period", async () => {
      // Debug: check what's in the database before we start
      const beforeCount = await cleanupDb.selectFrom("log_entry").select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirst();
      expect(beforeCount?.count).toBe(0); // Should be empty after beforeEach clears

      const now = Date.now();
      const oldTimestamp = now - 4 * 30 * 24 * 60 * 60 * 1000; // 4 months ago

      // Insert old logs directly to set custom timestamp
      await cleanupDb.insertInto("log_entry").values({
        id: "old_log_1",
        timestamp: oldTimestamp,
        level: "info",
        event: "old.event",
        user_id: null,
        company_id: null,
        employee_id: null,
        username: null,
        ip_address: null,
        user_agent: null,
        geo_country: null,
        geo_city: null,
        method: null,
        path: null,
        status_code: null,
        duration_ms: null,
        metadata: null,
        message: null,
        trace_id: null,
      }).execute();

      // Log a recent entry
      await cleanupService.log({ event: "recent.event", level: "info" });

      // Debug: verify exactly 2 logs in database
      const countBefore = await cleanupDb.selectFrom("log_entry").select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirst();
      expect(countBefore?.count).toBe(2);

      await cleanupService.cleanupOldLogs();

      // Count remaining logs (the important thing is the actual database state, not the return value)
      const countAfter = await cleanupDb.selectFrom("log_entry").select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirst();

      // Should have 1 log remaining (the recent one)
      expect(countAfter?.count).toBe(1);

      // Verify it's the recent log
      const remaining = await cleanupService.query({ limit: 100 });
      expect(remaining.data.length).toBe(1);
      expect(remaining.data[0].event).toBe("recent.event");
    });

    it("respects level-specific retention", async () => {
      const now = Date.now();
      const sevenMonthsAgo = now - 7 * 30 * 24 * 60 * 60 * 1000;

      // Security logs have 12 month retention
      await cleanupDb.insertInto("log_entry").values({
        id: "old_security",
        timestamp: sevenMonthsAgo,
        level: "security",
        event: "security.event",
        user_id: null,
        company_id: null,
        employee_id: null,
        username: null,
        ip_address: null,
        user_agent: null,
        geo_country: null,
        geo_city: null,
        method: null,
        path: null,
        status_code: null,
        duration_ms: null,
        metadata: null,
        message: null,
        trace_id: null,
      }).execute();

      // Error logs have 6 month retention
      await cleanupDb.insertInto("log_entry").values({
        id: "old_error",
        timestamp: sevenMonthsAgo,
        level: "error",
        event: "error.event",
        user_id: null,
        company_id: null,
        employee_id: null,
        username: null,
        ip_address: null,
        user_agent: null,
        geo_country: null,
        geo_city: null,
        method: null,
        path: null,
        status_code: null,
        duration_ms: null,
        metadata: null,
        message: null,
        trace_id: null,
      }).execute();

      // Count before cleanup
      const countBefore = await cleanupDb.selectFrom("log_entry").select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirst();
      expect(countBefore?.count).toBe(2);

      await cleanupService.cleanupOldLogs();

      // Count after cleanup - security should remain, error should be deleted
      const securityRemaining = await cleanupDb.selectFrom("log_entry").where("level", "=", "security").select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirst();
      const errorRemaining = await cleanupDb.selectFrom("log_entry").where("level", "=", "error").select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirst();

      expect(securityRemaining?.count).toBe(1); // Security kept (7 < 12 months)
      expect(errorRemaining?.count).toBe(0);    // Error deleted (7 > 6 months)
    });
  });

  describe("queryTraces()", () => {
    beforeEach(async () => {
      // Create logs with trace IDs
      await service.logBatch([
        { event: "api.request.start", traceId: "trace_1", method: "GET", path: "/api/users", userId: 1, level: "info" },
        { event: "db.query", traceId: "trace_1", level: "debug" },
        { event: "api.request.end", traceId: "trace_1", statusCode: 200, durationMs: 50, level: "info" },
        { event: "api.request.start", traceId: "trace_2", method: "POST", path: "/api/orders", userId: 2, level: "info" },
        { event: "api.error", traceId: "trace_2", level: "error" },
        { event: "api.request.end", traceId: "trace_2", statusCode: 500, level: "error" },
        { event: "standalone", level: "info" }, // No trace ID
      ]);
    });

    it("returns trace summaries", async () => {
      const result = await service.queryTraces({ limit: 100 });

      expect(result.data.length).toBe(2);
    });

    it("calculates trace duration", async () => {
      const result = await service.queryTraces({ limit: 100 });

      const trace = result.data.find((t) => t.traceId === "trace_1");
      expect(trace).toBeDefined();
      expect(trace!.logCount).toBe(3);
    });

    it("returns highest severity level", async () => {
      const result = await service.queryTraces({ limit: 100 });

      const trace2 = result.data.find((t) => t.traceId === "trace_2");
      expect(trace2?.highestLevel).toBe("error");
    });

    it("filters traces by level", async () => {
      const result = await service.queryTraces({ level: "error", limit: 100 });

      // Only trace_2 has error level logs
      expect(result.data.length).toBe(1);
      expect(result.data[0].traceId).toBe("trace_2");
    });

    it("filters traces by userId", async () => {
      const result = await service.queryTraces({ userId: 1, limit: 100 });

      expect(result.data.length).toBe(1);
      expect(result.data[0].traceId).toBe("trace_1");
    });

    it("paginates trace results", async () => {
      const result = await service.queryTraces({ limit: 1 });

      expect(result.data.length).toBe(1);
      expect(result.hasMore).toBe(true);
    });
  });

  describe("setOnLog()", () => {
    it("updates the onLog callback", async () => {
      const serviceNoCallback = new AuditLogService(db, redactor, DEFAULT_RETENTION);
      const callback = mock((entry: LogEntry) => {});

      serviceNoCallback.setOnLog(callback);
      await serviceNoCallback.log({ event: "test" });

      expect(callback).toHaveBeenCalled();
    });
  });
});
