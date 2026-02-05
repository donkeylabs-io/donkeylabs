/**
 * Core Logs Service
 *
 * Persistent, filterable, event-driven logging.
 * Writes log entries to a separate logs database with buffered writes.
 * Emits events so users can build their own SSE routes or subscribers.
 */

import type { Events } from "./events";
import type { LogLevel } from "./logger";
import type { Kysely } from "kysely";

// ============================================
// Types
// ============================================

export type LogSource = "system" | "cron" | "job" | "workflow" | "plugin" | "route";

export interface PersistentLogEntry {
  id: string;
  timestamp: Date;
  level: LogLevel;
  message: string;
  source: LogSource;
  sourceId?: string;
  tags?: string[];
  data?: Record<string, any>;
  context?: Record<string, any>;
}

export interface LogsQueryFilters {
  /** Filter by source type */
  source?: LogSource;
  /** Filter by source identifier */
  sourceId?: string;
  /** Filter by minimum log level */
  level?: LogLevel;
  /** Filter by tags (entries must contain all specified tags) */
  tags?: string[];
  /** Search message text (LIKE on message) */
  search?: string;
  /** Filter by date range (start) */
  startDate?: Date;
  /** Filter by date range (end) */
  endDate?: Date;
  /** Maximum number of results (default: 100) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface LogsRetentionConfig {
  /** Default retention in days (default: 14) */
  defaultDays?: number;
  /** Per-source retention overrides in days */
  bySource?: Partial<Record<LogSource, number>>;
  /** Cleanup interval in ms (default: 86400000 = 24h) */
  cleanupInterval?: number;
}

export interface LogsConfig {
  /** Custom adapter (defaults to KyselyLogsAdapter) */
  adapter?: LogsAdapter;
  /** Events service for emitting log events */
  events?: Events;
  /** Retention configuration */
  retention?: LogsRetentionConfig;
  /** Minimum level for persistence (default: "info") */
  minLevel?: LogLevel;
  /** Buffer flush interval in ms (default: 50) */
  flushInterval?: number;
  /** Maximum buffer size before forced flush (default: 100) */
  maxBufferSize?: number;
  /** Database path (default: ".donkeylabs/logs.db") */
  dbPath?: string;
  /** Use an existing Kysely instance for logs storage */
  db?: Kysely<any>;
}

// ============================================
// Adapter Interface
// ============================================

export interface LogsAdapter {
  /** Write a batch of log entries */
  writeBatch(entries: PersistentLogEntry[]): Promise<void>;
  /** Write a single log entry */
  write(entry: PersistentLogEntry): Promise<void>;
  /** Query log entries with filters */
  query(filters: LogsQueryFilters): Promise<PersistentLogEntry[]>;
  /** Get log entries by source */
  getBySource(source: LogSource, sourceId?: string, limit?: number): Promise<PersistentLogEntry[]>;
  /** Count log entries matching filters */
  count(filters: LogsQueryFilters): Promise<number>;
  /** Delete entries older than a given date, optionally for a specific source */
  deleteOlderThan(date: Date, source?: LogSource): Promise<number>;
  /** Stop the adapter (cleanup resources) */
  stop(): void;
}

// ============================================
// Service Interface
// ============================================

export interface Logs {
  /** Write a log entry (synchronous, enqueues to buffer) */
  write(entry: Omit<PersistentLogEntry, "id" | "timestamp">): void;
  /** Query log entries with filters */
  query(filters: LogsQueryFilters): Promise<PersistentLogEntry[]>;
  /** Get log entries by source */
  getBySource(source: LogSource, sourceId?: string, limit?: number): Promise<PersistentLogEntry[]>;
  /** Count log entries matching filters */
  count(filters: LogsQueryFilters): Promise<number>;
  /** Flush the write buffer */
  flush(): Promise<void>;
  /** Stop the logs service (flush + cleanup) */
  stop(): void;
}

// ============================================
// Log Level Ordering
// ============================================

const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ============================================
// In-Memory Adapter (for testing)
// ============================================

export class MemoryLogsAdapter implements LogsAdapter {
  private entries: PersistentLogEntry[] = [];

  async writeBatch(entries: PersistentLogEntry[]): Promise<void> {
    this.entries.push(...entries);
  }

  async write(entry: PersistentLogEntry): Promise<void> {
    this.entries.push(entry);
  }

  async query(filters: LogsQueryFilters): Promise<PersistentLogEntry[]> {
    let results = [...this.entries];

    if (filters.source) {
      results = results.filter((e) => e.source === filters.source);
    }
    if (filters.sourceId) {
      results = results.filter((e) => e.sourceId === filters.sourceId);
    }
    if (filters.level) {
      const minLevel = LOG_LEVEL_VALUES[filters.level];
      results = results.filter((e) => LOG_LEVEL_VALUES[e.level] >= minLevel);
    }
    if (filters.tags && filters.tags.length > 0) {
      results = results.filter(
        (e) => e.tags && filters.tags!.every((t) => e.tags!.includes(t))
      );
    }
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      results = results.filter((e) =>
        e.message.toLowerCase().includes(searchLower)
      );
    }
    if (filters.startDate) {
      results = results.filter((e) => e.timestamp >= filters.startDate!);
    }
    if (filters.endDate) {
      results = results.filter((e) => e.timestamp <= filters.endDate!);
    }

