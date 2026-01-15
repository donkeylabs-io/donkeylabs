import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createLogger,
  createCache,
  createEvents,
  createCron,
  createJobs,
  createSSE,
  createRateLimiter,
  extractClientIP,
  parseDuration,
  createRateLimitKey,
  type Logger,
  type Cache,
  type Events,
  type Cron,
  type Jobs,
  type SSE,
  type RateLimiter,
} from "../src/core/index";

// ==========================================
// Logger Tests
// ==========================================
describe("Logger Service", () => {
  it("should create a logger with default config", () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(logger.debug).toBeInstanceOf(Function);
    expect(logger.info).toBeInstanceOf(Function);
    expect(logger.warn).toBeInstanceOf(Function);
    expect(logger.error).toBeInstanceOf(Function);
  });

  it("should create child loggers with context", () => {
    const logger = createLogger({ level: "debug" });
    const child = logger.child({ requestId: "123" });
    expect(child).toBeDefined();

    // Child should have same methods
    expect(child.debug).toBeInstanceOf(Function);
    expect(child.info).toBeInstanceOf(Function);
  });

  it("should respect log levels", () => {
    // Create logger with 'error' level - only errors should be logged
    const logs: string[] = [];
    const mockTransport = {
      log: (entry: any) => logs.push(entry.level),
    };

    const logger = createLogger({ level: "error", transports: [mockTransport] });

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(logs).toEqual(["error"]);
  });

  it("should log all levels when set to debug", () => {
    const logs: string[] = [];
    const mockTransport = {
      log: (entry: any) => logs.push(entry.level),
    };

    const logger = createLogger({ level: "debug", transports: [mockTransport] });

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(logs).toEqual(["debug", "info", "warn", "error"]);
  });
});

// ==========================================
// Cache Tests
// ==========================================
describe("Cache Service", () => {
  let cache: Cache;

  beforeEach(() => {
    cache = createCache();
  });

  it("should store and retrieve values", async () => {
    await cache.set("key1", "value1");
    const result = await cache.get<string>("key1");
    expect(result).toBe("value1");
  });

  it("should return null for non-existent keys", async () => {
    const result = await cache.get("nonexistent");
    expect(result).toBeNull();
  });

  it("should delete keys", async () => {
    await cache.set("key1", "value1");
    const deleted = await cache.delete("key1");
    expect(deleted).toBe(true);

    const result = await cache.get("key1");
    expect(result).toBeNull();
  });

  it("should check if key exists", async () => {
    await cache.set("exists", "yes");

    expect(await cache.has("exists")).toBe(true);
    expect(await cache.has("nope")).toBe(false);
  });

  it("should clear all keys", async () => {
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3);

    await cache.clear();

    expect(await cache.has("a")).toBe(false);
    expect(await cache.has("b")).toBe(false);
    expect(await cache.has("c")).toBe(false);
  });

  it("should list keys with pattern matching", async () => {
    await cache.set("user:1", { name: "Alice" });
    await cache.set("user:2", { name: "Bob" });
    await cache.set("post:1", { title: "Hello" });

    const userKeys = await cache.keys("user:*");
    expect(userKeys).toHaveLength(2);
    expect(userKeys).toContain("user:1");
    expect(userKeys).toContain("user:2");

    const allKeys = await cache.keys();
    expect(allKeys).toHaveLength(3);
  });

  it("should support getOrSet pattern", async () => {
    let factoryCalls = 0;
    const factory = async () => {
      factoryCalls++;
      return "computed-value";
    };

    // First call - should invoke factory
    const val1 = await cache.getOrSet("computed", factory);
    expect(val1).toBe("computed-value");
    expect(factoryCalls).toBe(1);

    // Second call - should use cached value
    const val2 = await cache.getOrSet("computed", factory);
    expect(val2).toBe("computed-value");
    expect(factoryCalls).toBe(1); // Not called again
  });

  it("should expire values after TTL", async () => {
    await cache.set("short-lived", "value", 50); // 50ms TTL

    // Immediately available
    expect(await cache.get("short-lived")).toBe("value");

    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(await cache.get("short-lived")).toBeNull();
  });

  it("should handle complex objects", async () => {
    const obj = { nested: { data: [1, 2, 3] }, date: new Date().toISOString() };
    await cache.set("complex", obj);

    const retrieved = await cache.get<typeof obj>("complex");
    expect(retrieved).toEqual(obj);
  });
});

