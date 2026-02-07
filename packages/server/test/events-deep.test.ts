import { describe, it, expect, beforeEach } from "bun:test";
import {
  createEvents,
  type Events,
  type EventAdapter,
  type EventMetadata,
  MemoryEventAdapter,
} from "../src/core/events";

// ==========================================
// Events: once() with metadata
// ==========================================

describe("Events - once() with metadata", () => {
  let events: Events;

  beforeEach(() => {
    events = createEvents();
  });

  it("should fire once handler exactly one time even when emitted with metadata", async () => {
    const received: any[] = [];
    events.once("single-fire", (data: any) => received.push(data));

    await events.emit("single-fire", { n: 1 }, { traceId: "t1" });
    await events.emit("single-fire", { n: 2 }, { traceId: "t2" });
    await events.emit("single-fire", { n: 3 });

    expect(received).toHaveLength(1);
    expect(received[0].n).toBe(1);
  });

  it("should still deliver data (not metadata) to once handler", async () => {
    let receivedData: any;
    events.once("data-check", (data: any) => {
      receivedData = data;
    });

    await events.emit("data-check", { value: 42 }, { traceId: "meta-trace", source: "test" });

    expect(receivedData).toEqual({ value: 42 });
  });
});

// ==========================================
// Events: Subscription.unsubscribe()
// ==========================================

describe("Events - Subscription.unsubscribe()", () => {
  it("should stop receiving events after unsubscribe", async () => {
    const events = createEvents();
    const received: any[] = [];

    const sub = events.on("unsub-test", (data: any) => received.push(data));

    await events.emit("unsub-test", { n: 1 });
    sub.unsubscribe();
    await events.emit("unsub-test", { n: 2 });

    expect(received).toHaveLength(1);
    expect(received[0].n).toBe(1);
  });

  it("should be safe to unsubscribe twice", async () => {
    const events = createEvents();
    const sub = events.on("double-unsub", () => {});

    sub.unsubscribe();
    sub.unsubscribe(); // Should not throw
  });

  it("should not affect other handlers when one unsubscribes", async () => {
    const events = createEvents();
    const receivedA: any[] = [];
    const receivedB: any[] = [];

    const subA = events.on("multi", (d: any) => receivedA.push(d));
    events.on("multi", (d: any) => receivedB.push(d));

    await events.emit("multi", { n: 1 });
    subA.unsubscribe();
    await events.emit("multi", { n: 2 });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(2);
  });
});

// ==========================================
// Events: off() behavior
// ==========================================

describe("Events - off()", () => {
  it("should remove a specific handler when passed", async () => {
    const events = createEvents();
    const received: any[] = [];
    const handler = (d: any) => received.push(d);

    events.on("off-test", handler);
    events.on("off-test", (d: any) => received.push({ other: d }));

    await events.emit("off-test", { n: 1 });
    expect(received).toHaveLength(2);

    events.off("off-test", handler);
    await events.emit("off-test", { n: 2 });

    // Only the second handler fires now
    expect(received).toHaveLength(3);
  });

  it("should remove all handlers for an event when no handler specified", async () => {
    const events = createEvents();
    const received: any[] = [];

    events.on("off-all", (d: any) => received.push(d));
    events.on("off-all", (d: any) => received.push(d));

    await events.emit("off-all", { n: 1 });
    expect(received).toHaveLength(2);

    events.off("off-all");
    await events.emit("off-all", { n: 2 });

    // No new events delivered
    expect(received).toHaveLength(2);
  });

  it("should not throw when calling off() on non-existent event", () => {
    const events = createEvents();
    events.off("nonexistent"); // Should not throw
    events.off("nonexistent", () => {}); // Should not throw
  });

  it("should not deliver events after stop() even with on() handlers", async () => {
    const events = createEvents();
    const received: any[] = [];

    events.on("post-stop", (d: any) => received.push(d));
    await events.stop();

    // New subscriptions after stop
    events.on("post-stop", (d: any) => received.push(d));
    await events.emit("post-stop", { n: 1 });

    expect(received).toHaveLength(0);
  });
});

// ==========================================
// Events: Concurrent emit and stop
// ==========================================

