import { describe, test, expect, beforeEach } from "bun:test";
import { RedisRateLimitAdapter } from "../src/core/rate-limit-adapter-redis";

// --- Mock Redis client ---

function createMockRedis() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  function isExpired(key: string): boolean {
    const entry = store.get(key);
    if (!entry) return true;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      store.delete(key);
      return true;
    }
    return false;
  }

  return {
    _store: store,

    async eval(
      _script: string,
      _numKeys: number,
      key: string,
      windowMs: number,
    ): Promise<[number, number]> {
      // Simulate the Lua script: INCR + conditional PEXPIRE + PTTL
      const now = Date.now();

      if (isExpired(key)) {
        // Key doesn't exist or expired — create fresh
        const expiresAt = now + windowMs;
        store.set(key, { value: "1", expiresAt });
        return [1, windowMs];
      }

      // Key exists — increment
      const entry = store.get(key)!;
      const newCount = parseInt(entry.value, 10) + 1;
      entry.value = String(newCount);

      const ttl = Math.max(entry.expiresAt! - now, 0);
      return [newCount, ttl];
    },

    pipeline() {
      const commands: Array<() => Promise<[Error | null, any]>> = [];

      const pipelineObj = {
        get(key: string) {
          commands.push(async () => {
            if (isExpired(key)) return [null, null];
            const entry = store.get(key);
            return [null, entry?.value ?? null];
          });
          return pipelineObj;
        },

        pttl(key: string) {
          commands.push(async () => {
            if (isExpired(key)) return [null, -2];
            const entry = store.get(key);
            if (!entry) return [null, -2];
            if (entry.expiresAt === null) return [null, -1];
            const ttl = Math.max(entry.expiresAt - Date.now(), 0);
            return [null, ttl];
          });
          return pipelineObj;
        },

        async exec(): Promise<Array<[Error | null, any]>> {
          const results: Array<[Error | null, any]> = [];
          for (const cmd of commands) {
            results.push(await cmd());
          }
          return results;
        },
      };

      return pipelineObj;
    },

    async del(...keys: string[]): Promise<number> {
      let count = 0;
      for (const key of keys) {
        if (store.has(key)) {
          store.delete(key);
          count++;
        }
      }
      return count;
    },
  };
}

// --- Tests ---

describe("RedisRateLimitAdapter", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let adapter: RedisRateLimitAdapter;

  beforeEach(() => {
    redis = createMockRedis();
    adapter = new RedisRateLimitAdapter(redis);
  });

  describe("increment", () => {
    test("first call returns count 1", async () => {
      const result = await adapter.increment("key", 60000);
      expect(result.count).toBe(1);
      expect(result.resetAt).toBeInstanceOf(Date);
      expect(result.resetAt.getTime()).toBeGreaterThan(Date.now());
    });

    test("subsequent calls increment the count", async () => {
      await adapter.increment("key", 60000);
      const result = await adapter.increment("key", 60000);
      expect(result.count).toBe(2);
    });

    test("multiple increments accumulate", async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.increment("key", 60000);
      }
      const result = await adapter.increment("key", 60000);
      expect(result.count).toBe(6);
    });

    test("different keys are independent", async () => {
      await adapter.increment("a", 60000);
      await adapter.increment("a", 60000);
      const resultA = await adapter.increment("a", 60000);
      const resultB = await adapter.increment("b", 60000);

      expect(resultA.count).toBe(3);
      expect(resultB.count).toBe(1);
    });

    test("resetAt is in the future", async () => {
      const before = Date.now();
      const result = await adapter.increment("key", 60000);
      expect(result.resetAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.resetAt.getTime()).toBeLessThanOrEqual(before + 60000 + 100);
    });
  });

  describe("get", () => {
    test("returns null for non-existent key", async () => {
      expect(await adapter.get("missing")).toBeNull();
    });

    test("returns current count and resetAt after increments", async () => {
      await adapter.increment("key", 60000);
      await adapter.increment("key", 60000);

      const result = await adapter.get("key");
      expect(result).not.toBeNull();
      expect(result!.count).toBe(2);
      expect(result!.resetAt).toBeInstanceOf(Date);
    });

    test("returns count 1 after single increment", async () => {
      await adapter.increment("key", 60000);
      const result = await adapter.get("key");
      expect(result!.count).toBe(1);
    });
  });

  describe("reset", () => {
    test("removes the key", async () => {
      await adapter.increment("key", 60000);
      await adapter.reset("key");
      expect(await adapter.get("key")).toBeNull();
    });

    test("reset on non-existent key is a no-op", async () => {
      // Should not throw
      await adapter.reset("missing");
    });

    test("after reset, increment starts fresh", async () => {
      await adapter.increment("key", 60000);
      await adapter.increment("key", 60000);
      await adapter.reset("key");

      const result = await adapter.increment("key", 60000);
      expect(result.count).toBe(1);
    });
  });

  describe("prefix", () => {
    let prefixed: RedisRateLimitAdapter;

    beforeEach(() => {
      prefixed = new RedisRateLimitAdapter(redis, { prefix: "rl:" });
    });

    test("increment uses prefixed key in Redis", async () => {
      await prefixed.increment("api:ip", 60000);
      // The actual Redis key should be prefixed
      expect(redis._store.has("rl:api:ip")).toBe(true);
      expect(redis._store.has("api:ip")).toBe(false);
    });

    test("get uses prefixed key", async () => {
      await prefixed.increment("key", 60000);
      const result = await prefixed.get("key");
      expect(result).not.toBeNull();
      expect(result!.count).toBe(1);
    });

    test("reset uses prefixed key", async () => {
      await prefixed.increment("key", 60000);
      await prefixed.reset("key");
      expect(redis._store.has("rl:key")).toBe(false);
    });

    test("prefixed and non-prefixed adapters are isolated", async () => {
      const plain = new RedisRateLimitAdapter(redis);

      await prefixed.increment("key", 60000);
      await prefixed.increment("key", 60000);

      await plain.increment("key", 60000);

      const prefixedResult = await prefixed.get("key");
      const plainResult = await plain.get("key");

      expect(prefixedResult!.count).toBe(2);
      expect(plainResult!.count).toBe(1);
    });
  });
});
