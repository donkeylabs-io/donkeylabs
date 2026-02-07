import { describe, it, expect } from "bun:test";
import {
  MemoryRateLimitAdapter,
  createRateLimiter,
  extractClientIP,
  parseDuration,
  createRateLimitKey,
} from "../src/core/rate-limiter";

describe("MemoryRateLimitAdapter", () => {
  it("should increment and return count 1 for first request", async () => {
    const adapter = new MemoryRateLimitAdapter();
    const result = await adapter.increment("key1", 60000);
    expect(result.count).toBe(1);
    expect(result.resetAt).toBeInstanceOf(Date);
  });

  it("should increment count within same window", async () => {
    const adapter = new MemoryRateLimitAdapter();
    await adapter.increment("key1", 60000);
    const result = await adapter.increment("key1", 60000);
    expect(result.count).toBe(2);
  });

  it("should create new window after reset", async () => {
    const adapter = new MemoryRateLimitAdapter();
    // Use a very short window
    await adapter.increment("key1", 1);
    await new Promise((r) => setTimeout(r, 10));
    const result = await adapter.increment("key1", 60000);
    expect(result.count).toBe(1); // New window
  });

  it("should get existing entry", async () => {
    const adapter = new MemoryRateLimitAdapter();
    await adapter.increment("key1", 60000);
    const entry = await adapter.get("key1");
    expect(entry).not.toBeNull();
    expect(entry!.count).toBe(1);
  });

  it("should return null for non-existent key", async () => {
    const adapter = new MemoryRateLimitAdapter();
    const entry = await adapter.get("missing");
    expect(entry).toBeNull();
  });

  it("should return null and clean up expired entry on get", async () => {
    const adapter = new MemoryRateLimitAdapter();
    await adapter.increment("key1", 1); // 1ms window
    await new Promise((r) => setTimeout(r, 10));
    const entry = await adapter.get("key1");
    expect(entry).toBeNull();
  });

  it("should reset a key", async () => {
    const adapter = new MemoryRateLimitAdapter();
    await adapter.increment("key1", 60000);
    await adapter.reset("key1");
    const entry = await adapter.get("key1");
    expect(entry).toBeNull();
  });
});

describe("RateLimiter (via createRateLimiter)", () => {
  it("should allow requests under the limit", async () => {
    const limiter = createRateLimiter();
    const result = await limiter.check("test-key", 5, 60000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.limit).toBe(5);
    expect(result.retryAfter).toBeUndefined();
  });

  it("should deny requests over the limit", async () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.check("over-key", 3, 60000);
    }
    const result = await limiter.check("over-key", 3, 60000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("should reset a key", async () => {
    const limiter = createRateLimiter();
    await limiter.check("reset-key", 1, 60000);
    await limiter.reset("reset-key");
    const result = await limiter.check("reset-key", 1, 60000);
    expect(result.allowed).toBe(true);
  });
});

describe("extractClientIP", () => {
  it("should extract from cf-connecting-ip", () => {
    const req = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    expect(extractClientIP(req)).toBe("1.2.3.4");
  });

  it("should extract from x-real-ip", () => {
    const req = new Request("http://localhost", {
      headers: { "x-real-ip": "5.6.7.8" },
    });
    expect(extractClientIP(req)).toBe("5.6.7.8");
  });

  it("should extract first IP from x-forwarded-for", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3" },
    });
    expect(extractClientIP(req)).toBe("10.0.0.1");
  });

  it("should fall back to socket address", () => {
    const req = new Request("http://localhost");
    expect(extractClientIP(req, "192.168.1.1")).toBe("192.168.1.1");
  });

  it("should return unknown when no IP found", () => {
    const req = new Request("http://localhost");
    expect(extractClientIP(req)).toBe("unknown");
  });

  it("should reject invalid IPs in headers", () => {
    const req = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "not-an-ip" },
    });
    expect(extractClientIP(req)).toBe("unknown");
  });

  it("should handle IPv6 addresses", () => {
    const req = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "::1" },
    });
    expect(extractClientIP(req)).toBe("::1");
  });

  it("should handle IPv4-mapped IPv6", () => {
    const req = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "::ffff:192.168.1.1" },
    });
    expect(extractClientIP(req)).toBe("::ffff:192.168.1.1");
  });
});

describe("parseDuration", () => {
  it("should parse milliseconds", () => {
    expect(parseDuration("100ms")).toBe(100);
  });

  it("should parse seconds", () => {
    expect(parseDuration("10s")).toBe(10000);
  });

  it("should parse minutes", () => {
    expect(parseDuration("5m")).toBe(300000);
  });

  it("should parse hours", () => {
    expect(parseDuration("1h")).toBe(3600000);
  });

  it("should parse days", () => {
    expect(parseDuration("1d")).toBe(86400000);
  });

  it("should throw for invalid format", () => {
    expect(() => parseDuration("invalid")).toThrow("Invalid duration format");
  });
});

describe("createRateLimitKey", () => {
  it("should create a key from route and IP", () => {
    expect(createRateLimitKey("users.list", "1.2.3.4")).toBe("ratelimit:users.list:1.2.3.4");
  });
});
