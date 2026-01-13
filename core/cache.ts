// Core Cache Service
// Key-value store with TTL, in-memory by default

export interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
}

export interface CacheConfig {
  adapter?: CacheAdapter;
  defaultTtlMs?: number; // Default: 5 minutes
  maxSize?: number; // Default: 1000 items (LRU eviction)
}

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
  getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T>;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
}

// In-memory cache adapter with LRU eviction
export class MemoryCacheAdapter implements CacheAdapter {
  private cache = new Map<string, CacheEntry<any>>();
  private accessOrder: string[] = [];
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  private isExpired(entry: CacheEntry<any>): boolean {
    return entry.expiresAt !== null && Date.now() > entry.expiresAt;
  }

  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  private evictIfNeeded(): void {
    while (this.cache.size >= this.maxSize && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift();
      if (oldest) {
        this.cache.delete(oldest);
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      const index = this.accessOrder.indexOf(key);
      if (index > -1) this.accessOrder.splice(index, 1);
      return null;
    }

    this.updateAccessOrder(key);
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.evictIfNeeded();

    const entry: CacheEntry<T> = {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    };

    this.cache.set(key, entry);
    this.updateAccessOrder(key);
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.cache.has(key);
    this.cache.delete(key);
    const index = this.accessOrder.indexOf(key);
    if (index > -1) this.accessOrder.splice(index, 1);
    return existed;
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.accessOrder = [];
  }

  async keys(pattern?: string): Promise<string[]> {
    const allKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (!this.isExpired(entry)) {
        if (!pattern || this.matchPattern(key, pattern)) {
          allKeys.push(key);
        }
      }
    }

    return allKeys;
  }

  private matchPattern(key: string, pattern: string): boolean {
    // Simple glob pattern matching (* as wildcard)
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(key);
  }
}

class CacheImpl implements Cache {
  private adapter: CacheAdapter;
  private defaultTtlMs: number;

  constructor(config: CacheConfig = {}) {
    this.adapter = config.adapter ?? new MemoryCacheAdapter(config.maxSize);
    this.defaultTtlMs = config.defaultTtlMs ?? 5 * 60 * 1000; // 5 minutes
  }

  async get<T>(key: string): Promise<T | null> {
    return this.adapter.get<T>(key);
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    return this.adapter.set(key, value, ttlMs ?? this.defaultTtlMs);
  }

  async delete(key: string): Promise<boolean> {
    return this.adapter.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.adapter.has(key);
  }

  async clear(): Promise<void> {
    return this.adapter.clear();
  }

  async keys(pattern?: string): Promise<string[]> {
    return this.adapter.keys(pattern);
  }

  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T> {
    const existing = await this.get<T>(key);
    if (existing !== null) return existing;

    const value = await factory();
    await this.set(key, value, ttlMs);
    return value;
  }
}

export function createCache(config?: CacheConfig): Cache {
  return new CacheImpl(config);
}
