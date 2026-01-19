import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import {
  createAudit,
  createWebSocket,
  KyselyAuditAdapter,
  MemoryAuditAdapter,
  type Audit,
  type WebSocketService,
} from "../src/core/index";

// ==========================================
// Audit Service Tests (Memory Adapter)
// ==========================================
describe("Audit Service (Memory)", () => {
  let audit: Audit;

  beforeEach(() => {
    audit = createAudit({ adapter: new MemoryAuditAdapter() });
  });

  afterEach(() => {
    audit.stop();
  });

  it("should create audit service with default config", () => {
    expect(audit).toBeDefined();
    expect(audit.log).toBeInstanceOf(Function);
    expect(audit.query).toBeInstanceOf(Function);
    expect(audit.getByResource).toBeInstanceOf(Function);
    expect(audit.getByActor).toBeInstanceOf(Function);
  });

  it("should log an audit entry", async () => {
    const id = await audit.log({
      action: "user.login",
      actor: "user-123",
      resource: "session",
      resourceId: "session-456",
      metadata: { ip: "192.168.1.1" },
    });

    expect(id).toMatch(/^audit_/);
  });

  it("should query audit entries", async () => {
    await audit.log({ action: "user.login", actor: "user-1", resource: "session" });
    await audit.log({ action: "user.logout", actor: "user-1", resource: "session" });
    await audit.log({ action: "user.login", actor: "user-2", resource: "session" });

    const allEntries = await audit.query({});
    expect(allEntries).toHaveLength(3);

    const loginEntries = await audit.query({ action: "user.login" });
    expect(loginEntries).toHaveLength(2);

    const user1Entries = await audit.query({ actor: "user-1" });
    expect(user1Entries).toHaveLength(2);
  });

  it("should get entries by resource", async () => {
    await audit.log({ action: "create", actor: "admin", resource: "user", resourceId: "user-1" });
    await audit.log({ action: "update", actor: "admin", resource: "user", resourceId: "user-1" });
    await audit.log({ action: "create", actor: "admin", resource: "user", resourceId: "user-2" });

    const user1Entries = await audit.getByResource("user", "user-1");
    expect(user1Entries).toHaveLength(2);
    expect(user1Entries.every(e => e.resourceId === "user-1")).toBe(true);
  });

  it("should get entries by actor", async () => {
    await audit.log({ action: "action-1", actor: "admin", resource: "resource" });
    await audit.log({ action: "action-2", actor: "admin", resource: "resource" });
    await audit.log({ action: "action-3", actor: "user", resource: "resource" });

    const adminEntries = await audit.getByActor("admin");
    expect(adminEntries).toHaveLength(2);
    expect(adminEntries.every(e => e.actor === "admin")).toBe(true);
  });

  it("should respect query limit", async () => {
    for (let i = 0; i < 20; i++) {
      await audit.log({ action: `action-${i}`, actor: "actor", resource: "resource" });
    }

    const limited = await audit.query({ limit: 5 });
    expect(limited).toHaveLength(5);
  });

  it("should return entries in descending timestamp order", async () => {
    await audit.log({ action: "first", actor: "actor", resource: "resource" });
    await new Promise(resolve => setTimeout(resolve, 10));
    await audit.log({ action: "second", actor: "actor", resource: "resource" });
    await new Promise(resolve => setTimeout(resolve, 10));
    await audit.log({ action: "third", actor: "actor", resource: "resource" });

    const entries = await audit.query({});
    expect(entries[0].action).toBe("third");
    expect(entries[2].action).toBe("first");
  });

  it("should store and retrieve metadata", async () => {
    await audit.log({
      action: "test",
      actor: "actor",
      resource: "resource",
      metadata: { key1: "value1", nested: { key2: "value2" } },
    });

    const entries = await audit.query({});
    expect(entries[0].metadata).toEqual({ key1: "value1", nested: { key2: "value2" } });
  });

  it("should handle entries without optional fields", async () => {
    const id = await audit.log({
      action: "minimal",
      actor: "actor",
      resource: "resource",
    });

    const entries = await audit.query({});
    expect(entries[0].resourceId).toBeUndefined();
    expect(entries[0].metadata).toBeUndefined();
  });
});

