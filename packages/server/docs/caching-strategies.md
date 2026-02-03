# Advanced Caching Strategies

Advanced patterns for distributed systems, high-load scenarios, and cache consistency.

## Table of Contents

- [Caching Patterns](#caching-patterns)
- [Cache Stampede Prevention](#cache-stampede-prevention)
- [Distributed Cache Coordination](#distributed-cache-coordination)
- [Cache Warming](#cache-warming)
- [Cache Versioning](#cache-versioning)
- [Monitoring & Metrics](#monitoring--metrics)
- [Multi-Layer Caching](#multi-layer-caching)

---

## Caching Patterns

### 1. Cache-Aside (Lazy Loading)

Most common pattern - application manages cache.

```ts
// Application checks cache first
async function getUser(id: string) {
  const cacheKey = `user:${id}`;
  
  // 1. Check cache
  let user = await cache.get(cacheKey);
  if (user) return user;
  
  // 2. Cache miss - load from DB
  user = await db.selectFrom("users")
    .where("id", "=", id)
    .executeTakeFirst();
  
  // 3. Store in cache
  if (user) {
    await cache.set(cacheKey, user, 60000);
  }
  
  return user;
}
```

**Pros:** Simple, flexible
**Cons:** Cache misses are expensive

### 2. Read-Through

Cache automatically loads from source on miss.

```ts
class ReadThroughCache {
  constructor(
    private cache: Cache,
    private loader: (key: string) => Promise<any>
  ) {}
  
  async get(key: string) {
    let value = await this.cache.get(key);
    
    if (!value) {
      value = await this.loader(key);
      await this.cache.set(key, value);
    }
    
    return value;
  }
}

// Usage
const userCache = new ReadThroughCache(
  cache,
  async (key) => {
    const id = key.replace("user:", "");
    return db.selectFrom("users").where("id", "=", id).executeTakeFirst();
  }
);
```

**Pros:** Consistent loading logic
**Cons:** Less control over loading

### 3. Write-Through

Data written to cache and DB simultaneously.

```ts
class WriteThroughCache {
  async set(key: string, value: any, ttl?: number) {
    // Write to both
    await Promise.all([
      this.db.set(key, value),
      this.cache.set(key, value, ttl),
    ]);
  }
  
  async delete(key: string) {
    await Promise.all([
      this.db.delete(key),
      this.cache.delete(key),
    ]);
  }
}
```

**Pros:** Strong consistency, no stale data
**Cons:** Slower writes

### 4. Write-Behind (Write-Back)

Write to cache immediately, async write to DB.

```ts
class WriteBehindCache {
  private pendingWrites = new Map<string, any>();
  
  async set(key: string, value: any) {
    // 1. Write to cache immediately
    await this.cache.set(key, value);
    
    // 2. Queue for async DB write
    this.pendingWrites.set(key, value);
    this.scheduleFlush();
  }
  
  private flushTimer: Timer | null = null;
  
  private scheduleFlush() {
    if (this.flushTimer) return;
    
    this.flushTimer = setTimeout(async () => {
      const batch = new Map(this.pendingWrites);
      this.pendingWrites.clear();
      
      // Batch write to DB
      await this.db.batchSet(batch);
      
      this.flushTimer = null;
    }, 1000); // Flush every second
  }
}
```

**Pros:** Fast writes, batch DB operations
**Cons:** Risk of data loss, eventual consistency

### 5. Refresh-Ahead

Proactively refresh cache before expiration.

```ts
class RefreshAheadCache {
  async get(key: string, loader: () => Promise<any>, ttl: number) {
    const entry = await this.cache.getWithMetadata(key);
    
    if (!entry) {
      // Cache miss - load and cache
      const value = await loader();
      await this.cache.set(key, value, ttl);
      return value;
    }
    
    // Check if nearing expiration (e.g., < 20% of TTL remaining)
    const remainingRatio = entry.ttlRemaining / ttl;
    if (remainingRatio < 0.2) {
      // Refresh in background
      this.refreshAsync(key, loader, ttl);
    }
    
    return entry.value;
  }
  
  private async refreshAsync(key: string, loader: () => Promise<any>, ttl: number) {
    try {
      const value = await loader();
      await this.cache.set(key, value, ttl);
    } catch (err) {
      console.error("Refresh failed:", err);
    }
  }
}
```

**Pros:** No stale cache hits
**Cons:** Extra load on refresh

---

## Cache Stampede Prevention

When cache expires, multiple requests hit the DB simultaneously.

### Problem

```
T0: Cache expires
T1: Request A - cache miss, queries DB (5s)
T2: Request B - cache miss, queries DB (5s)
T3: Request C - cache miss, queries DB (5s)
...
Result: 100s of DB queries for same data
```

### Solutions

#### 1. Lock/Lease Pattern

Only one request regenerates cache.

```ts
class StampedeProtectedCache {
  private locks = new Map<string, Promise<any>>();
  
  async getOrSet(key: string, factory: () => Promise<any>, ttl: number) {
    // Check cache first
    const cached = await this.cache.get(key);
    if (cached) return cached;
    
    // Check if another request is already generating
    let lock = this.locks.get(key);
    
    if (!lock) {
      // We're the first - create lock
      lock = this.generateAndCache(key, factory, ttl);
      this.locks.set(key, lock);
    }
    
    try {
      return await lock;
    } finally {
      // Clean up lock
      this.locks.delete(key);
    }
  }
  
  private async generateAndCache(key: string, factory: () => Promise<any>, ttl: number) {
    const value = await factory();
    await this.cache.set(key, value, ttl);
    return value;
  }
}
```

#### 2. Early Expiration (Probabilistic)

Expire cache early for some requests to spread load.

```ts
class ProbabilisticEarlyExpiration {
  async get(key: string, loader: () => Promise<any>, ttl: number) {
    const entry = await this.cache.getWithMetadata(key);
    
    if (!entry) {
      return this.loadAndCache(key, loader, ttl);
    }
    
    // Calculate probability of early expiration
    const age = Date.now() - entry.createdAt;
    const ttlRemaining = ttl - age;
    
    // Higher probability as we near expiration
    // At 80% of TTL, 50% chance to refresh
    const refreshProbability = Math.max(0, (age / ttl - 0.5) * 2);
    
    if (Math.random() < refreshProbability) {
      // Refresh in background
      this.refreshAsync(key, loader, ttl);
    }
    
    return entry.value;
  }
}
```

#### 3. Circuit Breaker + Fallback

Use stale cache while refreshing.

```ts
class CircuitBreakerCache {
  async getWithStaleFallback(key: string, loader: () => Promise<any>, ttl: number) {
    const entry = await this.cache.getWithMetadata(key);
    
    if (!entry) {
      // Complete miss
      return this.loadAndCache(key, loader, ttl);
    }
    
    const age = Date.now() - entry.createdAt;
    const isExpired = age > ttl;
    
    if (!isExpired) {
      return entry.value; // Fresh cache
    }
    
    // Stale - return immediately but refresh
    this.refreshAsync(key, loader, ttl).catch(console.error);
    return entry.value;
  }
}
```

---

## Distributed Cache Coordination

For multi-instance deployments.

### 1. Cache Invalidation Broadcast

When one instance updates, notify others.

```ts
class DistributedCache {
  constructor(
    private localCache: Cache,
    private eventBus: EventBus
  ) {
    // Listen for invalidation events
    this.eventBus.on("cache:invalidate", ({ keys }) => {
      for (const key of keys) {
        this.localCache.delete(key);
      }
    });
  }
  
  async set(key: string, value: any, ttl?: number) {
    await this.localCache.set(key, value, ttl);
  }
  
  async delete(key: string) {
    await this.localCache.delete(key);
    // Broadcast to other instances
    this.eventBus.emit("cache:invalidate", { keys: [key] });
  }
  
  async deletePattern(pattern: string) {
    const keys = await this.localCache.keys(pattern);
    for (const key of keys) {
      await this.localCache.delete(key);
    }
    // Broadcast
    this.eventBus.emit("cache:invalidate", { keys });
  }
}
```

### 2. Hash-Based Sharding

Distribute keys across cache instances.

```ts
class ShardedCache {
  private shards: Cache[];
  
  constructor(shards: Cache[]) {
    this.shards = shards;
  }
  
  private getShard(key: string): Cache {
    const hash = this.hashKey(key);
    const index = hash % this.shards.length;
    return this.shards[index];
  }
  
  private hashKey(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }
  
  async get(key: string) {
    return this.getShard(key).get(key);
  }
  
  async set(key: string, value: any, ttl?: number) {
    return this.getShard(key).set(key, value, ttl);
  }
}
```

---

## Cache Warming

Pre-populate cache before high-traffic events.

### 1. Scheduled Warming

```ts
class CacheWarmer {
  constructor(private cache: Cache, private ctx: PluginContext) {
    // Warm cache every hour
    ctx.core.cron.schedule("0 * * * *", () => this.warmCache());
  }
  
  async warmCache() {
    console.log("Warming cache...");
    
    // Warm popular users
    const popularUsers = await this.ctx.db
      .selectFrom("users")
      .orderBy("lastLogin", "desc")
      .limit(100)
      .selectAll()
      .execute();
    
    for (const user of popularUsers) {
      await this.cache.set(`user:${user.id}`, user, 3600000);
    }
    
    // Warm reference data
    const countries = await this.ctx.db
      .selectFrom("countries")
      .selectAll()
      .execute();
    
    await this.cache.set("countries:list", countries, 86400000);
    
    console.log(`Warmed ${popularUsers.length} users, ${countries.length} countries`);
  }
}
```

### 2. Event-Driven Warming

```ts
// Warm cache when new data is likely to be accessed
ctx.core.events.on("user.registered", async ({ userId }) => {
  // Pre-welcome email content
  const welcomeContent = await generateWelcomeEmail();
  await cache.set(`email:welcome:${userId}`, welcomeContent, 300000);
});

ctx.core.events.on("order.created", async ({ orderId, userId }) => {
  // Pre-load order for confirmation page
  const order = await ctx.plugins.orders.getById(orderId);
  await cache.set(`order:${orderId}`, order, 300000);
  await cache.set(`user:${userId}:latestOrder`, order, 300000);
});
```

### 3. Predictive Warming

```ts
class PredictiveCacheWarmer {
  async warmBasedOnTrafficPatterns() {
    const hour = new Date().getHours();
    
    // Morning - warm dashboard data
    if (hour === 8) {
      await this.warmDashboardData();
    }
    
    // Lunch - warm social feeds
    if (hour === 12) {
      await this.warmSocialFeeds();
    }
    
    // Evening - warm entertainment content
    if (hour === 19) {
      await this.warmEntertainmentContent();
    }
  }
}
```

---

## Cache Versioning

Handle schema changes gracefully.

### Versioned Keys

```ts
const CACHE_VERSION = "v2"; // Bump when schema changes

function getCacheKey(baseKey: string): string {
  return `${CACHE_VERSION}:${baseKey}`;
}

// Usage
await cache.set(getCacheKey("user:123"), userData);
const user = await cache.get(getCacheKey("user:123"));
```

### Schema Migration

```ts
class CacheVersionManager {
  private currentVersion = 2;
  
  async migrateIfNeeded() {
    const cachedVersion = await cache.get("cache:version");
    
    if (cachedVersion !== this.currentVersion) {
      console.log(`Migrating cache from ${cachedVersion} to ${currentVersion}`);
      
      // Clear old versioned keys
      await this.clearOldVersions();
      
      // Set new version
      await cache.set("cache:version", this.currentVersion);
    }
  }
  
  private async clearOldVersions() {
    // Clear all v1: keys when upgrading to v2
    const oldKeys = await cache.keys("v1:*");
    for (const key of oldKeys) {
      await cache.delete(key);
    }
  }
}
```

---

## Monitoring & Metrics

Track cache effectiveness.

### Cache Stats

```ts
class MonitoredCache {
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  
  async get(key: string) {
    const value = await this.cache.get(key);
    
    if (value) {
      this.hits++;
      this.recordMetric("cache.hit", key);
    } else {
      this.misses++;
      this.recordMetric("cache.miss", key);
    }
    
    return value;
  }
  
  getStats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      evictions: this.evictions,
      size: this.cache.size(),
    };
  }
  
  private recordMetric(type: string, key: string) {
    // Send to monitoring (e.g., DataDog, Prometheus)
    ctx.core.events.emit("metric", {
      name: `cache.${type}`,
      tags: { key: this.sanitizeKey(key) },
      value: 1,
    });
  }
}
```

### Health Checks

```ts
// In your health check endpoint
router.route("health").typed({
  handle: async (_, ctx) => {
    const cacheStats = ctx.core.cache.getStats?.() || {};
    
    return {
      status: "healthy",
      cache: {
        hitRate: cacheStats.hitRate,
        size: cacheStats.size,
        evictions: cacheStats.evictions,
      },
    };
  },
});
```

---

## Multi-Layer Caching

Combine multiple cache layers.

### L1 (In-Memory) → L2 (Redis) → L3 (DB)

```ts
class MultiLayerCache {
  constructor(
    private l1Cache: Cache,    // In-process, ultra-fast
    private l2Cache: Cache,    // Redis, shared
    private loader: (key: string) => Promise<any>
  ) {}
  
  async get(key: string) {
    // 1. Try L1 (local)
    const l1Value = await this.l1Cache.get(key);
    if (l1Value) return l1Value;
    
    // 2. Try L2 (distributed)
    const l2Value = await this.l2Cache.get(key);
    if (l2Value) {
      // Populate L1 for next time
      await this.l1Cache.set(key, l2Value);
      return l2Value;
    }
    
    // 3. Load from source
    const value = await this.loader(key);
    
    // 4. Populate both caches
    await Promise.all([
      this.l1Cache.set(key, value, 60000),     // 1 min in L1
      this.l2Cache.set(key, value, 300000),    // 5 min in L2
    ]);
    
    return value;
  }
  
  async delete(key: string) {
    // Invalidate all layers
    await Promise.all([
      this.l1Cache.delete(key),
      this.l2Cache.delete(key),
    ]);
  }
}
```

### Layer Characteristics

| Layer | Speed | Scope | TTL | Use Case |
|-------|-------|-------|-----|----------|
| L1 (In-Memory) | ~1μs | Instance | Short (1-5 min) | Hot data, request-scoped |
| L2 (Redis) | ~1ms | Cluster | Medium (5-60 min) | Shared data, sessions |
| L3 (DB) | ~10ms | Persistent | Permanent | Source of truth |

---

## Best Practices Summary

1. **Choose the right pattern** for your consistency needs
2. **Prevent stampedes** with locking or early expiration
3. **Warm caches** proactively for predictable traffic
4. **Version your keys** to handle schema migrations
5. **Monitor hit rates** and adjust TTLs
6. **Use multi-layer** for high-scale applications
7. **Invalidate proactively** on data changes
8. **Use meaningful key prefixes** for organization

---

## Implementation Checklist

- [ ] Identify hot data and appropriate TTLs
- [ ] Implement stampede protection for high-traffic keys
- [ ] Set up cache warming for predictable patterns
- [ ] Add cache versioning strategy
- [ ] Monitor hit/miss rates
- [ ] Document cache key patterns for your domain
- [ ] Plan cache invalidation strategy
- [ ] Consider multi-layer for scale