// ==========================================
// Events Tests
// ==========================================
describe("Events Service", () => {
  let events: Events;

  beforeEach(() => {
    events = createEvents();
  });

  it("should emit and receive events", async () => {
    const received: any[] = [];

    events.on("user.created", (data) => {
      received.push(data);
    });

    await events.emit("user.created", { id: 1, name: "Alice" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ id: 1, name: "Alice" });
  });

  it("should support multiple handlers for same event", async () => {
    const handler1Calls: any[] = [];
    const handler2Calls: any[] = [];

    events.on("test", (data) => handler1Calls.push(data));
    events.on("test", (data) => handler2Calls.push(data));

    await events.emit("test", { value: 42 });

    expect(handler1Calls).toHaveLength(1);
    expect(handler2Calls).toHaveLength(1);
  });

  it("should support once handlers", async () => {
    const received: any[] = [];

    events.once("once-event", (data) => {
      received.push(data);
    });

    await events.emit("once-event", { count: 1 });
    await events.emit("once-event", { count: 2 });

    // Should only receive first event
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ count: 1 });
  });

  it("should support unsubscribing", async () => {
    const received: any[] = [];

    const subscription = events.on("sub-test", (data) => {
      received.push(data);
    });

    await events.emit("sub-test", { n: 1 });
    subscription.unsubscribe();
    await events.emit("sub-test", { n: 2 });

    expect(received).toHaveLength(1);
  });

  it("should support pattern matching with wildcards", async () => {
    const received: any[] = [];

    events.on("user.*", (data) => {
      received.push(data);
    });

    await events.emit("user.created", { action: "created" });
    await events.emit("user.updated", { action: "updated" });
    await events.emit("post.created", { action: "post" }); // Should not match

    expect(received).toHaveLength(2);
  });

  it("should maintain event history", async () => {
    await events.emit("log", { msg: "first" });
    await events.emit("log", { msg: "second" });
    await events.emit("log", { msg: "third" });

    const history = await events.getHistory("log");
    expect(history).toHaveLength(3);
    expect(history[0].data).toEqual({ msg: "first" });
    expect(history[2].data).toEqual({ msg: "third" });
  });

  it("should support off() to remove all handlers", async () => {
    const received: any[] = [];

    events.on("cleanup", (data) => received.push(data));
    events.on("cleanup", (data) => received.push(data));

    await events.emit("cleanup", 1);
    expect(received).toHaveLength(2);

    events.off("cleanup");
    await events.emit("cleanup", 2);
    expect(received).toHaveLength(2); // No new events
  });
});