describe("Events - concurrent emit/stop race conditions", () => {
  it("should handle concurrent emits without losing events", async () => {
    const events = createEvents();
    const received: number[] = [];

    events.on("concurrent", (d: { n: number }) => received.push(d.n));

    // Fire 20 events concurrently
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => events.emit("concurrent", { n: i }))
    );

    expect(received).toHaveLength(20);
    expect(received.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("should not crash when stop() is called during concurrent emits", async () => {
    const events = createEvents();
    let handlerCalls = 0;

    events.on("race-stop", () => {
      handlerCalls++;
    });

    // Start emitting and stop concurrently - should not throw
    const emitPromises = Array.from({ length: 10 }, (_, i) =>
      events.emit("race-stop", { n: i })
    );
    const stopPromise = events.stop();

    await Promise.all([...emitPromises, stopPromise]);

    // Some handlers may or may not have fired, but no crash
    expect(handlerCalls).toBeGreaterThanOrEqual(0);
    expect(handlerCalls).toBeLessThanOrEqual(10);
  });
});

// ==========================================
// Events: Error resilience in handlers
// ==========================================

describe("Events - handler error resilience", () => {
  it("should continue to deliver to other handlers when one throws synchronously", async () => {
    const events = createEvents();
    const received: any[] = [];

    events.on("err-sync", () => {
      throw new Error("sync boom");
    });
    events.on("err-sync", (d: any) => received.push(d));

    await events.emit("err-sync", { value: 1 });
    expect(received).toHaveLength(1);
    expect(received[0].value).toBe(1);
  });

  it("should continue to deliver to other handlers when one rejects async", async () => {
    const events = createEvents();
    const received: any[] = [];

    events.on("err-async", async () => {
      throw new Error("async boom");
    });
    events.on("err-async", (d: any) => received.push(d));

    await events.emit("err-async", { value: 2 });
    expect(received).toHaveLength(1);
    expect(received[0].value).toBe(2);
  });
});

// ==========================================
// Events: Pattern matching edge cases
// ==========================================

describe("Events - pattern matching edge cases", () => {
  it("should match nested wildcard patterns like 'a.b.*'", async () => {
    const events = createEvents();
    const received: any[] = [];

    events.on("a.b.*", (d: any) => received.push(d));

    await events.emit("a.b.c", { deep: true });
    await events.emit("a.b.c.d", { deeper: true });
    await events.emit("a.x.c", { wrong: true });

    expect(received).toHaveLength(2); // matches a.b.c and a.b.c.d
    expect(received[0].deep).toBe(true);
  });

  it("should match '*' pattern (all events)", async () => {
    const events = createEvents();
    const received: any[] = [];

    events.on("*", (d: any) => received.push(d));

    await events.emit("foo", { a: 1 });
    await events.emit("bar.baz", { b: 2 });

    expect(received).toHaveLength(2);
  });

  it("should not double-deliver to exact+pattern match on same event", async () => {
    const events = createEvents();
    const exactReceived: any[] = [];
    const patternReceived: any[] = [];

    events.on("order.created", (d: any) => exactReceived.push(d));
    events.on("order.*", (d: any) => patternReceived.push(d));

    await events.emit("order.created", { orderId: "1" });

    // Exact and pattern are independent handler sets
    expect(exactReceived).toHaveLength(1);
    expect(patternReceived).toHaveLength(1);
  });
});

// ==========================================
// Events: getHistory edge cases
// ==========================================

describe("Events - getHistory edge cases", () => {
  it("should return empty array for events never emitted", async () => {
    const events = createEvents();
    const history = await events.getHistory("never-emitted");
    expect(history).toHaveLength(0);
  });

  it("should respect limit parameter", async () => {
    const adapter = new MemoryEventAdapter();
    const events = createEvents({ adapter });

    for (let i = 0; i < 10; i++) {
      await events.emit("limited", { n: i });
    }

    const history = await events.getHistory("limited", 3);
    expect(history).toHaveLength(3);
    // Should return the most recent 3
    expect(history[0].data.n).toBe(7);
    expect(history[2].data.n).toBe(9);
  });

  it("should return history from before stop() was called", async () => {
    const adapter = new MemoryEventAdapter();
    const events = createEvents({ adapter });

    await events.emit("pre-stop", { n: 1 });
    await events.emit("pre-stop", { n: 2 });
    await events.stop();

    // History is stored in adapter, should still be accessible
    const history = await adapter.getHistory("pre-stop");
    expect(history).toHaveLength(2);
  });
});

// ==========================================
// Events: Distributed adapter with metadata
// ==========================================

describe("Events - distributed adapter metadata propagation", () => {
  it("should pass metadata through distributed subscribe callback", async () => {
    let subscribeCallback: ((event: string, data: any, metadata?: EventMetadata) => void) | null = null;

    const distAdapter: EventAdapter = {
      async publish() {},
      async getHistory() { return []; },
      async subscribe(callback) {
        subscribeCallback = callback;
      },
    };

    const events = createEvents({ adapter: distAdapter });
    const received: any[] = [];
    events.on("remote.with-meta", (d: any) => received.push(d));

    await new Promise(r => setTimeout(r, 10));

    // Simulate remote event with metadata
    subscribeCallback!("remote.with-meta", { id: "r1" }, { traceId: "remote-trace", source: "node-2" });

    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe("r1");
  });

  it("should not re-publish distributed events to adapter", async () => {
    let publishCalls = 0;
    let subscribeCallback: ((event: string, data: any) => void) | null = null;

    const distAdapter: EventAdapter = {
      async publish() { publishCalls++; },
      async getHistory() { return []; },
      async subscribe(callback) {
        subscribeCallback = callback;
      },
    };

    createEvents({ adapter: distAdapter });

    await new Promise(r => setTimeout(r, 10));

    // Simulate remote event
    subscribeCallback!("remote.event", { data: true });

    await new Promise(r => setTimeout(r, 10));

    // The distributed callback should NOT cause a re-publish
    expect(publishCalls).toBe(0);
  });
});
