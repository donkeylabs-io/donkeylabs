import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { AuditLogSystem } from "../system";
import { Logger } from "../../logger";
import { unlink } from "fs/promises";
import { existsSync } from "fs";
import jwt from "jsonwebtoken";

describe("AuditLogSystem", () => {
  const testDbPath = "/tmp/audit-logs-test.db";
  const jwtSecret = "test-secret-key";
  let system: AuditLogSystem;

  beforeAll(async () => {
    // Clean up any existing test database
    if (existsSync(testDbPath)) {
      await unlink(testDbPath);
    }

    system = new AuditLogSystem({
      dbFile: testDbPath,
      jwtSecret,
      runMigrations: true,
    });

    await system.initialize();

    // Silence console output
    Logger.setLevel("silent");
  });

  afterAll(async () => {
    await system.shutdown();
    Logger.setLevel(null);

    // Clean up test database
    if (existsSync(testDbPath)) {
      await unlink(testDbPath);
    }
    if (existsSync(testDbPath + "-shm")) {
      await unlink(testDbPath + "-shm");
    }
    if (existsSync(testDbPath + "-wal")) {
      await unlink(testDbPath + "-wal");
    }
  });

  describe("initialization", () => {
    it("creates the system with all components", () => {
      expect(system.db).toBeDefined();
      expect(system.service).toBeDefined();
      expect(system.hub).toBeDefined();
      expect(system.requestLogger).toBeDefined();
    });

    it("only initializes once", async () => {
      // Second call should be a no-op
      await system.initialize();
      expect(system.db).toBeDefined();
    });
  });

  describe("log()", () => {
    it("logs entries through the service", async () => {
      const id = await system.log({
        event: "test.system.log",
        level: "info",
        message: "Test log through system",
      });

      expect(id).toMatch(/^log_/);
    });
  });

  describe("cleanup()", () => {
    it("delegates to service cleanup", async () => {
      const result = await system.cleanup();

      expect(result).toHaveProperty("deleted");
      expect(result).toHaveProperty("byLevel");
    });
  });

  describe("retention configuration", () => {
    it("gets retention config", async () => {
      const config = await system.getRetention();

      expect(config.default).toBeGreaterThan(0);
      expect(config.security).toBeGreaterThan(0);
    });

    it("sets retention config", async () => {
      const originalConfig = await system.getRetention();

      await system.setRetention({
        default: 6,
        security: 24,
        error: 12,
      });

      const newConfig = await system.getRetention();
      expect(newConfig.default).toBe(6);
      expect(newConfig.security).toBe(24);

      // Restore original
      await system.setRetention(originalConfig);
    });
  });

  describe("createLogger()", () => {
    it("creates a logger connected to audit", () => {
      const log = system.createLogger("TestPrefix");

      expect(log).toBeInstanceOf(Logger);
      expect(log.isAuditConnected).toBe(true);
    });

    it("creates loggers with different prefixes", () => {
      const log1 = system.createLogger("Prefix1");
      const log2 = system.createLogger("Prefix2");

      expect(log1).toBeInstanceOf(Logger);
      expect(log2).toBeInstanceOf(Logger);
      expect(log1).not.toBe(log2);
    });
  });

  describe("verifyToken()", () => {
    it("verifies valid JWT token", () => {
      const token = jwt.sign(
        { userId: 123, permissions: ["audit:read"] },
        jwtSecret
      );

      const result = system.verifyToken(token);

      expect(result).not.toBeNull();
      expect(result?.userId).toBe(123);
      expect(result?.permissions).toContain("audit:read");
    });

    it("returns null for invalid token", () => {
      const result = system.verifyToken("invalid-token");

      expect(result).toBeNull();
    });

    it("returns null for token signed with wrong secret", () => {
      const token = jwt.sign({ userId: 123 }, "wrong-secret");

      const result = system.verifyToken(token);

      expect(result).toBeNull();
    });
  });

  describe("handleUpgrade()", () => {
    const createMockRequest = (token?: string, authHeader?: string) => {
      const url = token
        ? `http://localhost/ws/audit-logs?token=${token}`
        : "http://localhost/ws/audit-logs";

      const headers = new Headers();
      if (authHeader) {
        headers.set("authorization", authHeader);
      }

      return new Request(url, { headers });
    };

    it("rejects request without token", () => {
      const req = createMockRequest();
      const mockServer = { upgrade: mock(() => true) };

      const response = system.handleUpgrade(req, mockServer);

      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(401);
    });

    it("rejects request with invalid token", () => {
      const req = createMockRequest("invalid-token");
      const mockServer = { upgrade: mock(() => true) };

      const response = system.handleUpgrade(req, mockServer);

      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(401);
    });

    it("rejects request without required permissions", () => {
      const token = jwt.sign(
        { userId: 123, permissions: ["other:read"] },
        jwtSecret
      );
      const req = createMockRequest(token);
      const mockServer = { upgrade: mock(() => true) };

      const response = system.handleUpgrade(req, mockServer);

      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(403);
    });

    it("accepts request with audit:read permission from query", () => {
      const token = jwt.sign(
        { userId: 123, permissions: ["audit:read"] },
        jwtSecret
      );
      const req = createMockRequest(token);
      const mockUpgrade = mock(() => true);
      const mockServer = { upgrade: mockUpgrade };

      const response = system.handleUpgrade(req, mockServer);

      expect(response).toBeUndefined(); // undefined means upgrade succeeded
      expect(mockUpgrade).toHaveBeenCalled();
    });

    it("accepts request with admin:read permission", () => {
      const token = jwt.sign(
        { userId: 123, permissions: ["admin:read"] },
        jwtSecret
      );
      const req = createMockRequest(token);
      const mockUpgrade = mock(() => true);
      const mockServer = { upgrade: mockUpgrade };

      const response = system.handleUpgrade(req, mockServer);

      expect(response).toBeUndefined();
      expect(mockUpgrade).toHaveBeenCalled();
    });

    it("accepts request with token from Authorization header", () => {
      const token = jwt.sign(
        { userId: 123, permissions: ["audit:read"] },
        jwtSecret
      );
      const req = createMockRequest(undefined, `Bearer ${token}`);
      const mockUpgrade = mock(() => true);
      const mockServer = { upgrade: mockUpgrade };

      const response = system.handleUpgrade(req, mockServer);

      expect(response).toBeUndefined();
      expect(mockUpgrade).toHaveBeenCalled();
    });

    it("accepts request without permissions array (no permission check)", () => {
      // When no permissions array is present, allow the connection
      const token = jwt.sign({ userId: 123 }, jwtSecret);
      const req = createMockRequest(token);
      const mockUpgrade = mock(() => true);
      const mockServer = { upgrade: mockUpgrade };

      const response = system.handleUpgrade(req, mockServer);

      expect(response).toBeUndefined();
    });

    it("returns 400 if upgrade fails", () => {
      const token = jwt.sign(
        { userId: 123, permissions: ["audit:read"] },
        jwtSecret
      );
      const req = createMockRequest(token);
      const mockServer = { upgrade: mock(() => false) };

      const response = system.handleUpgrade(req, mockServer);

      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(400);
    });
  });

  describe("getStats()", () => {
    it("returns system statistics", async () => {
      // Log some entries first
      await system.log({ event: "stats.test1", level: "info" });
      await system.log({ event: "stats.test2", level: "info" });

      const stats = await system.getStats();

      expect(stats.connections).toHaveProperty("totalConnections");
      expect(stats.connections).toHaveProperty("uniqueUsers");
      expect(stats.logs).toHaveProperty("total");
      expect(stats.logs).toHaveProperty("last24h");
      expect(stats.logs.total).toBeGreaterThan(0);
      expect(stats.logs.last24h).toBeGreaterThan(0);
    });
  });

  describe("websocketHandlers", () => {
    it("provides websocket handlers object", () => {
      const handlers = system.websocketHandlers;

      expect(handlers).toHaveProperty("open");
      expect(handlers).toHaveProperty("message");
      expect(handlers).toHaveProperty("close");
      expect(typeof handlers.open).toBe("function");
      expect(typeof handlers.message).toBe("function");
      expect(typeof handlers.close).toBe("function");
    });
  });

  describe("middleware()", () => {
    it("creates middleware function", () => {
      const middleware = system.middleware();

      expect(typeof middleware).toBe("function");
    });

    it("creates middleware with options", () => {
      const middleware = system.middleware({
        excludePaths: ["/health"],
        excludeMethods: ["OPTIONS"],
      });

      expect(typeof middleware).toBe("function");
    });
  });
});

describe("AuditLogSystem without JWT secret", () => {
  it("warns when verifying token without secret", async () => {
    const testDbPath2 = "/tmp/audit-logs-test-2.db";

    // Clean up
    if (existsSync(testDbPath2)) {
      await unlink(testDbPath2);
    }

    const systemNoJwt = new AuditLogSystem({
      dbFile: testDbPath2,
      runMigrations: true,
    });

    await systemNoJwt.initialize();

    // Should return null and warn
    const result = systemNoJwt.verifyToken("any-token");
    expect(result).toBeNull();

    await systemNoJwt.shutdown();

    // Clean up
    if (existsSync(testDbPath2)) await unlink(testDbPath2);
    if (existsSync(testDbPath2 + "-shm")) await unlink(testDbPath2 + "-shm");
    if (existsSync(testDbPath2 + "-wal")) await unlink(testDbPath2 + "-wal");
  });
});