// ==========================================
// Cron Tests
// ==========================================
describe("Cron Service", () => {
  let cron: Cron;

  beforeEach(() => {
    cron = createCron();
  });

  afterEach(async () => {
    await cron.stop();
  });

  it("should schedule tasks", () => {
    const taskId = cron.schedule("* * * * *", () => {});
    expect(taskId).toMatch(/^cron_/);
  });

  it("should list scheduled tasks", () => {
    cron.schedule("* * * * *", () => {}, { name: "task1" });
    cron.schedule("0 * * * *", () => {}, { name: "task2" });

    const tasks = cron.list();
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.name)).toContain("task1");
    expect(tasks.map(t => t.name)).toContain("task2");
  });

  it("should unschedule tasks", () => {
    const taskId = cron.schedule("* * * * *", () => {});
    expect(cron.list()).toHaveLength(1);

    const removed = cron.unschedule(taskId);
    expect(removed).toBe(true);
    expect(cron.list()).toHaveLength(0);
  });

  it("should pause and resume tasks", () => {
    const taskId = cron.schedule("* * * * *", () => {}, { name: "pausable" });

    let task = cron.get(taskId);
    expect(task?.enabled).toBe(true);

    cron.pause(taskId);
    task = cron.get(taskId);
    expect(task?.enabled).toBe(false);

    cron.resume(taskId);
    task = cron.get(taskId);
    expect(task?.enabled).toBe(true);
  });

  it("should trigger tasks manually", async () => {
    let executed = false;

    const taskId = cron.schedule("0 0 1 1 *", () => {
      executed = true;
    });

    await cron.trigger(taskId);
    expect(executed).toBe(true);
  });

  it("should support 6-field cron expressions", () => {
    // Second, minute, hour, day, month, dayOfWeek
    const taskId = cron.schedule("0 30 9 * * 1", () => {});
    const task = cron.get(taskId);
    expect(task).toBeDefined();
    expect(task?.expression).toBe("0 30 9 * * 1");
  });

  it("should support step expressions", () => {
    const taskId = cron.schedule("*/5 * * * *", () => {}, { name: "every-5-min" });
    const task = cron.get(taskId);
    expect(task).toBeDefined();
  });

  it("should support range expressions", () => {
    const taskId = cron.schedule("0 9-17 * * 1-5", () => {}, { name: "weekday-hours" });
    const task = cron.get(taskId);
    expect(task).toBeDefined();
  });

  it("should calculate next run time", () => {
    const taskId = cron.schedule("* * * * *", () => {});
    const task = cron.get(taskId);

    expect(task?.nextRun).toBeDefined();
    expect(task?.nextRun instanceof Date).toBe(true);
  });
});

// ==========================================
// Jobs Tests
// ==========================================
describe("Jobs Service", () => {
  let jobs: Jobs;
  let events: Events;

  beforeEach(() => {
    events = createEvents();
    jobs = createJobs({ events, pollInterval: 50 });
  });

  afterEach(async () => {
    await jobs.stop();
  });

  it("should register job handlers", () => {
    jobs.register("sendEmail", async (data: { to: string }) => {
      return { sent: true };
    });

    // Should not throw
    expect(true).toBe(true);
  });

  it("should enqueue and process jobs", async () => {
    let processed = false;

    jobs.register("simple", async () => {
      processed = true;
    });

    const jobId = await jobs.enqueue("simple", {});
    jobs.start();

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(processed).toBe(true);

    const job = await jobs.get(jobId);
    expect(job?.status).toBe("completed");
  });

  it("should pass data to job handler", async () => {
    let receivedData: any = null;

    jobs.register("withData", async (data) => {
      receivedData = data;
    });

    await jobs.enqueue("withData", { userId: 123, action: "welcome" });
    jobs.start();

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(receivedData).toEqual({ userId: 123, action: "welcome" });
  });

  it("should schedule jobs for future execution", async () => {
    let executed = false;

    jobs.register("scheduled", async () => {
      executed = true;
    });

    const runAt = new Date(Date.now() + 100); // 100ms from now
    const jobId = await jobs.schedule("scheduled", {}, runAt);

    jobs.start();

    // Verify job starts as scheduled
    let job = await jobs.get(jobId);
    expect(job?.status).toBe("scheduled");

    // Poll until executed or timeout
    const timeout = Date.now() + 1000; // 1 second timeout
    while (!executed && Date.now() < timeout) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    expect(executed).toBe(true);
  });

  it("should emit events on job completion", async () => {
    const completedEvents: any[] = [];

    events.on("job.completed", (data) => {
      completedEvents.push(data);
    });

    jobs.register("emitting", async () => ({ result: "done" }));
    await jobs.enqueue("emitting", {});

    jobs.start();
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].name).toBe("emitting");
  });

  it("should retry failed jobs", async () => {
    let attempts = 0;

    jobs.register("flaky", async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("Temporary failure");
      }
      return { success: true };
    });

    await jobs.enqueue("flaky", {}, { maxAttempts: 5 });
    jobs.start();

    await new Promise(resolve => setTimeout(resolve, 500));

    expect(attempts).toBe(3);

    const allJobs = await jobs.getByName("flaky");
    expect(allJobs[0]?.status).toBe("completed");
  });

  it("should mark job as failed after max attempts", async () => {
    jobs.register("alwaysFails", async () => {
      throw new Error("Always fails");
    });

    const jobId = await jobs.enqueue("alwaysFails", {}, { maxAttempts: 2 });
    jobs.start();

    await new Promise(resolve => setTimeout(resolve, 300));

    const job = await jobs.get(jobId);
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(2);
  });

  it("should cancel pending jobs", async () => {
    jobs.register("cancellable", async () => {});

    const jobId = await jobs.enqueue("cancellable", {});
    const cancelled = await jobs.cancel(jobId);

    expect(cancelled).toBe(true);
    expect(await jobs.get(jobId)).toBeNull();
  });

  it("should get jobs by name and status", async () => {
    jobs.register("batch", async () => {});

    await jobs.enqueue("batch", { id: 1 });
    await jobs.enqueue("batch", { id: 2 });
    await jobs.enqueue("batch", { id: 3 });

    const pending = await jobs.getByName("batch", "pending");
    expect(pending).toHaveLength(3);
  });
});

