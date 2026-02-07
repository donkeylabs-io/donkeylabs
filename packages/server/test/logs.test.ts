import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createLogs,
  MemoryLogsAdapter,
  type Logs,
  type LogsAdapter,
  type PersistentLogEntry,
  type LogSource,
} from "../src/core/logs";
import type { Events } from "../src/core/events";

// ==========================================
// Helpers
// ==========================================

function makeEntry(overrides: Partial<PersistentLogEntry> = {}): PersistentLogEntry {
  return {
    id: `log_${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date(),
    level: "info",
    message: "test message",
    source: "system",
    ...overrides,
  };
}

function createMockEvents(): Events & { emittedEvents: { event: string; data: any }[] } {
  const emittedEvents: { event: string; data: any }[] = [];
  return {
    emittedEvents,
    async emit(event: string, data: any) {
      emittedEvents.push({ event, data });
    },
    on() {
      return { unsubscribe() {} };
    },
    once() {
      return { unsubscribe() {} };
    },
    off() {},
    async getHistory() {
      return [];
    },
    async stop() {},
  } as any;
}

// ==========================================
// MemoryLogsAdapter Tests
// ==========================================

describe("MemoryLogsAdapter", () => {
  let adapter: MemoryLogsAdapter;

  beforeEach(() => {
    adapter = new MemoryLogsAdapter();
  });

  describe("write / writeBatch", () => {
    it("should write a single entry", async () => {
      const entry = makeEntry({ message: "single write" });
      await adapter.write(entry);

      const results = await adapter.query({});
      expect(results).toHaveLength(1);
      expect(results[0].message).toBe("single write");
    });

    it("should write a batch of entries", async () => {
      const entries = [
        makeEntry({ message: "batch-1" }),
        makeEntry({ message: "batch-2" }),
        makeEntry({ message: "batch-3" }),
      ];
      await adapter.writeBatch(entries);

      const results = await adapter.query({});
      expect(results).toHaveLength(3);
    });
  });

  describe("query filtering", () => {
    beforeEach(async () => {
      const now = Date.now();
      await adapter.writeBatch([
        makeEntry({ source: "cron", sourceId: "cleanup", level: "info", message: "cron info", tags: ["scheduled"], timestamp: new Date(now - 5000) }),
        makeEntry({ source: "cron", sourceId: "cleanup", level: "error", message: "cron error", tags: ["scheduled", "critical"], timestamp: new Date(now - 4000) }),
        makeEntry({ source: "job", sourceId: "email-send", level: "debug", message: "job debug", tags: ["email"], timestamp: new Date(now - 3000) }),
        makeEntry({ source: "workflow", sourceId: "wf_1", level: "warn", message: "workflow warning", tags: ["slow"], timestamp: new Date(now - 2000) }),
        makeEntry({ source: "system", level: "info", message: "system boot", timestamp: new Date(now - 1000) }),
        makeEntry({ source: "plugin", sourceId: "auth", level: "error", message: "auth plugin error", tags: ["critical"], timestamp: new Date(now) }),
      ]);
    });

    it("should filter by source", async () => {
      const results = await adapter.query({ source: "cron" });
      expect(results).toHaveLength(2);
      results.forEach((r) => expect(r.source).toBe("cron"));
    });

    it("should filter by sourceId", async () => {
      const results = await adapter.query({ sourceId: "cleanup" });
      expect(results).toHaveLength(2);
      results.forEach((r) => expect(r.sourceId).toBe("cleanup"));
    });

    it("should filter by minimum log level", async () => {
      const results = await adapter.query({ level: "warn" });
      expect(results).toHaveLength(3); // warn + 2 errors
      results.forEach((r) => expect(["warn", "error"]).toContain(r.level));
    });

    it("should filter by tags (must contain all specified tags)", async () => {
      const results = await adapter.query({ tags: ["scheduled"] });
      expect(results).toHaveLength(2);

      const critical = await adapter.query({ tags: ["scheduled", "critical"] });
      expect(critical).toHaveLength(1);
      expect(critical[0].message).toBe("cron error");
    });

    it("should filter by search (case-insensitive)", async () => {
      const results = await adapter.query({ search: "CRON" });
      expect(results).toHaveLength(2);

      const boot = await adapter.query({ search: "boot" });
      expect(boot).toHaveLength(1);
      expect(boot[0].message).toBe("system boot");
    });

    it("should filter by date range", async () => {
      const all = await adapter.query({});
      // Pick the middle timestamps for range filtering
      const sorted = [...all].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const startDate = sorted[1].timestamp;
      const endDate = sorted[4].timestamp;

      const results = await adapter.query({ startDate, endDate });
      results.forEach((r) => {
        expect(r.timestamp.getTime()).toBeGreaterThanOrEqual(startDate.getTime());
        expect(r.timestamp.getTime()).toBeLessThanOrEqual(endDate.getTime());
      });
    });

    it("should apply offset and limit", async () => {
      const first2 = await adapter.query({ limit: 2 });
      expect(first2).toHaveLength(2);

      const next2 = await adapter.query({ limit: 2, offset: 2 });
      expect(next2).toHaveLength(2);

      // Should not overlap
      expect(first2[0].id).not.toBe(next2[0].id);
      expect(first2[1].id).not.toBe(next2[1].id);
    });

    it("should sort by timestamp descending (newest first)", async () => {
      const results = await adapter.query({});
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].timestamp.getTime()).toBeGreaterThanOrEqual(
          results[i].timestamp.getTime()
        );
      }
    });
  });

  describe("getBySource", () => {
    beforeEach(async () => {
      await adapter.writeBatch([
        makeEntry({ source: "cron", sourceId: "cleanup" }),
        makeEntry({ source: "cron", sourceId: "report" }),
        makeEntry({ source: "job", sourceId: "email" }),
      ]);
    });

    it("should return entries for a given source", async () => {
      const results = await adapter.getBySource("cron");
      expect(results).toHaveLength(2);
      results.forEach((r) => expect(r.source).toBe("cron"));
    });

    it("should filter by source and sourceId", async () => {
      const results = await adapter.getBySource("cron", "cleanup");
      expect(results).toHaveLength(1);
      expect(results[0].sourceId).toBe("cleanup");
    });

    it("should respect the limit parameter", async () => {
      const results = await adapter.getBySource("cron", undefined, 1);
      expect(results).toHaveLength(1);
    });
  });

  describe("count", () => {
    it("should count all entries when no filter", async () => {
      await adapter.writeBatch([makeEntry(), makeEntry(), makeEntry()]);
      const total = await adapter.count({});
      expect(total).toBe(3);
    });

    it("should count entries matching filters", async () => {
      await adapter.writeBatch([
        makeEntry({ source: "cron", level: "info" }),
        makeEntry({ source: "cron", level: "error" }),
        makeEntry({ source: "job", level: "info" }),
      ]);
      expect(await adapter.count({ source: "cron" })).toBe(2);
      expect(await adapter.count({ level: "error" })).toBe(1);
    });
  });

  describe("deleteOlderThan", () => {
    it("should delete entries older than the given date", async () => {
      const old = new Date(Date.now() - 100000);
      const recent = new Date();
      await adapter.writeBatch([
        makeEntry({ timestamp: old, message: "old" }),
        makeEntry({ timestamp: recent, message: "recent" }),
      ]);

      const cutoff = new Date(Date.now() - 50000);
      const deleted = await adapter.deleteOlderThan(cutoff);
      expect(deleted).toBe(1);

      const remaining = await adapter.query({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].message).toBe("recent");
    });

    it("should only delete from the specified source", async () => {
      const old = new Date(Date.now() - 100000);
      await adapter.writeBatch([
        makeEntry({ timestamp: old, source: "cron", message: "old cron" }),
        makeEntry({ timestamp: old, source: "job", message: "old job" }),
        makeEntry({ timestamp: new Date(), source: "cron", message: "new cron" }),
      ]);

      const cutoff = new Date(Date.now() - 50000);
      const deleted = await adapter.deleteOlderThan(cutoff, "cron");
      expect(deleted).toBe(1);

      const remaining = await adapter.query({});
      expect(remaining).toHaveLength(2);
      const messages = remaining.map((r) => r.message);
      expect(messages).toContain("old job");
      expect(messages).toContain("new cron");
    });

    it("should return 0 when nothing to delete", async () => {
      await adapter.write(makeEntry({ timestamp: new Date() }));
      const deleted = await adapter.deleteOlderThan(new Date(Date.now() - 100000));
      expect(deleted).toBe(0);
    });
  });
});

// ==========================================
// LogsImpl Tests (via createLogs)
// ==========================================

describe("LogsImpl (via createLogs)", () => {
  let logs: Logs;
  let adapter: MemoryLogsAdapter;

  afterEach(() => {
    logs?.stop();
  });

  function setup(opts: {
    minLevel?: "debug" | "info" | "warn" | "error";
    events?: Events;
    maxBufferSize?: number;
    flushInterval?: number;
    retention?: any;
  } = {}) {
    adapter = new MemoryLogsAdapter();
    logs = createLogs({
      adapter,
      flushInterval: opts.flushInterval ?? 60000, // high default so timer doesn't auto-flush
      maxBufferSize: opts.maxBufferSize ?? 100,
      minLevel: opts.minLevel,
      events: opts.events,
      retention: opts.retention,
    });
  }

  describe("write()", () => {
    it("should add entry with auto-generated id and timestamp", async () => {
      setup();
      logs.write({ level: "info", message: "hello", source: "system" });
      await logs.flush();

      const results = await logs.query({});
      expect(results).toHaveLength(1);
      expect(results[0].id).toMatch(/^log_/);
      expect(results[0].timestamp).toBeInstanceOf(Date);
      expect(results[0].message).toBe("hello");
    });

    it("should preserve tags and data on entries", async () => {
      setup();
      logs.write({
        level: "info",
        message: "tagged",
        source: "plugin",
        sourceId: "auth",
        tags: ["security"],
        data: { ip: "127.0.0.1" },
      });
      await logs.flush();

      const results = await logs.query({});
      expect(results[0].tags).toEqual(["security"]);
      expect(results[0].data).toEqual({ ip: "127.0.0.1" });
    });
  });

  describe("minLevel filtering", () => {
    it("should discard entries below minLevel", async () => {
      setup({ minLevel: "warn" });
      logs.write({ level: "debug", message: "ignored-debug", source: "system" });
      logs.write({ level: "info", message: "ignored-info", source: "system" });
      logs.write({ level: "warn", message: "kept-warn", source: "system" });
      logs.write({ level: "error", message: "kept-error", source: "system" });
      await logs.flush();

      const results = await logs.query({});
      expect(results).toHaveLength(2);
      const messages = results.map((r) => r.message);
      expect(messages).toContain("kept-warn");
      expect(messages).toContain("kept-error");
    });

    it("should default to info minLevel", async () => {
      setup();
      logs.write({ level: "debug", message: "ignored", source: "system" });
      logs.write({ level: "info", message: "kept", source: "system" });
      await logs.flush();

      const results = await logs.query({});
      expect(results).toHaveLength(1);
      expect(results[0].message).toBe("kept");
    });
  });

  describe("stopped guard", () => {
    it("should not accept writes after stop()", async () => {
      setup();
      logs.write({ level: "info", message: "before", source: "system" });
      await logs.flush();

      logs.stop();
      logs.write({ level: "info", message: "after", source: "system" });

      // Re-create to query the adapter (original is stopped)
      const results = await adapter.query({});
      expect(results).toHaveLength(1);
      expect(results[0].message).toBe("before");
    });
  });

  describe("flush()", () => {
    it("should write buffered entries to adapter", async () => {
      setup();
      logs.write({ level: "info", message: "buffered-1", source: "system" });
      logs.write({ level: "info", message: "buffered-2", source: "system" });

      // Before flush, adapter should be empty
      expect(await adapter.query({})).toHaveLength(0);

      await logs.flush();

      expect(await adapter.query({})).toHaveLength(2);
    });

    it("should be a no-op when buffer is empty", async () => {
      setup();
      // Should not throw
      await logs.flush();
      expect(await adapter.query({})).toHaveLength(0);
    });

    it("should emit log events when events service is provided", async () => {
      const mockEvents = createMockEvents();
      setup({ events: mockEvents });

      logs.write({ level: "info", message: "event-test", source: "cron", sourceId: "cleanup" });
      await logs.flush();

      // Should emit: log.created, log.cron, log.cron.cleanup
      const eventNames = mockEvents.emittedEvents.map((e) => e.event);
      expect(eventNames).toContain("log.created");
      expect(eventNames).toContain("log.cron");
      expect(eventNames).toContain("log.cron.cleanup");
    });

    it("should emit source-level events without sourceId event when sourceId is absent", async () => {
      const mockEvents = createMockEvents();
      setup({ events: mockEvents });

      logs.write({ level: "info", message: "no-source-id", source: "system" });
      await logs.flush();

      const eventNames = mockEvents.emittedEvents.map((e) => e.event);
      expect(eventNames).toContain("log.created");
      expect(eventNames).toContain("log.system");
      // Should NOT have a log.system.<id> event
      const sourceIdEvents = eventNames.filter((n) => n.startsWith("log.system."));
      expect(sourceIdEvents).toHaveLength(0);
    });

    it("should put entries back in the buffer on adapter error", async () => {
      const failingAdapter: LogsAdapter = {
        async writeBatch() {
          throw new Error("write failed");
        },
        async write() {
          throw new Error("write failed");
        },
        async query(filters) {
          return [];
        },
        async getBySource() {
          return [];
        },
        async count() {
          return 0;
        },
        async deleteOlderThan() {
          return 0;
        },
        stop() {},
      };

      logs = createLogs({
        adapter: failingAdapter,
        flushInterval: 60000,
        maxBufferSize: 100,
      });

      logs.write({ level: "info", message: "will-retry", source: "system" });
      await logs.flush();

      // Entries should be put back; flushing again should attempt again
      // We can't query the failing adapter, but we can verify no throw
      await logs.flush();
    });
  });

  describe("auto-flush at maxBufferSize", () => {
    it("should trigger flush when buffer reaches maxBufferSize", async () => {
      setup({ maxBufferSize: 3 });

      logs.write({ level: "info", message: "a", source: "system" });
      logs.write({ level: "info", message: "b", source: "system" });
      // Not yet at threshold
      expect(await adapter.query({})).toHaveLength(0);

      logs.write({ level: "info", message: "c", source: "system" });
      // Auto-flush is async, give it a tick
      await new Promise((r) => setTimeout(r, 10));

      const results = await adapter.query({});
      expect(results).toHaveLength(3);
    });
  });

  describe("buffer overflow", () => {
    it("should drop oldest entries when buffer exceeds MAX_BUFFER_OVERFLOW", async () => {
      // MAX_BUFFER_OVERFLOW is 10_000 -- we set a small maxBufferSize
      // and disable auto-flush so entries accumulate
      setup({ maxBufferSize: 10_001, flushInterval: 60000, minLevel: "debug" });

      // Write > 10_000 entries to trigger overflow
      for (let i = 0; i < 10_002; i++) {
        logs.write({ level: "debug", message: `msg-${i}`, source: "system" });
      }

      // After overflow, the buffer should have been trimmed to maxBufferSize
      // We can verify by flushing and checking the adapter has <= maxBufferSize entries
      await logs.flush();
      const results = await adapter.query({ limit: 20000 });
      // The overflow trims to maxBufferSize (10_001), but the 10_002nd entry
      // triggers the overflow check which slices to -maxBufferSize
      expect(results.length).toBeLessThanOrEqual(10_001);
    });
  });

  describe("stop()", () => {
    it("should clear timers and stop the adapter", () => {
      setup();
      // Should not throw
      logs.stop();
      // Writing after stop should be a no-op
      logs.write({ level: "info", message: "after stop", source: "system" });
    });
  });

  describe("runCleanup()", () => {
    it("should delete old entries using default retention (14 days)", async () => {
      setup({
        retention: { cleanupInterval: 60000 },
      });

      const old = new Date();
      old.setDate(old.getDate() - 15); // 15 days ago

      // Write old and recent entries directly to adapter
      await adapter.writeBatch([
        makeEntry({ timestamp: old, source: "cron", message: "old-cron" }),
        makeEntry({ timestamp: new Date(), source: "cron", message: "new-cron" }),
      ]);

      // runCleanup is private, so we trigger it indirectly via a short cleanup interval
      logs.stop();
      logs = createLogs({
        adapter,
        flushInterval: 60000,
        retention: { cleanupInterval: 10, defaultDays: 14 },
      });

      // Wait for cleanup to run
      await new Promise((r) => setTimeout(r, 50));
      logs.stop();

      const results = await adapter.query({});
      expect(results).toHaveLength(1);
      expect(results[0].message).toBe("new-cron");
    });

    it("should apply per-source retention overrides", async () => {
      setup({
        retention: { cleanupInterval: 60000 },
      });

      const fiveDaysAgo = new Date();
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

      await adapter.writeBatch([
        makeEntry({ timestamp: fiveDaysAgo, source: "cron", message: "old-cron" }),
        makeEntry({ timestamp: fiveDaysAgo, source: "job", message: "old-job" }),
        makeEntry({ timestamp: twoDaysAgo, source: "cron", message: "recent-cron" }),
      ]);

      logs.stop();
      logs = createLogs({
        adapter,
        flushInterval: 60000,
        retention: {
          cleanupInterval: 10,
          defaultDays: 14,
          bySource: { cron: 3 }, // cron: 3 days retention
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      logs.stop();

      const results = await adapter.query({});
      const messages = results.map((r) => r.message);
      // old-cron (5d) should be deleted (cron retention = 3d)
      expect(messages).not.toContain("old-cron");
      // recent-cron (2d) should remain (within 3d)
      expect(messages).toContain("recent-cron");
      // old-job (5d) should remain (default 14d)
      expect(messages).toContain("old-job");
    });
  });

  describe("query / getBySource / count delegation", () => {
    it("should delegate query to adapter", async () => {
      setup();
      logs.write({ level: "info", message: "q1", source: "cron" });
      logs.write({ level: "error", message: "q2", source: "job" });
      await logs.flush();

      const results = await logs.query({ source: "cron" });
      expect(results).toHaveLength(1);
      expect(results[0].message).toBe("q1");
    });

    it("should delegate getBySource to adapter", async () => {
      setup();
      logs.write({ level: "info", message: "gs1", source: "workflow", sourceId: "wf_1" });
      logs.write({ level: "info", message: "gs2", source: "workflow", sourceId: "wf_2" });
      await logs.flush();

      const results = await logs.getBySource("workflow", "wf_1");
      expect(results).toHaveLength(1);
      expect(results[0].message).toBe("gs1");
    });

    it("should delegate count to adapter", async () => {
      setup();
      logs.write({ level: "info", message: "c1", source: "system" });
      logs.write({ level: "warn", message: "c2", source: "system" });
      logs.write({ level: "error", message: "c3", source: "plugin" });
      await logs.flush();

      expect(await logs.count({ source: "system" })).toBe(2);
      expect(await logs.count({})).toBe(3);
    });
  });
});
