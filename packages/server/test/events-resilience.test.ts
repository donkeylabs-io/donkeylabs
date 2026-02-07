import { describe, it, expect, beforeEach } from "bun:test";
import {
  createEvents,
  type Events,
  type EventAdapter,
  type EventMetadata,
  type EventRecord,
  MemoryEventAdapter,
} from "../src/core/events";
import { createSSE, type SSE } from "../src/core/sse";

// ==========================================
// Events: EventMetadata support in emit()
// ==========================================

describe("Events - EventMetadata", () => {
  let events: Events;

  beforeEach(() => {
    events = createEvents();
  });

  it("should accept metadata as third argument to emit()", async () => {
    // Should not throw
    await events.emit("order.created", { id: "1" }, { traceId: "trace-abc", source: "test" });
  });

  it("should store metadata in adapter history", async () => {
    const adapter = new MemoryEventAdapter();
    const events = createEvents({ adapter });

    await events.emit("user.signup", { email: "a@b.com" }, {
      traceId: "trace-123",
      source: "api-gateway",
    });

    const history = await events.getHistory("user.signup");
    expect(history).toHaveLength(1);
    expect(history[0].metadata).toBeDefined();
    expect(history[0].metadata?.traceId).toBe("trace-123");
    expect(history[0].metadata?.source).toBe("api-gateway");
  });

  it("should work without metadata (backwards compatible)", async () => {
    const adapter = new MemoryEventAdapter();
    const events = createEvents({ adapter });

    await events.emit("simple.event", { value: 42 });

    const history = await events.getHistory("simple.event");
    expect(history).toHaveLength(1);
    // metadata should be undefined when not provided
    expect(history[0].metadata).toBeUndefined();
  });

  it("should pass metadata with arbitrary extra fields", async () => {
    const adapter = new MemoryEventAdapter();
    const events = createEvents({ adapter });

    await events.emit("custom.event", { data: true }, {
      traceId: "t-1",
      source: "worker",
      customField: "extra-value",
      numericField: 42,
    });

    const history = await events.getHistory("custom.event");
    expect(history[0].metadata?.customField).toBe("extra-value");
    expect(history[0].metadata?.numericField).toBe(42);
  });

  it("should pass metadata through custom adapter publish", async () => {
    let capturedMetadata: EventMetadata | undefined;

    const customAdapter: EventAdapter = {
      async publish(event, data, metadata) {
        capturedMetadata = metadata;
      },
      async getHistory() {
        return [];
      },
    };

    const events = createEvents({ adapter: customAdapter });
    await events.emit("test.event", {}, { traceId: "captured-trace" });

    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata?.traceId).toBe("captured-trace");
  });
});

// ==========================================
// Events: stop() clears handlers
// ==========================================

describe("Events - stop()", () => {
  it("should clear all handlers on stop()", async () => {
    const events = createEvents();
    const received: any[] = [];

    events.on("test.event", (data) => received.push(data));

    await events.emit("test.event", { n: 1 });
    expect(received).toHaveLength(1);

    await events.stop();

    // After stop, emit should be silently ignored (stopped flag)
    await events.emit("test.event", { n: 2 });
    expect(received).toHaveLength(1);
  });

  it("should call adapter stop() if available", async () => {
    let adapterStopped = false;

    const adapter: EventAdapter = {
      async publish() {},
      async getHistory() {
        return [];
      },
      async stop() {
        adapterStopped = true;
      },
    };

    const events = createEvents({ adapter });
    await events.stop();

    expect(adapterStopped).toBe(true);
  });

  it("should not throw if adapter has no stop()", async () => {
    const adapter: EventAdapter = {
      async publish() {},
      async getHistory() {
        return [];
      },
      // No stop() method
    };

    const events = createEvents({ adapter });
    // Should not throw
    await events.stop();
  });

  it("should not deliver events after stop()", async () => {
    const events = createEvents();
    const received: string[] = [];

    events.on("after-stop", (data: { msg: string }) => received.push(data.msg));

    await events.stop();
    await events.emit("after-stop", { msg: "should-not-arrive" });

    expect(received).toHaveLength(0);
  });
});

// ==========================================
// Events: Distributed adapter subscribe
// ==========================================

