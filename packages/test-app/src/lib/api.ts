/**
 * Generated API client for the demo
 * Extends UnifiedApiClientBase to handle SSR direct calls and browser HTTP calls
 */
import { UnifiedApiClientBase } from "@donkeylabs/adapter-sveltekit/client";

// Route type definitions
export interface CounterResponse {
  count: number;
}

export interface CacheGetResponse {
  value: any;
  exists: boolean;
}

export interface CacheKeysResponse {
  keys: string[];
  size: number;
}

export interface JobEnqueueResponse {
  jobId: string;
}

export interface JobStatsResponse {
  pending: number;
  running: number;
  completed: number;
}

export interface CronTask {
  id: string;
  name: string;
  expression: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

export interface CronListResponse {
  tasks: CronTask[];
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: string;
  retryAfter?: number;
}

export interface SSEClientsResponse {
  total: number;
  byChannel: number;
}

/**
 * Typed API client for the demo server
 */
export class ApiClient extends UnifiedApiClientBase {
  // Counter routes
  counter = {
    get: () => this.request<{}, CounterResponse>("api.counter.get", {}),
    increment: () => this.request<{}, CounterResponse>("api.counter.increment", {}),
    decrement: () => this.request<{}, CounterResponse>("api.counter.decrement", {}),
    reset: () => this.request<{}, CounterResponse>("api.counter.reset", {}),
  };

  // Cache routes
  cache = {
    set: (input: { key: string; value: any; ttl?: number }) =>
      this.request<typeof input, { success: boolean }>("api.cache.set", input),
    get: (input: { key: string }) =>
      this.request<typeof input, CacheGetResponse>("api.cache.get", input),
    delete: (input: { key: string }) =>
      this.request<typeof input, { success: boolean }>("api.cache.delete", input),
    keys: () =>
      this.request<{}, CacheKeysResponse>("api.cache.keys", {}),
  };

  // Jobs routes
  jobs = {
    enqueue: (input: { name?: string; data?: any; delay?: number }) =>
      this.request<typeof input, JobEnqueueResponse>("api.jobs.enqueue", input),
    stats: () =>
      this.request<{}, JobStatsResponse>("api.jobs.stats", {}),
  };

  // Cron routes
  cron = {
    list: () =>
      this.request<{}, CronListResponse>("api.cron.list", {}),
  };

  // Rate limiter routes
  ratelimit = {
    check: (input: { key?: string; limit?: number; window?: number }) =>
      this.request<typeof input, RateLimitResult>("api.ratelimit.check", input),
    reset: (input: { key?: string }) =>
      this.request<typeof input, { success: boolean }>("api.ratelimit.reset", input),
  };

  // Events routes
  events = {
    emit: (input: { event?: string; data?: any }) =>
      this.request<typeof input, { success: boolean }>("api.events.emit", input),
  };

  // SSE routes
  sseRoutes = {
    broadcast: (input: { channel?: string; event?: string; data: any }) =>
      this.request<typeof input, { success: boolean }>("api.sse.broadcast", input),
    clients: () =>
      this.request<{}, SSEClientsResponse>("api.sse.clients", {}),
  };
}

/**
 * Create an API client instance
 *
 * @example
 * // In +page.server.ts (SSR - direct calls)
 * const api = createApi({ locals });
 * const data = await api.counter.get();
 *
 * @example
 * // In +page.svelte (browser - HTTP calls)
 * const api = createApi();
 * const data = await api.counter.get();
 */
export function createApi(options?: { locals?: any }) {
  return new ApiClient(options);
}
