import { describe, test, expect, beforeEach } from "bun:test";
import { RedisCacheAdapter } from "../src/core/cache-adapter-redis";

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

    async get(key: string): Promise<string | null> {
      if (isExpired(key)) return null;
      return store.get(key)?.value ?? null;
    },

    async set(key: string, value: string, mode?: string, px?: number): Promise<void> {
      const expiresAt = mode === "PX" && px ? Date.now() + px : null;
      store.set(key, { value, expiresAt });
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

    async exists(key: string): Promise<number> {
      if (isExpired(key)) return 0;
      return store.has(key) ? 1 : 0;
    },

    async flushdb(): Promise<void> {
      store.clear();
    },

    async scan(cursor: string, _match: string, pattern: string, _count: string, _countVal: number): Promise<[string, string[]]> {
      // Simple mock: return all matching keys in one pass
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
      const matched: string[] = [];
      for (const key of store.keys()) {
        if (!isExpired(key) && regex.test(key)) {
          matched.push(key);
        }
      }
      return ["0", matched];
    },
  };
}

// --- Tests ---

describe("RedisCacheAdapter", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let adapter: RedisCacheAdapter;

  beforeEach(() => {
    redis = createMockRedis();
    adapter = new RedisCacheAdapter(redis);
  });

  describe("get/set", () => {
    test("returns null for missing key", async () => {
      expect(await adapter.get("missing")).toBeNull();
    });

    test("stores and retrieves a string", async () => {
      await adapter.set("key", "hello");
      expect(await adapter.get("key")).toBe("hello");
    });

    test("stores and retrieves an object", async () => {
      const obj = { name: "Alice", age: 30 };
      await adapter.set("user", obj);
      expect(await adapter.get("user")).toEqual(obj);
    });

    test("stores and retrieves an array", async () => {
      await adapter.set("arr", [1, 2, 3]);
      expect(await adapter.get("arr")).toEqual([1, 2, 3]);
    });

    test("stores a number", async () => {
      await adapter.set("num", 42);
      expect(await adapter.get("num")).toBe(42);
    });

    test("stores a boolean", async () => {
      await adapter.set("flag", true);
      expect(await adapter.get("flag")).toBe(true);
    });

    test("overwrites existing key", async () => {
      await adapter.set("key", "old");
      await adapter.set("key", "new");
      expect(await adapter.get("key")).toBe("new");
    });
  });

  describe("TTL", () => {
    test("set with TTL passes PX to redis", async () => {
      await adapter.set("key", "val", 5000);
      // Key should exist in the store with an expiry
      const entry = redis._store.get("key");
      expect(entry).toBeDefined();
      expect(entry!.expiresAt).not.toBeNull();
    });

    test("set without TTL has no expiry", async () => {
      await adapter.set("key", "val");
      const entry = redis._store.get("key");
      expect(entry!.expiresAt).toBeNull();
    });

    test("set with TTL=0 has no expiry", async () => {
      await adapter.set("key", "val", 0);
      const entry = redis._store.get("key");
      expect(entry!.expiresAt).toBeNull();
    });
  });

  describe("delete", () => {
    test("returns true when key existed", async () => {
      await adapter.set("key", "val");
      expect(await adapter.delete("key")).toBe(true);
    });

    test("returns false when key did not exist", async () => {
      expect(await adapter.delete("missing")).toBe(false);
    });

    test("key is gone after delete", async () => {
      await adapter.set("key", "val");
      await adapter.delete("key");
      expect(await adapter.get("key")).toBeNull();
    });
  });

  describe("has", () => {
    test("returns true when key exists", async () => {
      await adapter.set("key", "val");
      expect(await adapter.has("key")).toBe(true);
    });

    test("returns false when key does not exist", async () => {
      expect(await adapter.has("missing")).toBe(false);
    });
  });

  describe("clear", () => {
    test("without prefix calls flushdb", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      await adapter.clear();
      expect(await adapter.get("a")).toBeNull();
      expect(await adapter.get("b")).toBeNull();
    });

    test("with prefix only deletes prefixed keys", async () => {
      const prefixedAdapter = new RedisCacheAdapter(redis, { prefix: "app:" });

      // Set keys through the prefixed adapter
      await prefixedAdapter.set("a", 1);
      await prefixedAdapter.set("b", 2);

      // Set a key directly without the prefix
      await redis.set("other", JSON.stringify("should remain"));

      await prefixedAdapter.clear();

      // Prefixed keys should be gone
      expect(await prefixedAdapter.get("a")).toBeNull();
      expect(await prefixedAdapter.get("b")).toBeNull();

      // Non-prefixed key should remain
      expect(await redis.get("other")).toBe(JSON.stringify("should remain"));
    });
  });

  describe("keys", () => {
    test("returns all keys when no pattern", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      const keys = await adapter.keys();
      expect(keys.sort()).toEqual(["a", "b"]);
    });

    test("returns keys matching pattern", async () => {
      await adapter.set("user:1", "Alice");
      await adapter.set("user:2", "Bob");
      await adapter.set("session:abc", "data");
      const keys = await adapter.keys("user:*");
      expect(keys.sort()).toEqual(["user:1", "user:2"]);
    });

    test("returns empty array when nothing matches", async () => {
      await adapter.set("a", 1);
      const keys = await adapter.keys("zzz:*");
      expect(keys).toEqual([]);
    });
  });

  describe("prefix", () => {
    let prefixed: RedisCacheAdapter;

    beforeEach(() => {
      prefixed = new RedisCacheAdapter(redis, { prefix: "myapp:" });
    });

    test("get/set use prefixed keys in Redis", async () => {
      await prefixed.set("key", "val");
      // The actual Redis key should be prefixed
      expect(await redis.get("myapp:key")).toBe(JSON.stringify("val"));
      // But the adapter returns unprefixed keys
      expect(await prefixed.get("key")).toBe("val");
    });

    test("has checks prefixed key", async () => {
      await prefixed.set("key", "val");
      expect(await prefixed.has("key")).toBe(true);
      expect(await prefixed.has("other")).toBe(false);
    });

    test("delete uses prefixed key", async () => {
      await prefixed.set("key", "val");
      expect(await prefixed.delete("key")).toBe(true);
      expect(await redis.get("myapp:key")).toBeNull();
    });

    test("keys returns unprefixed keys", async () => {
      await prefixed.set("a", 1);
      await prefixed.set("b", 2);
      const keys = await prefixed.keys();
      expect(keys.sort()).toEqual(["a", "b"]);
    });

    test("keys with pattern applies prefix then strips it", async () => {
      await prefixed.set("user:1", "Alice");
      await prefixed.set("user:2", "Bob");
      await prefixed.set("session:x", "data");
      const keys = await prefixed.keys("user:*");
      expect(keys.sort()).toEqual(["user:1", "user:2"]);
    });
  });
});
