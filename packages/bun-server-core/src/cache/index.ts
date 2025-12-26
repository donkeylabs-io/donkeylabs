import crypto from "crypto";
import { fileURLToPath } from "url";
import { Kysely, Migrator } from "kysely";
import superjson from "superjson";
import { buildDB, buildMigrator } from "../db";
import { logger } from "@donkeylabs/audit-logs";

export type CacheConfig = {
  dbFile: string | undefined;
};

export class SimpleCache {
  private db: Kysely<any>;
  private migrator: Migrator;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: CacheConfig) {
    this.db = buildDB(config.dbFile);
    const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
    this.migrator = buildMigrator(this.db, migrationsDir);
  }

  private async initialize() {
    await this.migrator.migrateToLatest();
    this.startCleanupTimer();
  }

  private async initializeWithoutCleanup() {
    await this.migrator.migrateToLatest();
  }

  static async newSimpleInstance(config: CacheConfig): Promise<SimpleCache> {
    const cache = new SimpleCache(config);
    await cache.initializeWithoutCleanup();
    return cache;
  }

  static newSyncInstance(config: CacheConfig): SimpleCache {
    const cache = new SimpleCache(config);
    void cache.initialize();
    return cache;
  }

  static newAsyncInstance(config: CacheConfig) {
    return Promise.resolve(new SimpleCache(config));
  }

  private startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      SimpleCache.deleteExpiredData(this.db).catch((error) => {
        logger.cache.error("Failed to delete expired data", error);
      });
    }, 1000 * 60 * 10);
  }

  /**
   * Dispose of the cache instance, clearing cleanup timer and closing DB connection.
   * Call this when shutting down to prevent memory leaks.
   */
  async destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    await this.db.destroy();
  }

  async set(key: string, value: unknown, ttl: number) {
    const expireTime = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    const serializedValue = superjson.stringify(value);

    // Use atomic upsert - INSERT OR REPLACE based on unique key index
    await this.db
      .insertInto("cache")
      .values({
        id: crypto.randomUUID(),
        key,
        value: serializedValue,
        ttl: expireTime,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          value: serializedValue,
          ttl: expireTime,
        }),
      )
      .execute();
  }

  /**
   * Atomic rate limit increment operation.
   * Returns the updated count and whether the window was reset.
   * Uses a transaction with exclusive locking to prevent race conditions.
   */
  async atomicRateLimitIncrement(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; firstAttempt: number; wasReset: boolean }> {
    const cacheKey = `rate_limit:${key}`;

    // Use a transaction with immediate lock to ensure atomicity
    return await this.db.transaction().execute(async (trx) => {
      const now = Date.now();
      const ttlMs = now + windowMs;

      // Get existing data within transaction
      const result = await trx
        .selectFrom("cache")
        .select(["value", "ttl"])
        .where("key", "=", cacheKey)
        .executeTakeFirst();

      let existing: { count: number; firstAttempt: number } | undefined;
      if (result && result.ttl > now) {
        try {
          existing = superjson.parse(result.value) as { count: number; firstAttempt: number };
        } catch {
          existing = undefined;
        }
      }

      if (existing && now - existing.firstAttempt < windowMs) {
        // Within window - increment
        const newCount = existing.count + 1;
        const newValue = superjson.stringify({ count: newCount, firstAttempt: existing.firstAttempt });
        // IMPORTANT: TTL must be based on original firstAttempt, not current time
        // This prevents the window from sliding forward on each request
        const correctTtl = existing.firstAttempt + windowMs;

        await trx
          .updateTable("cache")
          .set({ value: newValue, ttl: correctTtl })
          .where("key", "=", cacheKey)
          .execute();

        return { count: newCount, firstAttempt: existing.firstAttempt, wasReset: false };
      } else {
        // Window expired or new key - reset counter
        const newValue = superjson.stringify({ count: 1, firstAttempt: now });

        await trx
          .insertInto("cache")
          .values({
            id: crypto.randomUUID(),
            key: cacheKey,
            value: newValue,
            ttl: ttlMs,
          })
          .onConflict((oc) =>
            oc.column("key").doUpdateSet({
              value: newValue,
              ttl: ttlMs,
            }),
          )
          .execute();

        return { count: 1, firstAttempt: now, wasReset: true };
      }
    });
  }

  private static async deleteExpiredData(db: Kysely<any>) {
    const now = Date.now();
    await db.deleteFrom("cache").where("ttl", "<=", now).where("ttl", ">", 0).execute();
  }

  private async setInDb(key: string, value: string, ttl: number) {
    await this.db
      .insertInto("cache")
      .values({
        id: crypto.randomUUID(),
        key,
        value,
        ttl,
      })
      .execute();
  }

  private async getFromDb(
    key: string,
  ): Promise<
    | {
        value: string;
        expireTime: number;
      }
    | undefined
  > {
    const result = await this.db
      .selectFrom("cache")
      .select(["value", "ttl"])
      .where("key", "=", key)
      .executeTakeFirst();
    if (!result) return undefined;

    return {
      value: result.value,
      expireTime: result.ttl,
    };
  }

  async get<T>(key: string): Promise<T | undefined> {
    const cachedItem = await this.getFromDb(key);
    if (!cachedItem) return undefined;

    if (cachedItem.expireTime > 0 && cachedItem.expireTime < Date.now()) {
      await this.deleteFromDb(key);
      return undefined;
    }

    return superjson.parse(cachedItem.value) as T;
  }

  private async deleteFromDb(key: string) {
    await this.db.deleteFrom("cache").where("key", "=", key).execute();
  }

  async delete(key: string) {
    const cachedItem = await this.getFromDb(key);
    if (cachedItem) {
      await this.deleteFromDb(key);
    }
  }

  async clear() {
    await this.db.deleteFrom("cache").execute();
  }
}