describe("Events - Distributed adapter subscribe", () => {
  it("should invoke local handlers when adapter fires subscribe callback", async () => {
    let subscribeCallback: ((event: string, data: any, metadata?: EventMetadata) => void) | null = null;

    const distributedAdapter: EventAdapter = {
      async publish() {},
      async getHistory() {
        return [];
      },
      async subscribe(callback) {
        subscribeCallback = callback;
      },
    };

    const events = createEvents({ adapter: distributedAdapter });
    const received: any[] = [];

    events.on("remote.event", (data) => received.push(data));

    // Wait a tick for the adapter subscribe to complete
    await new Promise((r) => setTimeout(r, 10));

    // Simulate a remote event arriving via the adapter
    expect(subscribeCallback).not.toBeNull();
    subscribeCallback!("remote.event", { fromRemote: true });

    // Give the sync dispatch a moment to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ fromRemote: true });
  });

  it("should propagate distributed events to SSE broadcastAll", async () => {
    let subscribeCallback: ((event: string, data: any, metadata?: EventMetadata) => void) | null = null;
    let sseBroadcastCalls: Array<{ event: string; data: any }> = [];

    const distributedAdapter: EventAdapter = {
      async publish() {},
      async getHistory() {
        return [];
      },
      async subscribe(callback) {
        subscribeCallback = callback;
      },
    };

    // Create a mock SSE-like object
    const mockSSE = {
      broadcastAll(event: string, data: any) {
        sseBroadcastCalls.push({ event, data });
      },
    };

    const events = createEvents({
      adapter: distributedAdapter,
      sse: mockSSE as any,
    });

    await new Promise((r) => setTimeout(r, 10));

    // Simulate distributed event
    subscribeCallback!("notification.new", { message: "hello" });

    await new Promise((r) => setTimeout(r, 10));

    expect(sseBroadcastCalls).toHaveLength(1);
    expect(sseBroadcastCalls[0].event).toBe("notification.new");
    expect(sseBroadcastCalls[0].data).toEqual({ message: "hello" });
  });

  it("should not set up subscribe when adapter has no subscribe method", () => {
    const simpleAdapter: EventAdapter = {
      async publish() {},
      async getHistory() {
        return [];
      },
      // No subscribe method
    };

    // Should not throw during construction
    const events = createEvents({ adapter: simpleAdapter });
    expect(events).toBeDefined();
  });

  it("should dispatch to pattern handlers from distributed events", async () => {
    let subscribeCallback: ((event: string, data: any) => void) | null = null;

    const distributedAdapter: EventAdapter = {
      async publish() {},
      async getHistory() {
        return [];
      },
      async subscribe(callback) {
        subscribeCallback = callback;
      },
    };

    const events = createEvents({ adapter: distributedAdapter });
    const wildcardReceived: any[] = [];

    events.on("order.*", (data) => wildcardReceived.push(data));

    await new Promise((r) => setTimeout(r, 10));

    subscribeCallback!("order.shipped", { orderId: "remote-1" });

    await new Promise((r) => setTimeout(r, 10));

    expect(wildcardReceived).toHaveLength(1);
    expect(wildcardReceived[0].orderId).toBe("remote-1");
  });
});

// ==========================================
// MemoryEventAdapter edge cases
// ==========================================

describe("MemoryEventAdapter", () => {
  it("should trim history to maxHistorySize", async () => {
    const adapter = new MemoryEventAdapter(3);

    await adapter.publish("evt", { n: 1 });
    await adapter.publish("evt", { n: 2 });
    await adapter.publish("evt", { n: 3 });
    await adapter.publish("evt", { n: 4 });

    const history = await adapter.getHistory("evt");
    expect(history).toHaveLength(3);
    // Should keep the most recent 3
    expect(history[0].data.n).toBe(2);
    expect(history[2].data.n).toBe(4);
  });

  it("should filter history by event name", async () => {
    const adapter = new MemoryEventAdapter();

    await adapter.publish("a", { type: "a" });
    await adapter.publish("b", { type: "b" });
    await adapter.publish("a", { type: "a2" });

    const historyA = await adapter.getHistory("a");
    expect(historyA).toHaveLength(2);

    const historyB = await adapter.getHistory("b");
    expect(historyB).toHaveLength(1);
  });

  it("should return all events with wildcard '*'", async () => {
    const adapter = new MemoryEventAdapter();

    await adapter.publish("x", { n: 1 });
    await adapter.publish("y", { n: 2 });

    const all = await adapter.getHistory("*");
    expect(all).toHaveLength(2);
  });

  it("should store metadata in history records", async () => {
    const adapter = new MemoryEventAdapter();

    await adapter.publish("evt", { data: true }, { traceId: "t-1", source: "test" });

    const history = await adapter.getHistory("evt");
    expect(history[0].metadata?.traceId).toBe("t-1");
    expect(history[0].metadata?.source).toBe("test");
  });
});
