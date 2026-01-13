# Cache Service

High-performance key-value store with TTL (time-to-live), LRU eviction, and pattern-based key listing.

## Quick Start

```ts
// Set and get values
await ctx.core.cache.set("user:123", { name: "Alice" }, 60000); // 1 minute TTL
const user = await ctx.core.cache.get("user:123");

// Cache-aside pattern
const data = await ctx.core.cache.getOrSet("expensive:query", async () => {
  return await db.selectFrom("large_table").execute();
}, 300000); // 5 minutes TTL
```

---

## API Reference

### Interface

```ts
interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
  getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T>;
}
```

### Methods

| Method | Description |
|--------|-------------|
| `get(key)` | Retrieve value, returns `null` if not found or expired |
| `set(key, value, ttl?)` | Store value with optional TTL in milliseconds |
| `delete(key)` | Remove key, returns `true` if existed |
| `has(key)` | Check if key exists and is not expired |
| `clear()` | Remove all keys |
| `keys(pattern?)` | List keys matching glob pattern |
| `getOrSet(key, factory, ttl?)` | Get existing or compute and cache |

---

## Configuration

```ts
const server = new AppServer({
  db,
  cache: {
    defaultTtlMs: 300000,  // Default TTL: 5 minutes
    maxSize: 1000,         // Max items before LRU eviction
  },
});
```

---

## Usage Examples

### Basic Operations

```ts
// Store various types
await cache.set("string", "hello");
await cache.set("number", 42);
await cache.set("object", { nested: { data: true } });
await cache.set("array", [1, 2, 3]);

// Retrieve with type
const str = await cache.get<string>("string");
const num = await cache.get<number>("number");
const obj = await cache.get<{ nested: { data: boolean } }>("object");

// Check existence
if (await cache.has("string")) {
  console.log("Key exists");
}

// Delete
const deleted = await cache.delete("string");
console.log(deleted); // true

// Clear all
await cache.clear();
```

### TTL (Time-To-Live)

```ts
// Cache for 1 minute
await cache.set("short-lived", data, 60000);

// Cache for 1 hour
await cache.set("long-lived", data, 3600000);

// Use default TTL (from config)
await cache.set("default-ttl", data);

// No expiration (pass null or 0)
await cache.set("permanent", data, 0);
```

### Cache-Aside Pattern (getOrSet)

The most common caching pattern - return cached value or compute and cache:

```ts
// Database query caching
const users = await ctx.core.cache.getOrSet(
  "users:active",
  async () => {
    return ctx.db
      .selectFrom("users")
      .where("active", "=", true)
      .execute();
  },
  60000 // 1 minute
);

// API response caching
const weather = await ctx.core.cache.getOrSet(
  `weather:${city}`,
  async () => {
    const res = await fetch(`https://api.weather.com/${city}`);
    return res.json();
  },
  300000 // 5 minutes
);

// Computed value caching
const stats = await ctx.core.cache.getOrSet(
  "dashboard:stats",
  async () => ({
    totalUsers: await countUsers(),
    totalOrders: await countOrders(),
    revenue: await calculateRevenue(),
  }),
  60000
);
```

### Key Patterns

List keys using glob patterns:

```ts
// Store user-related data
await cache.set("user:1:profile", { name: "Alice" });
await cache.set("user:1:preferences", { theme: "dark" });
await cache.set("user:2:profile", { name: "Bob" });
await cache.set("session:abc123", { userId: 1 });

// Find all user:1 keys
const user1Keys = await cache.keys("user:1:*");
// ["user:1:profile", "user:1:preferences"]

// Find all profile keys
const profileKeys = await cache.keys("user:*:profile");
// ["user:1:profile", "user:2:profile"]