    // Sort by timestamp descending (newest first)
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  async getBySource(
    source: LogSource,
    sourceId?: string,
    limit: number = 100
  ): Promise<PersistentLogEntry[]> {
    return this.query({ source, sourceId, limit });
  }

  async count(filters: LogsQueryFilters): Promise<number> {
    const results = await this.query({ ...filters, limit: undefined, offset: undefined });
    return results.length;
  }

  async deleteOlderThan(date: Date, source?: LogSource): Promise<number> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (source && e.source !== source) return true;
      return e.timestamp >= date;
    });
    return before - this.entries.length;
  }

  stop(): void {
    // No cleanup needed
  }
}

// ============================================
// Service Implementation
// ============================================

const MAX_BUFFER_OVERFLOW = 10_000;

class LogsImpl implements Logs {
  private adapter: LogsAdapter;
  private events?: Events;
  private buffer: PersistentLogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private maxBufferSize: number;
  private minLevel: number;
  private retention: LogsRetentionConfig;
  private stopped = false;
  private flushing = false;

  constructor(config: LogsConfig = {}) {
    this.adapter = config.adapter ?? new MemoryLogsAdapter();
    this.events = config.events;
    this.maxBufferSize = config.maxBufferSize ?? 100;
    this.minLevel = LOG_LEVEL_VALUES[config.minLevel ?? "info"];
    this.retention = config.retention ?? {};

    // Start flush timer
    const flushInterval = config.flushInterval ?? 50;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        // Use console.log to avoid circular logging
        console.error("[Logs] Flush error:", err);
      });
    }, flushInterval);

    // Start retention cleanup timer
    const cleanupInterval = this.retention.cleanupInterval ?? 86400000; // 24h
    this.cleanupTimer = setInterval(() => {
      this.runCleanup().catch((err) => {
        console.error("[Logs] Cleanup error:", err);
      });
    }, cleanupInterval);
  }

  write(entry: Omit<PersistentLogEntry, "id" | "timestamp">): void {
    if (this.stopped) return;

    // Check minimum level
    if (LOG_LEVEL_VALUES[entry.level] < this.minLevel) return;

    const fullEntry: PersistentLogEntry = {
      ...entry,
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date(),
    };

    this.buffer.push(fullEntry);

    // Check buffer overflow
    if (this.buffer.length > MAX_BUFFER_OVERFLOW) {
      console.warn(
        `[Logs] Buffer overflow (${this.buffer.length} entries), dropping oldest entries`
      );
      this.buffer = this.buffer.slice(-this.maxBufferSize);
    }

    // Flush if buffer is full
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush().catch((err) => {
        console.error("[Logs] Flush error:", err);
      });
    }
  }

  async query(filters: LogsQueryFilters): Promise<PersistentLogEntry[]> {
    return this.adapter.query(filters);
  }

  async getBySource(
    source: LogSource,
    sourceId?: string,
    limit?: number
  ): Promise<PersistentLogEntry[]> {
    return this.adapter.getBySource(source, sourceId, limit);
  }

  async count(filters: LogsQueryFilters): Promise<number> {
    return this.adapter.count(filters);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.flushing) return;

    this.flushing = true;
    const entries = this.buffer.splice(0);

    try {
      await this.adapter.writeBatch(entries);

      // Emit events for each entry after successful write
      if (this.events) {
        for (const entry of entries) {
          try {
            // All logs
            await this.events.emit("log.created", entry);
            // By source type: "log.cron", "log.workflow"
            await this.events.emit(`log.${entry.source}`, entry);
            // Specific: "log.cron.cleanup-task", "log.workflow.wf_123"
            if (entry.sourceId) {
              await this.events.emit(
                `log.${entry.source}.${entry.sourceId}`,
                entry
              );
            }
          } catch (err) {
            // Don't let event emission errors break the flush
            console.error("[Logs] Event emission error:", err);
          }
        }
      }
    } catch (err) {
      // Put entries back if write failed (they'll be retried next flush)
      this.buffer.unshift(...entries);
      // Silently catch - will retry next flush
      // Use console to avoid circular logging
      console.error("[Logs] Write batch failed, will retry:", err);
    } finally {
      this.flushing = false;
    }
  }

  stop(): void {
    this.stopped = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.adapter.stop();
  }

  private async runCleanup(): Promise<void> {
    const defaultDays = this.retention.defaultDays ?? 14;
    const bySource = this.retention.bySource ?? {};

    // Get all source types to clean
    const sources: LogSource[] = [
      "system",
      "cron",
      "job",
      "workflow",
      "plugin",
      "route",
    ];

    for (const source of sources) {
      const days = bySource[source] ?? defaultDays;
      if (days <= 0) continue;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      try {
        const deleted = await this.adapter.deleteOlderThan(cutoff, source);
        if (deleted > 0) {
          console.log(
            `[Logs] Cleaned up ${deleted} old ${source} log entries (>${days} days)`
          );
        }
      } catch (err: any) {
        // Silently ignore table-not-found errors
        if (err?.message?.includes("no such table")) return;
        console.error(`[Logs] Cleanup error for ${source}:`, err);
      }
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createLogs(config?: LogsConfig): Logs {
  return new LogsImpl(config);
}
