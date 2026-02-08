// Redis Rate Limit Adapter
// Production-ready rate limiting backend using Redis (via ioredis)

import type { RateLimitAdapter } from "./rate-limiter";

export interface RedisRateLimitAdapterConfig {
  /** Key prefix for namespace isolation in shared Redis instances */
  prefix?: string;
}

/**
 * Redis-backed rate limit adapter using ioredis.
 *
 * Uses a Lua script for atomic INCR + conditional PEXPIRE to prevent
 * race conditions where a key is incremented but the expire fails.
 *
 * Constructor takes a pre-built ioredis client (typed as `any` to avoid
 * requiring ioredis types at compile time — same pattern as S3StorageAdapter).
 * User manages connection lifecycle (connect/disconnect in onShutdown).
 *
 * @example
 * ```ts
 * import Redis from "ioredis";
 * import { RedisRateLimitAdapter } from "@donkeylabs/server/core";
 *
 * const redis = new Redis("redis://localhost:6379");
 * const server = new AppServer({
 *   rateLimiter: { adapter: new RedisRateLimitAdapter(redis, { prefix: "myapp:" }) },
 * });
 * ```
 */
export class RedisRateLimitAdapter implements RateLimitAdapter {
  private redis: any;
  private prefix: string;

  /**
   * Lua script for atomic increment + conditional expire.
   * KEYS[1] = rate limit key
   * ARGV[1] = window TTL in milliseconds
   *
   * Returns [count, ttl_remaining_ms]:
   * - count: current count after increment
   * - ttl_remaining_ms: remaining TTL in milliseconds
   */
  private static readonly INCREMENT_SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    local ttl = redis.call('PTTL', KEYS[1])
    return {count, ttl}
  `;

  constructor(redis: any, config: RedisRateLimitAdapterConfig = {}) {
    this.redis = redis;
    this.prefix = config.prefix ?? "";
  }

  private prefixKey(key: string): string {
    return this.prefix + key;
  }

  async increment(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAt: Date }> {
    const prefixed = this.prefixKey(key);
    const [count, ttl] = await this.redis.eval(
      RedisRateLimitAdapter.INCREMENT_SCRIPT,
      1,
      prefixed,
      windowMs,
    );

    // ttl is remaining time in ms; derive resetAt from it
    const resetAt = new Date(Date.now() + Math.max(ttl, 0));
    return { count, resetAt };
  }

  async get(key: string): Promise<{ count: number; resetAt: Date } | null> {
    const prefixed = this.prefixKey(key);

    // Pipeline GET + PTTL in a single round-trip
    const pipeline = this.redis.pipeline();
    pipeline.get(prefixed);
    pipeline.pttl(prefixed);
    const results = await pipeline.exec();

    const [getErr, rawCount] = results[0];
    const [pttlErr, ttl] = results[1];

    if (getErr || pttlErr) {
      throw getErr || pttlErr;
    }

    if (rawCount === null) return null;

    const count = parseInt(rawCount, 10);
    if (isNaN(count)) return null;

    // PTTL returns -2 if key doesn't exist, -1 if no expiry
    const resetAt = new Date(Date.now() + Math.max(ttl, 0));
    return { count, resetAt };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.prefixKey(key));
  }
}