// Find all keys
const allKeys = await cache.keys();
// ["user:1:profile", "user:1:preferences", "user:2:profile", "session:abc123"]
```

---

## Real-World Examples

### User Session Caching

```ts
// plugins/auth/index.ts
service: async (ctx) => {
  const cache = ctx.core.cache;
  const SESSION_TTL = 3600000; // 1 hour

  return {
    async createSession(userId: number) {
      const sessionId = crypto.randomUUID();
      const session = {
        userId,
        createdAt: new Date().toISOString(),
      };

      await cache.set(`session:${sessionId}`, session, SESSION_TTL);
      return sessionId;
    },

    async getSession(sessionId: string) {
      return cache.get(`session:${sessionId}`);
    },

    async destroySession(sessionId: string) {
      return cache.delete(`session:${sessionId}`);
    },

    async destroyUserSessions(userId: number) {
      const keys = await cache.keys(`session:*`);
      for (const key of keys) {
        const session = await cache.get(key);
        if (session?.userId === userId) {
          await cache.delete(key);
        }
      }
    },
  };
};
```

### Rate Limit State Caching

```ts
async function checkRateLimit(ctx: ServerContext, key: string, limit: number, windowMs: number) {
  const cacheKey = `ratelimit:${key}`;
  const current = await ctx.core.cache.get<number>(cacheKey) ?? 0;

  if (current >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await ctx.core.cache.set(cacheKey, current + 1, windowMs);
  return { allowed: true, remaining: limit - current - 1 };
}
```

### Database Query Caching

```ts
// Cache expensive queries
router.route("dashboard").typed({
  handle: async (input, ctx) => {
    const cacheKey = `dashboard:${ctx.user.id}`;

    return ctx.core.cache.getOrSet(cacheKey, async () => {
      // These queries only run on cache miss
      const [orders, notifications, stats] = await Promise.all([
        ctx.db.selectFrom("orders")
          .where("userId", "=", ctx.user.id)
          .orderBy("createdAt", "desc")
          .limit(10)
          .execute(),

        ctx.db.selectFrom("notifications")
          .where("userId", "=", ctx.user.id)
          .where("read", "=", false)
          .execute(),

        ctx.db.selectFrom("user_stats")
          .where("userId", "=", ctx.user.id)
          .executeTakeFirst(),
      ]);

      return { orders, notifications, stats };
    }, 30000); // 30 seconds
  },
});
```

### Cache Invalidation

```ts
// Invalidate on data changes
service: async (ctx) => ({
  async updateUserProfile(userId: number, data: ProfileUpdate) {
    await ctx.db.updateTable("users")
      .set(data)
      .where("id", "=", userId)
      .execute();

    // Invalidate related caches
    await ctx.core.cache.delete(`user:${userId}:profile`);
    await ctx.core.cache.delete(`dashboard:${userId}`);

    // Invalidate pattern-matched keys
    const userKeys = await ctx.core.cache.keys(`user:${userId}:*`);
    for (const key of userKeys) {
      await ctx.core.cache.delete(key);
    }
  },
});
```

---

## LRU Eviction

When the cache reaches `maxSize`, the least recently used items are evicted:

```ts
// With maxSize: 3
await cache.set("a", 1);  // Cache: [a]
await cache.set("b", 2);  // Cache: [a, b]
await cache.set("c", 3);  // Cache: [a, b, c]

await cache.get("a");     // Access 'a', moves to end: [b, c, a]

await cache.set("d", 4);  // Evicts 'b' (LRU): [c, a, d]
await cache.get("b");     // null - was evicted
```

---

## Custom Adapters

Implement `CacheAdapter` for custom backends:

```ts
interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
}
```

### Redis Adapter Example

```ts
import { createCache, type CacheAdapter } from "./core/cache";
import Redis from "ioredis";

class RedisCacheAdapter implements CacheAdapter {
  constructor(private redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    return value ? JSON.parse(value) : null;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlMs) {
      await this.redis.set(key, serialized, "PX", ttlMs);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.redis.del(key);
    return result > 0;
  }

  async has(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }

  async clear(): Promise<void> {
    await this.redis.flushdb();
  }

  async keys(pattern?: string): Promise<string[]> {
    return this.redis.keys(pattern ?? "*");
  }
}

// Use Redis adapter
const cache = createCache({
  adapter: new RedisCacheAdapter(new Redis()),
});
```

---

## Best Practices

### 1. Use Meaningful Key Prefixes

```ts
// Good - organized and predictable
await cache.set("user:123:profile", data);
await cache.set("user:123:settings", data);
await cache.set("session:abc123", data);
await cache.set("api:weather:seattle", data);

// Bad - inconsistent and hard to manage
await cache.set("u123", data);
await cache.set("profile_123", data);
```

### 2. Set Appropriate TTLs

```ts
// Frequently changing data - short TTL
await cache.set("stock:price", price, 5000); // 5 seconds

// Session data - medium TTL
await cache.set("session:abc", session, 3600000); // 1 hour

// Static reference data - long TTL
await cache.set("countries:list", countries, 86400000); // 24 hours
```

### 3. Handle Cache Misses Gracefully

```ts
const user = await cache.get("user:123");
if (!user) {
  // Fetch from database
  const dbUser = await db.selectFrom("users").where("id", "=", 123).executeTakeFirst();
  if (dbUser) {
    await cache.set("user:123", dbUser);
  }
  return dbUser;
}
return user;

// Or use getOrSet for cleaner code
const user = await cache.getOrSet("user:123", () =>
  db.selectFrom("users").where("id", "=", 123).executeTakeFirst()
);
```

### 4. Invalidate Proactively

```ts
// When updating data, invalidate related caches
async function updateUser(id: number, data: UserUpdate) {
  await db.updateTable("users").set(data).where("id", "=", id).execute();

  // Invalidate all related caches
  await Promise.all([
    cache.delete(`user:${id}:profile`),
    cache.delete(`user:${id}:settings`),
    cache.delete(`dashboard:${id}`),
  ]);
}
```