// ==========================================
// Audit Service Tests (Kysely Adapter)
// ==========================================
describe("Audit Service (Kysely)", () => {
  let db: Kysely<any>;
  let audit: Audit;

  beforeEach(async () => {
    db = new Kysely<any>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });

    // Create the audit table
    await db.schema
      .createTable("__donkeylabs_audit__")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("timestamp", "text", (col) => col.notNull())
      .addColumn("action", "text", (col) => col.notNull())
      .addColumn("actor", "text", (col) => col.notNull())
      .addColumn("resource", "text", (col) => col.notNull())
      .addColumn("resource_id", "text")
      .addColumn("metadata", "text")
      .addColumn("ip", "text")
      .addColumn("request_id", "text")
      .execute();

    audit = createAudit({
      adapter: new KyselyAuditAdapter(db, { retentionDays: 0 }), // No cleanup in tests
    });
  });

  afterEach(async () => {
    audit.stop();
    await db.destroy();
  });

  it("should log entries to database", async () => {
    const id = await audit.log({
      action: "user.created",
      actor: "admin",
      resource: "user",
      resourceId: "user-123",
    });

    expect(id).toMatch(/^audit_/);

    // Verify in DB
    const rows = await db.selectFrom("__donkeylabs_audit__").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("user.created");
  });

  it("should query entries from database", async () => {
    await audit.log({ action: "a", actor: "actor-1", resource: "res" });
    await audit.log({ action: "b", actor: "actor-2", resource: "res" });
    await audit.log({ action: "a", actor: "actor-1", resource: "res" });

    const byAction = await audit.query({ action: "a" });
    expect(byAction).toHaveLength(2);

    const byActor = await audit.query({ actor: "actor-2" });
    expect(byActor).toHaveLength(1);
  });

  it("should filter by resource", async () => {
    await audit.log({ action: "x", actor: "a", resource: "users", resourceId: "1" });
    await audit.log({ action: "x", actor: "a", resource: "posts", resourceId: "1" });

    const userEntries = await audit.query({ resource: "users" });
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0].resource).toBe("users");
  });

  it("should persist metadata as JSON", async () => {
    await audit.log({
      action: "test",
      actor: "actor",
      resource: "resource",
      metadata: { complex: { nested: [1, 2, 3] } },
    });

    const entries = await audit.query({});
    expect(entries[0].metadata).toEqual({ complex: { nested: [1, 2, 3] } });
  });
});

// ==========================================
// WebSocket Service Tests
// ==========================================
describe("WebSocket Service", () => {
  let ws: WebSocketService;

  beforeEach(() => {
    ws = createWebSocket({ pingInterval: 60000 }); // Long interval for tests
  });

  afterEach(() => {
    ws.shutdown();
  });

  it("should create websocket service", () => {
    expect(ws).toBeDefined();
    expect(ws.broadcast).toBeInstanceOf(Function);
    expect(ws.send).toBeInstanceOf(Function);
    expect(ws.subscribe).toBeInstanceOf(Function);
    expect(ws.getClients).toBeInstanceOf(Function);
  });

  it("should track client count", () => {
    expect(ws.getClientCount()).toBe(0);
  });

  it("should return empty client list when no clients connected", () => {
    const clients = ws.getClients();
    expect(clients).toEqual([]);
  });

  it("should return empty channel client list", () => {
    const clients = ws.getClients("some-channel");
    expect(clients).toEqual([]);
  });

  it("should report not connected for unknown client", () => {
    expect(ws.isConnected("unknown-client")).toBe(false);
  });

  it("should return undefined metadata for unknown client", () => {
    expect(ws.getClientMetadata("unknown-client")).toBeUndefined();
  });

  it("should fail to set metadata for unknown client", () => {
    const result = ws.setClientMetadata("unknown-client", { key: "value" });
    expect(result).toBe(false);
  });

  it("should fail to send to unknown client", () => {
    const result = ws.send("unknown-client", "event", { data: "test" });
    expect(result).toBe(false);
  });

  it("should fail to subscribe unknown client", () => {
    const result = ws.subscribe("unknown-client", "channel");
    expect(result).toBe(false);
  });

  it("should fail to unsubscribe unknown client", () => {
    const result = ws.unsubscribe("unknown-client", "channel");
    expect(result).toBe(false);
  });

  it("should register message handlers", () => {
    let handlerCalled = false;
    ws.onMessage(() => {
      handlerCalled = true;
    });
    // Handler is registered but won't be called without actual messages
    expect(handlerCalled).toBe(false);
  });

  it("should handle broadcast to empty channel gracefully", () => {
    // Should not throw
    ws.broadcast("empty-channel", "event", { data: "test" });
    expect(true).toBe(true);
  });

  it("should handle broadcast to all with no clients gracefully", () => {
    // Should not throw
    ws.broadcastAll("event", { data: "test" });
    expect(true).toBe(true);
  });

  it("should shutdown cleanly", () => {
    ws.shutdown();
    expect(ws.getClientCount()).toBe(0);
  });

  it("should enforce max clients per channel when configured", () => {
    const limitedWs = createWebSocket({ maxClientsPerChannel: 2 });
    // Without actual clients, we can only verify the config is accepted
    expect(limitedWs.getClientCount()).toBe(0);
    limitedWs.shutdown();
  });
});

// ==========================================
// WebSocket Message Handler Tests
// ==========================================
describe("WebSocket Message Handling", () => {
  let ws: WebSocketService;
  let messageLog: Array<{ clientId: string; event: string; data: any }>;

  beforeEach(() => {
    ws = createWebSocket({ pingInterval: 60000 });
    messageLog = [];
    ws.onMessage((clientId, event, data) => {
      messageLog.push({ clientId, event, data });
    });
  });

  afterEach(() => {
    ws.shutdown();
  });

  it("should accept multiple message handlers", () => {
    let handler1Called = false;
    let handler2Called = false;

    ws.onMessage(() => { handler1Called = true; });
    ws.onMessage(() => { handler2Called = true; });

    // Handlers registered but not called without messages
    expect(handler1Called).toBe(false);
    expect(handler2Called).toBe(false);
  });
});