// ==========================================
// SSE Tests
// ==========================================
describe("SSE Service", () => {
  let sse: SSE;

  beforeEach(() => {
    sse = createSSE({ heartbeatInterval: 10000 }); // Long interval for tests
  });

  afterEach(() => {
    sse.shutdown();
  });

  it("should add clients", () => {
    const { client, response } = sse.addClient();

    expect(client.id).toMatch(/^sse_/);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(sse.getClients()).toHaveLength(1);
  });

  it("should remove clients", () => {
    const { client } = sse.addClient();
    expect(sse.getClients()).toHaveLength(1);

    sse.removeClient(client.id);
    expect(sse.getClients()).toHaveLength(0);
  });

  it("should subscribe clients to channels", () => {
    const { client } = sse.addClient();

    sse.subscribe(client.id, "notifications");
    sse.subscribe(client.id, "updates");

    expect(client.channels.has("notifications")).toBe(true);
    expect(client.channels.has("updates")).toBe(true);
  });

  it("should unsubscribe clients from channels", () => {
    const { client } = sse.addClient();

    sse.subscribe(client.id, "channel1");
    expect(client.channels.has("channel1")).toBe(true);

    sse.unsubscribe(client.id, "channel1");
    expect(client.channels.has("channel1")).toBe(false);
  });

  it("should get client by ID", () => {
    const { client } = sse.addClient();

    const retrieved = sse.getClient(client.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(client.id);
  });

  it("should get clients by channel", () => {
    const { client: c1 } = sse.addClient();
    const { client: c2 } = sse.addClient();
    const { client: c3 } = sse.addClient();

    sse.subscribe(c1.id, "news");
    sse.subscribe(c2.id, "news");
    sse.subscribe(c3.id, "sports");

    const newsClients = sse.getClientsByChannel("news");
    expect(newsClients).toHaveLength(2);
  });

  it("should broadcast to channel subscribers", () => {
    const { client: c1 } = sse.addClient();
    const { client: c2 } = sse.addClient();

    sse.subscribe(c1.id, "updates");
    // c2 not subscribed

    // Broadcast should not throw
    sse.broadcast("updates", "newData", { value: 42 });
  });

  it("should send to specific client", () => {
    const { client } = sse.addClient();

    const sent = sse.sendTo(client.id, "private", { secret: "data" });
    expect(sent).toBe(true);

    const notSent = sse.sendTo("nonexistent", "private", {});
    expect(notSent).toBe(false);
  });

  it("should shutdown and close all connections", () => {
    sse.addClient();
    sse.addClient();
    sse.addClient();

    expect(sse.getClients()).toHaveLength(3);

    sse.shutdown();

    expect(sse.getClients()).toHaveLength(0);
  });
});

// ==========================================
// Rate Limiter Tests
// ==========================================
describe("Rate Limiter Service", () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    rateLimiter = createRateLimiter();
  });

  it("should allow requests within limit", async () => {
    const result = await rateLimiter.check("user:1", 10, 60000);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
  });

  it("should block requests over limit", async () => {
    // Use up all requests
    for (let i = 0; i < 5; i++) {
      await rateLimiter.check("user:2", 5, 60000);
    }

    const result = await rateLimiter.check("user:2", 5, 60000);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("should track requests per key separately", async () => {
    await rateLimiter.check("key:a", 3, 60000);
    await rateLimiter.check("key:a", 3, 60000);

    const resultA = await rateLimiter.check("key:a", 3, 60000);
    const resultB = await rateLimiter.check("key:b", 3, 60000);

    expect(resultA.remaining).toBe(0);
    expect(resultB.remaining).toBe(2); // Fresh key
  });

  it("should reset after window expires", async () => {
    // Use all requests with short window
    for (let i = 0; i < 3; i++) {
      await rateLimiter.check("short", 3, 50);
    }

    let result = await rateLimiter.check("short", 3, 50);
    expect(result.allowed).toBe(false);

    // Wait for window to expire
    await new Promise(resolve => setTimeout(resolve, 100));

    result = await rateLimiter.check("short", 3, 50);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("should allow manual reset", async () => {
    await rateLimiter.check("resettable", 2, 60000);
    await rateLimiter.check("resettable", 2, 60000);

    let result = await rateLimiter.check("resettable", 2, 60000);
    expect(result.allowed).toBe(false);

    await rateLimiter.reset("resettable");

    result = await rateLimiter.check("resettable", 2, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it("should provide resetAt timestamp", async () => {
    const result = await rateLimiter.check("timestamp", 10, 60000);

    expect(result.resetAt).toBeInstanceOf(Date);
    expect(result.resetAt.getTime()).toBeGreaterThan(Date.now());
  });
});

// ==========================================
// IP Extraction Tests
// ==========================================
describe("IP Extraction", () => {
  it("should extract IP from CF-Connecting-IP header", () => {
    const req = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    expect(extractClientIP(req)).toBe("1.2.3.4");
  });

  it("should extract IP from X-Real-IP header", () => {
    const req = new Request("http://localhost", {
      headers: { "x-real-ip": "5.6.7.8" },
    });
    expect(extractClientIP(req)).toBe("5.6.7.8");
  });

  it("should extract first IP from X-Forwarded-For", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3" },
    });
    expect(extractClientIP(req)).toBe("10.0.0.1");
  });

  it("should fallback to socket address", () => {
    const req = new Request("http://localhost");
    expect(extractClientIP(req, "192.168.1.1")).toBe("192.168.1.1");
  });

  it("should return 'unknown' when no IP found", () => {
    const req = new Request("http://localhost");
    expect(extractClientIP(req)).toBe("unknown");
  });

  it("should validate IP addresses", () => {
    // Invalid IP should be rejected
    const req = new Request("http://localhost", {
      headers: { "x-real-ip": "not-an-ip" },
    });
    expect(extractClientIP(req)).toBe("unknown");
  });

  it("should handle IPv6 addresses", () => {
    const req = new Request("http://localhost", {
      headers: { "x-real-ip": "2001:db8::1" },
    });
    expect(extractClientIP(req)).toBe("2001:db8::1");
  });
});

// ==========================================
// Duration Parsing Tests
// ==========================================
describe("Duration Parsing", () => {
  it("should parse milliseconds", () => {
    expect(parseDuration("100ms")).toBe(100);
  });

  it("should parse seconds", () => {
    expect(parseDuration("30s")).toBe(30000);
  });

  it("should parse minutes", () => {
    expect(parseDuration("5m")).toBe(300000);
  });

  it("should parse hours", () => {
    expect(parseDuration("2h")).toBe(7200000);
  });

  it("should parse days", () => {
    expect(parseDuration("1d")).toBe(86400000);
  });

  it("should throw for invalid format", () => {
    expect(() => parseDuration("invalid")).toThrow();
    expect(() => parseDuration("10")).toThrow();
    expect(() => parseDuration("10x")).toThrow();
  });
});

// ==========================================
// Rate Limit Key Helper Tests
// ==========================================
describe("Rate Limit Key Helper", () => {
  it("should create rate limit keys", () => {
    const key = createRateLimitKey("api.users.list", "192.168.1.1");
    expect(key).toBe("ratelimit:api.users.list:192.168.1.1");
  });
});
