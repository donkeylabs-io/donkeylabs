import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  Logger,
  TaggedLogger,
  generateTraceId,
  getRequestContext,
  runWithRequestContext,
  type IAuditLogService,
  type RequestContext,
} from "../logger";

describe("Logger", () => {
  beforeEach(() => {
    // Silence console output in tests
    Logger.setLevel("silent");
  });

  afterEach(() => {
    // Reset to default
    Logger.setLevel(null);
  });

  describe("constructor", () => {
    it("creates logger with prefix", () => {
      const log = new Logger("Test");
      expect(log).toBeDefined();
    });

    it("creates logger with options", () => {
      const mockAudit: IAuditLogService = {
        log: mock(() => Promise.resolve("id")),
      };
      const log = new Logger({ auditService: mockAudit });
      expect(log).toBeDefined();
      expect(log.isAuditConnected).toBe(true);
    });

    it("creates logger with prefix and options", () => {
      const mockAudit: IAuditLogService = {
        log: mock(() => Promise.resolve("id")),
      };
      const log = new Logger("Test", { auditService: mockAudit });
      expect(log).toBeDefined();
      expect(log.isAuditConnected).toBe(true);
    });
  });

  describe("tag()", () => {
    it("returns a TaggedLogger", () => {
      const log = new Logger();
      const tagged = log.tag("Auth");
      expect(tagged).toBeInstanceOf(TaggedLogger);
    });

    it("caches tagged loggers", () => {
      const log = new Logger();
      const tagged1 = log.tag("Auth");
      const tagged2 = log.tag("Auth");
      expect(tagged1).toBe(tagged2);
    });

    it("creates different loggers for different tags", () => {
      const log = new Logger();
      const auth = log.tag("Auth");
      const db = log.tag("DB");
      expect(auth).not.toBe(db);
    });
  });

  describe("connectAudit/disconnectAudit", () => {
    it("connects audit service", () => {
      const mockAudit: IAuditLogService = {
        log: mock(() => Promise.resolve("id")),
      };
      const log = new Logger();
      expect(log.isAuditConnected).toBe(false);

      log.connectAudit(mockAudit);
      expect(log.isAuditConnected).toBe(true);
    });

    it("disconnects audit service", () => {
      const mockAudit: IAuditLogService = {
        log: mock(() => Promise.resolve("id")),
      };
      const log = new Logger({ auditService: mockAudit });
      expect(log.isAuditConnected).toBe(true);

      log.disconnectAudit();
      expect(log.isAuditConnected).toBe(false);
    });
  });

  describe("log level control", () => {
    it("respects setLevel", () => {
      Logger.setLevel("warn");
      expect(Logger.getEffectiveLevel()).toBe("warn");

      Logger.setLevel("debug");
      expect(Logger.getEffectiveLevel()).toBe("debug");

      Logger.setLevel(null); // Reset
    });

    it("shouldLogLevel filters correctly", () => {
      Logger.setLevel("warn");

      // Below threshold
      expect(Logger.shouldLogLevel("debug")).toBe(false);
      expect(Logger.shouldLogLevel("info")).toBe(false);

      // At or above threshold
      expect(Logger.shouldLogLevel("warn")).toBe(true);
      expect(Logger.shouldLogLevel("error")).toBe(true);
      expect(Logger.shouldLogLevel("security")).toBe(true);

      Logger.setLevel(null);
    });

    it("silent level suppresses all output", () => {
      Logger.setLevel("silent");

      expect(Logger.shouldLogLevel("debug")).toBe(false);
      expect(Logger.shouldLogLevel("info")).toBe(false);
      expect(Logger.shouldLogLevel("warn")).toBe(false);
      expect(Logger.shouldLogLevel("error")).toBe(false);
      expect(Logger.shouldLogLevel("security")).toBe(false);

      Logger.setLevel(null);
    });
  });

  describe("Logger.silent()", () => {
    it("runs function with logs silenced", async () => {
      Logger.setLevel("debug");
      expect(Logger.getEffectiveLevel()).toBe("debug");

      await Logger.silent(() => {
        expect(Logger.getEffectiveLevel()).toBe("silent");
      });

      // Restored after
      expect(Logger.getEffectiveLevel()).toBe("debug");
      Logger.setLevel(null);
    });

    it("restores level even on error", async () => {
      Logger.setLevel("debug");

      try {
        await Logger.silent(() => {
          throw new Error("test error");
        });
      } catch {
        // Expected
      }

      expect(Logger.getEffectiveLevel()).toBe("debug");
      Logger.setLevel(null);
    });
  });

  describe("Logger.withLevel()", () => {
    it("runs function with specific level", async () => {
      Logger.setLevel("silent");

      await Logger.withLevel("debug", () => {
        expect(Logger.getEffectiveLevel()).toBe("debug");
      });

      expect(Logger.getEffectiveLevel()).toBe("silent");
      Logger.setLevel(null);
    });
  });

  describe("audit integration", () => {
    it("sends security logs to audit (always)", async () => {
      const mockLog = mock(() => Promise.resolve("id"));
      const mockAudit: IAuditLogService = { log: mockLog };

      const log = new Logger("Auth", { auditService: mockAudit });
      Logger.setLevel("debug"); // Enable logging

      log.security("suspicious_activity", { ip: "1.2.3.4" });

      // Allow async operations
      await new Promise((r) => setTimeout(r, 10));

      expect(mockLog).toHaveBeenCalled();
      const call = mockLog.mock.calls[0][0] as any;
      expect(call.level).toBe("security");
      expect(call.event).toContain("security.auth.suspicious_activity");
      expect(call.metadata).toEqual({ ip: "1.2.3.4" });

      Logger.setLevel(null);
    });

    it("sends logs to audit when in request context", async () => {
      const mockLog = mock(() => Promise.resolve("id"));
      const mockAudit: IAuditLogService = { log: mockLog };

      const log = new Logger("DB", { auditService: mockAudit });
      Logger.setLevel("debug");

      const ctx: RequestContext = {
        traceId: "trace_123",
        userId: 42,
        startTime: Date.now(),
      };

      runWithRequestContext(ctx, () => {
        log.warn("slow query");
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mockLog).toHaveBeenCalled();
      const call = mockLog.mock.calls[0][0] as any;
      expect(call.level).toBe("warn");
      expect(call.traceId).toBe("trace_123");
      expect(call.userId).toBe(42);

      Logger.setLevel(null);
    });

    it("does not send non-security logs without request context", async () => {
      const mockLog = mock(() => Promise.resolve("id"));
      const mockAudit: IAuditLogService = { log: mockLog };

      const log = new Logger("Test", { auditService: mockAudit });
      Logger.setLevel("debug");

      // Outside request context
      log.info("test message");
      log.warn("test warning");
      log.error("test error");

      await new Promise((r) => setTimeout(r, 10));

      // None of these should have been sent
      expect(mockLog).not.toHaveBeenCalled();

      Logger.setLevel(null);
    });
  });
});

describe("TaggedLogger", () => {
  beforeEach(() => {
    Logger.setLevel("silent");
  });

  afterEach(() => {
    Logger.setLevel(null);
  });

  describe("tag chaining", () => {
    it("chains multiple tags", () => {
      const log = new Logger();
      const tagged = log.tag("Auth").tag("Login");
      expect(tagged).toBeInstanceOf(TaggedLogger);
    });
  });

  describe("event()", () => {
    it("sends structured events to audit", async () => {
      const mockLog = mock(() => Promise.resolve("id"));
      const mockAudit: IAuditLogService = { log: mockLog };

      const log = new Logger({ auditService: mockAudit });
      Logger.setLevel("debug");

      const ctx: RequestContext = {
        traceId: "trace_456",
        startTime: Date.now(),
      };

      runWithRequestContext(ctx, () => {
        log.tag("Auth").event("info", "login_attempt", { method: "password" });
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mockLog).toHaveBeenCalled();
      const call = mockLog.mock.calls[0][0] as any;
      expect(call.level).toBe("info");
      expect(call.event).toBe("auth.login_attempt");
      expect(call.traceId).toBe("trace_456");
      expect(call.metadata).toEqual({ method: "password" });

      Logger.setLevel(null);
    });
  });
});

describe("Request Context", () => {
  describe("generateTraceId", () => {
    it("generates unique trace IDs", () => {
      const id1 = generateTraceId();
      const id2 = generateTraceId();

      expect(id1).toMatch(/^trace_[a-z0-9]+_[a-z0-9]+$/);
      expect(id2).toMatch(/^trace_[a-z0-9]+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("getRequestContext/runWithRequestContext", () => {
    it("returns undefined outside of request context", () => {
      expect(getRequestContext()).toBeUndefined();
    });

    it("returns context within runWithRequestContext", () => {
      const ctx: RequestContext = {
        traceId: "trace_test",
        userId: 123,
        startTime: Date.now(),
      };

      runWithRequestContext(ctx, () => {
        const retrieved = getRequestContext();
        expect(retrieved).toBeDefined();
        expect(retrieved?.traceId).toBe("trace_test");
        expect(retrieved?.userId).toBe(123);
      });
    });

    it("context is not available after runWithRequestContext", () => {
      const ctx: RequestContext = {
        traceId: "trace_temp",
        startTime: Date.now(),
      };

      runWithRequestContext(ctx, () => {
        expect(getRequestContext()).toBeDefined();
      });

      expect(getRequestContext()).toBeUndefined();
    });

    it("supports nested contexts", () => {
      const outer: RequestContext = {
        traceId: "outer",
        startTime: Date.now(),
      };

      const inner: RequestContext = {
        traceId: "inner",
        startTime: Date.now(),
      };

      runWithRequestContext(outer, () => {
        expect(getRequestContext()?.traceId).toBe("outer");

        runWithRequestContext(inner, () => {
          expect(getRequestContext()?.traceId).toBe("inner");
        });

        expect(getRequestContext()?.traceId).toBe("outer");
      });
    });

    it("supports full request context", () => {
      const ctx: RequestContext = {
        traceId: "trace_full",
        userId: 1,
        employeeId: 2,
        username: "john",
        companyId: 3,
        method: "POST",
        path: "/api/users",
        startTime: Date.now(),
        isBatchSubRequest: true,
      };

      runWithRequestContext(ctx, () => {
        const retrieved = getRequestContext();
        expect(retrieved).toEqual(ctx);
      });
    });
  });
});

describe("pre-configured loggers", () => {
  it("exports pre-configured loggers", async () => {
    const { logger } = await import("../logger");

    expect(logger.server).toBeInstanceOf(Logger);
    expect(logger.db).toBeInstanceOf(Logger);
    expect(logger.cache).toBeInstanceOf(Logger);
    expect(logger.auth).toBeInstanceOf(Logger);
    expect(logger.http).toBeInstanceOf(Logger);
    expect(logger.cron).toBeInstanceOf(Logger);
  });
});

describe("Global Audit Service", () => {
  afterEach(() => {
    // Clean up global audit service after each test
    Logger.clearGlobalAuditService();
    Logger.setLevel(null);
  });

  it("setGlobalAuditService makes all loggers use the global service", () => {
    const mockLog = mock(() => Promise.resolve("id"));
    const mockAudit: IAuditLogService = { log: mockLog };

    // Create a logger BEFORE setting global service
    const log1 = new Logger("TestModule1");
    expect(log1.isAuditConnected).toBe(false);

    // Set global audit service
    Logger.setGlobalAuditService(mockAudit);

    // Now both existing and new loggers should be connected
    expect(log1.isAuditConnected).toBe(true);
    expect(Logger.hasGlobalAuditService).toBe(true);

    const log2 = new Logger("TestModule2");
    expect(log2.isAuditConnected).toBe(true);
  });

  it("clearGlobalAuditService disconnects all loggers using global service", () => {
    const mockLog = mock(() => Promise.resolve("id"));
    const mockAudit: IAuditLogService = { log: mockLog };

    Logger.setGlobalAuditService(mockAudit);
    const log = new Logger("Test");
    expect(log.isAuditConnected).toBe(true);

    Logger.clearGlobalAuditService();
    expect(log.isAuditConnected).toBe(false);
    expect(Logger.hasGlobalAuditService).toBe(false);
  });

  it("instance-level audit service takes precedence over global", async () => {
    const globalMock = mock(() => Promise.resolve("global-id"));
    const instanceMock = mock(() => Promise.resolve("instance-id"));

    const globalAudit: IAuditLogService = { log: globalMock };
    const instanceAudit: IAuditLogService = { log: instanceMock };

    Logger.setGlobalAuditService(globalAudit);
    const log = new Logger("Test", { auditService: instanceAudit });
    Logger.setLevel("debug");

    log.security("test_event");
    await new Promise((r) => setTimeout(r, 10));

    // Should use instance-level, not global
    expect(instanceMock).toHaveBeenCalled();
    expect(globalMock).not.toHaveBeenCalled();
  });

  it("global audit service is used by TaggedLogger", async () => {
    const mockLog = mock(() => Promise.resolve("id"));
    const mockAudit: IAuditLogService = { log: mockLog };

    Logger.setGlobalAuditService(mockAudit);
    Logger.setLevel("debug");

    const log = new Logger("Test");
    log.tag("SubSystem").security("tagged_event");

    await new Promise((r) => setTimeout(r, 10));

    expect(mockLog).toHaveBeenCalled();
  });

  it("hasGlobalAuditService returns correct status", () => {
    expect(Logger.hasGlobalAuditService).toBe(false);

    const mockAudit: IAuditLogService = { log: mock(() => Promise.resolve("id")) };
    Logger.setGlobalAuditService(mockAudit);
    expect(Logger.hasGlobalAuditService).toBe(true);

    Logger.clearGlobalAuditService();
    expect(Logger.hasGlobalAuditService).toBe(false);
  });
});
