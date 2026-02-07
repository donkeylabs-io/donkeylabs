import { describe, it, expect, beforeEach } from "bun:test";
import { MemoryAuditAdapter, createAudit } from "../src/core/audit";
import type { AuditEntry } from "../src/core/audit";

describe("MemoryAuditAdapter", () => {
  let adapter: MemoryAuditAdapter;

  beforeEach(() => {
    adapter = new MemoryAuditAdapter();
  });

  describe("log", () => {
    it("should create an audit entry with generated id and timestamp", async () => {
      const id = await adapter.log({
        action: "user.login",
        actor: "user-1",
        resource: "auth",
      });

      expect(id).toContain("audit_");

      const entries = await adapter.query({});
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("user.login");
      expect(entries[0].actor).toBe("user-1");
      expect(entries[0].timestamp).toBeInstanceOf(Date);
    });
  });

  describe("query", () => {
    beforeEach(async () => {
      await adapter.log({ action: "user.login", actor: "alice", resource: "auth" });
      await adapter.log({ action: "user.login", actor: "bob", resource: "auth" });
      await adapter.log({ action: "user.update", actor: "alice", resource: "users", resourceId: "u1" });
      await adapter.log({ action: "order.create", actor: "alice", resource: "orders", resourceId: "o1" });
    });

    it("should return all entries when no filters", async () => {
      const entries = await adapter.query({});
      expect(entries).toHaveLength(4);
    });

    it("should filter by action", async () => {
      const entries = await adapter.query({ action: "user.login" });
      expect(entries).toHaveLength(2);
    });

    it("should filter by actor", async () => {
      const entries = await adapter.query({ actor: "alice" });
      expect(entries).toHaveLength(3);
    });

    it("should filter by resource", async () => {
      const entries = await adapter.query({ resource: "auth" });
      expect(entries).toHaveLength(2);
    });

    it("should filter by resourceId", async () => {
      const entries = await adapter.query({ resourceId: "o1" });
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("order.create");
    });

    it("should filter by date range", async () => {
      const now = new Date();
      const future = new Date(now.getTime() + 60000);
      const past = new Date(now.getTime() - 60000);

      const entries = await adapter.query({ startDate: past, endDate: future });
      expect(entries).toHaveLength(4);

      const noEntries = await adapter.query({
        startDate: future,
        endDate: new Date(future.getTime() + 1000),
      });
      expect(noEntries).toHaveLength(0);
    });

    it("should apply pagination (offset/limit)", async () => {
      const page1 = await adapter.query({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = await adapter.query({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      // No overlap
      const ids1 = page1.map((e) => e.id);
      const ids2 = page2.map((e) => e.id);
      for (const id of ids2) {
        expect(ids1).not.toContain(id);
      }
    });

    it("should sort by timestamp descending", async () => {
      const entries = await adapter.query({});
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i - 1].timestamp.getTime()).toBeGreaterThanOrEqual(
          entries[i].timestamp.getTime()
        );
      }
    });
  });

  describe("getByResource", () => {
    it("should return entries matching resource and resourceId", async () => {
      await adapter.log({ action: "user.update", actor: "alice", resource: "users", resourceId: "u1" });
      await adapter.log({ action: "user.delete", actor: "bob", resource: "users", resourceId: "u1" });
      await adapter.log({ action: "user.update", actor: "alice", resource: "users", resourceId: "u2" });

      const entries = await adapter.getByResource("users", "u1");
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.resourceId === "u1")).toBe(true);
    });
  });

  describe("getByActor", () => {
    it("should return entries for a specific actor", async () => {
      await adapter.log({ action: "a1", actor: "alice", resource: "r" });
      await adapter.log({ action: "a2", actor: "bob", resource: "r" });
      await adapter.log({ action: "a3", actor: "alice", resource: "r" });

      const entries = await adapter.getByActor("alice");
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.actor === "alice")).toBe(true);
    });

    it("should respect limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.log({ action: `a${i}`, actor: "alice", resource: "r" });
      }

      const entries = await adapter.getByActor("alice", 3);
      expect(entries).toHaveLength(3);
    });
  });

  describe("deleteOlderThan", () => {
    it("should delete entries older than the given date", async () => {
      await adapter.log({ action: "old", actor: "a", resource: "r" });

      // Wait a tiny bit to create a gap
      await new Promise((r) => setTimeout(r, 10));
      const cutoff = new Date();
      await new Promise((r) => setTimeout(r, 10));

      await adapter.log({ action: "new", actor: "a", resource: "r" });

      const deleted = await adapter.deleteOlderThan(cutoff);
      expect(deleted).toBe(1);

      const remaining = await adapter.query({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].action).toBe("new");
    });

    it("should return 0 when no entries to delete", async () => {
      const deleted = await adapter.deleteOlderThan(new Date(0));
      expect(deleted).toBe(0);
    });
  });

  describe("stop", () => {
    it("should not throw", () => {
      adapter.stop();
    });
  });
});

describe("createAudit", () => {
  it("should create audit service with memory adapter", () => {
    const audit = createAudit({ adapter: new MemoryAuditAdapter() });
    expect(audit).toBeDefined();
    audit.stop();
  });

  it("should log and query through the service", async () => {
    const audit = createAudit({ adapter: new MemoryAuditAdapter() });

    await audit.log({
      action: "test.action",
      actor: "tester",
      resource: "tests",
    });

    const entries = await audit.query({});
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("test.action");

    audit.stop();
  });
});
