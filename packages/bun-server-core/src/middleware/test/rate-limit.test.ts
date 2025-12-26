import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Request } from "express";
import { RateLimit, RateLimiter } from "../rate-limit";

class InMemoryCache {
  store = new Map<string, any>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: any): Promise<void> {
    this.store.set(key, value);
  }

  /**
   * Atomic rate limit increment for testing
   * Mimics the behavior of SimpleCache.atomicRateLimitIncrement
   */
  async atomicRateLimitIncrement(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; firstAttempt: number; wasReset: boolean }> {
    const now = Date.now();
    const cacheKey = `rate_limit:${key}`;
    const existing = this.store.get(cacheKey) as { count: number; firstAttempt: number } | undefined;

    if (existing && now - existing.firstAttempt < windowMs) {
      // Within window - increment
      const newCount = existing.count + 1;
      const newData = { count: newCount, firstAttempt: existing.firstAttempt };
      this.store.set(cacheKey, newData);
      return { ...newData, wasReset: false };
    } else {
      // Window expired or new key - reset counter
      const newData = { count: 1, firstAttempt: now };
      this.store.set(cacheKey, newData);
      return { ...newData, wasReset: true };
    }
  }

  clear() {
    this.store.clear();
  }
}

describe("RateLimit core", () => {
  const windowMs = 1000;
  const maxAttempts = 2;
  const cache = new InMemoryCache();
  let limiter: RateLimit;
  const originalNow = Date.now;

  beforeEach(() => {
    cache.clear();
    limiter = new RateLimit(cache as any, windowMs, maxAttempts);
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  it("allows requests up to the maxAttempts threshold", async () => {
    Date.now = () => 1000;
    let result = await limiter.check("user:1");
    expect(result.allowed).toBeTrue();
    expect(result.count).toBe(1);
    expect(result.remaining).toBe(1);

    Date.now = () => 1100;
    result = await limiter.check("user:1");
    expect(result.allowed).toBeTrue();
    expect(result.count).toBe(2);
    expect(result.remaining).toBe(0);

    Date.now = () => 1200;
    result = await limiter.check("user:1");
    expect(result.allowed).toBeFalse();
    expect(result.count).toBe(3);
    expect(result.remaining).toBe(0);
  });

  it("resets counters after the window passes", async () => {
    Date.now = () => 0;
    await limiter.check("ip:1");
    await limiter.check("ip:1");

    Date.now = () => windowMs + 100;
    const result = await limiter.check("ip:1");
    expect(result.allowed).toBeTrue();
    expect(result.count).toBe(1);
    expect(result.remaining).toBe(maxAttempts - 1);
  });
});

describe("RateLimiter adapter", () => {
  const cache = new InMemoryCache();

  beforeEach(() => {
    cache.clear();
  });

  function buildRequest(overrides: Partial<Request> = {}): Request {
    const base: Partial<Request> = {
      ip: "203.0.113.10",
      path: "/api/resource/123",
      socket: { remoteAddress: "203.0.113.10" } as any,
      ...overrides,
    };
    return base as Request;
  }

  it("uses ip strategy by default", async () => {
    const limiter = new RateLimiter(cache as any);
    const req = buildRequest();
    await limiter.check(req);
    expect(cache.store.has("rate_limit:203.0.113.10")).toBeTrue();
  });

  it("uses user strategy and falls back to ip", async () => {
    const limiter = new RateLimiter(cache as any, { keyStrategy: "user", window: "30s", maxAttempts: 5 });
    const req = buildRequest();
    await limiter.check(req, "alice");
    expect(cache.store.has("rate_limit:user:alice")).toBeTrue();

    cache.clear();
    await limiter.check(req);
    expect(cache.store.has("rate_limit:ip:203.0.113.10")).toBeTrue();
  });

  it("uses ip-user strategy combining ip and username", async () => {
    const limiter = new RateLimiter(cache as any, { keyStrategy: "ip-user", window: "30s", maxAttempts: 5 });
    const req = buildRequest({ ip: "198.51.100.5", socket: { remoteAddress: "198.51.100.5" } as any });
    await limiter.check(req, "bob");
    expect(cache.store.has("rate_limit:ip:198.51.100.5:user:bob")).toBeTrue();

    cache.clear();
    await limiter.check(req);
    expect(cache.store.has("rate_limit:ip:198.51.100.5")).toBeTrue();
  });

  it("uses ip-endpoint strategy when configured", async () => {
    const limiter = new RateLimiter(cache as any, { keyStrategy: "ip-endpoint", window: "30s", maxAttempts: 5 });
    const req = buildRequest({ path: "/api/items/42" });
    await limiter.check(req);
    expect(cache.store.has("rate_limit:ip:203.0.113.10:endpoint:/api/items/42")).toBeTrue();
  });
});
