// Redis Cache Adapter
// Production-ready cache backend using Redis (via ioredis)

import type { CacheAdapter } from "./cache";

export interface RedisCacheAdapterConfig {
  /** Key prefix for namespace isolation in shared Redis instances */
  prefix?: string;
}

/**
 * Redis-backed cache adapter using ioredis.
 *
 * Constructor takes a pre-built ioredis client (typed as `any` to avoid
 * requiring ioredis types at compile time — same pattern as S3StorageAdapter).
 * User manages connection lifecycle (connect/disconnect in onShutdown).
 *
 * @example
 * ```ts
 * import Redis from "ioredis";
 * import { RedisCacheAdapter } from "@donkeylabs/server/core";
 *
 * const redis = new Redis("redis://localhost:6379");
 * const server = new AppServer({
 *   cache: { adapter: new RedisCacheAdapter(redis, { prefix: "myapp:" }) },
 * });
 * ```
 */
export class RedisCacheAdapter implements CacheAdapter {
  private redis: any;
  private prefix: string;

  constructor(redis: any, config: RedisCacheAdapterConfig = {}) {
    this.redis = redis;
    this.prefix = config.prefix ?? "";
  }

  private prefixKey(key: string): string {
    return this.prefix + key;
  }

  private stripPrefix(key: string): string {
    if (this.prefix && key.startsWith(this.prefix)) {
      return key.slice(this.prefix.length);
    }
    return key;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(this.prefixKey(key));
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(this.prefixKey(key), serialized, "PX", ttlMs);
    } else {
      await this.redis.set(this.prefixKey(key), serialized);
    }
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.redis.del(this.prefixKey(key));
    return result > 0;
  }

  async has(key: string): Promise<boolean> {
    return (await this.redis.exists(this.prefixKey(key))) === 1;
  }

  async clear(): Promise<void> {
    if (this.prefix) {
      // With prefix: SCAN + DEL only prefixed keys (production-safe)
      const keys = await this.scanKeys(this.prefix + "*");
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } else {
      await this.redis.flushdb();
    }
  }

  async keys(pattern?: string): Promise<string[]> {
    const redisPattern = this.prefix + (pattern ?? "*");
    const keys = await this.scanKeys(redisPattern);
    return keys.map((k: string) => this.stripPrefix(k));
  }

  /**
   * Uses SCAN (not KEYS) for production safety on large datasets.
   * Iterates cursor until exhausted.
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    const results: string[] = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      results.push(...keys);
    } while (cursor !== "0");

    return results;
  }
}
