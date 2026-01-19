/**
 * Audit Core Service
 *
 * Provides audit logging for compliance and tracking.
 * Stores all audit entries in the shared database using Kysely.
 */

import type { Kysely } from "kysely";

// ============================================
// Types
// ============================================

export interface AuditEntry {
  id: string;
  timestamp: Date;
  action: string;
  actor: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, any>;
  ip?: string;
  requestId?: string;
}

export interface AuditQueryFilters {
  /** Filter by action */
  action?: string;
  /** Filter by actor (user id, email, etc.) */
  actor?: string;
  /** Filter by resource type */
  resource?: string;
  /** Filter by resource ID */
  resourceId?: string;
  /** Filter by date range (start) */
  startDate?: Date;
  /** Filter by date range (end) */
  endDate?: Date;
  /** Maximum number of results (default: 100) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

// ============================================
// Adapter Interface
// ============================================

export interface AuditAdapter {
  /** Log a new audit entry */
  log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<string>;
  /** Query audit entries with filters */
  query(filters: AuditQueryFilters): Promise<AuditEntry[]>;
  /** Get audit entries for a specific resource */
  getByResource(resource: string, resourceId: string): Promise<AuditEntry[]>;
  /** Get audit entries for a specific actor */
  getByActor(actor: string, limit?: number): Promise<AuditEntry[]>;
  /** Delete old audit entries (for retention policy) */
  deleteOlderThan(date: Date): Promise<number>;
  /** Stop the adapter (cleanup timers) */
  stop(): void;
}

// ============================================
// Service Interface
// ============================================

export interface Audit {
  /** Log an audit entry */
  log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<string>;
  /** Query audit entries with filters */
  query(filters: AuditQueryFilters): Promise<AuditEntry[]>;
  /** Get audit entries for a specific resource */
  getByResource(resource: string, resourceId: string): Promise<AuditEntry[]>;
  /** Get audit entries for a specific actor */
  getByActor(actor: string, limit?: number): Promise<AuditEntry[]>;
  /** Stop the audit service */
  stop(): void;
}

// ============================================
// Kysely Adapter
// ============================================

// Table type for Kysely
interface AuditTable {
  id: string;
  timestamp: string;
  action: string;
  actor: string;
  resource: string;
  resource_id: string | null;
  metadata: string | null;
  ip: string | null;
  request_id: string | null;
}

interface Database {
  __donkeylabs_audit__: AuditTable;
}

export interface KyselyAuditAdapterConfig {
  /** Auto-cleanup audit entries older than N days (default: 90, 0 to disable) */
  retentionDays?: number;
  /** Cleanup interval in ms (default: 86400000 = 24 hours) */
  cleanupInterval?: number;
}

export class KyselyAuditAdapter implements AuditAdapter {
  private db: Kysely<Database>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private retentionDays: number;

  constructor(db: Kysely<any>, config: KyselyAuditAdapterConfig = {}) {
    this.db = db as Kysely<Database>;
    this.retentionDays = config.retentionDays ?? 90;

    // Start cleanup timer
    if (this.retentionDays > 0) {
      const interval = config.cleanupInterval ?? 86400000; // 24 hours
      this.cleanupTimer = setInterval(() => this.runCleanup(), interval);
      // Run cleanup on startup
      this.runCleanup();
    }
  }

  async log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<string> {
    const id = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const timestamp = new Date();

    await this.db
      .insertInto("__donkeylabs_audit__")
      .values({
        id,
        timestamp: timestamp.toISOString(),
        action: entry.action,
        actor: entry.actor,
        resource: entry.resource,
        resource_id: entry.resourceId ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        ip: entry.ip ?? null,
        request_id: entry.requestId ?? null,
      })
      .execute();

    return id;
  }

  async query(filters: AuditQueryFilters): Promise<AuditEntry[]> {
    let query = this.db.selectFrom("__donkeylabs_audit__").selectAll();

    if (filters.action) {
      query = query.where("action", "=", filters.action);
    }
    if (filters.actor) {
      query = query.where("actor", "=", filters.actor);
    }
    if (filters.resource) {
      query = query.where("resource", "=", filters.resource);
    }
    if (filters.resourceId) {
      query = query.where("resource_id", "=", filters.resourceId);
    }
    if (filters.startDate) {
      query = query.where("timestamp", ">=", filters.startDate.toISOString());
    }
    if (filters.endDate) {
      query = query.where("timestamp", "<=", filters.endDate.toISOString());
    }

    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const rows = await query
      .orderBy("timestamp", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map((r) => this.rowToEntry(r));
  }

  async getByResource(resource: string, resourceId: string): Promise<AuditEntry[]> {
    const rows = await this.db
      .selectFrom("__donkeylabs_audit__")
      .selectAll()
      .where("resource", "=", resource)
      .where("resource_id", "=", resourceId)
      .orderBy("timestamp", "desc")
      .execute();

    return rows.map((r) => this.rowToEntry(r));
  }

  async getByActor(actor: string, limit: number = 100): Promise<AuditEntry[]> {
    const rows = await this.db
      .selectFrom("__donkeylabs_audit__")
      .selectAll()
      .where("actor", "=", actor)
      .orderBy("timestamp", "desc")
      .limit(limit)
      .execute();

    return rows.map((r) => this.rowToEntry(r));
  }

  async deleteOlderThan(date: Date): Promise<number> {
    const result = await this.db
      .deleteFrom("__donkeylabs_audit__")
      .where("timestamp", "<", date.toISOString())
      .execute();

    return Number(result[0]?.numDeletedRows ?? 0);
  }

  private rowToEntry(row: AuditTable): AuditEntry {
    return {
      id: row.id,
      timestamp: new Date(row.timestamp),
      action: row.action,
      actor: row.actor,
      resource: row.resource,
      resourceId: row.resource_id ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      ip: row.ip ?? undefined,
      requestId: row.request_id ?? undefined,
    };
  }

  private async runCleanup(): Promise<void> {
    if (this.retentionDays <= 0) return;

    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.retentionDays);

      const numDeleted = await this.deleteOlderThan(cutoff);
      if (numDeleted > 0) {
        console.log(`[Audit] Cleaned up ${numDeleted} old audit entries`);
      }
    } catch (err) {
      console.error("[Audit] Cleanup error:", err);
    }
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

// ============================================
// In-Memory Adapter (for testing)
// ============================================

export class MemoryAuditAdapter implements AuditAdapter {
  private entries = new Map<string, AuditEntry>();
  private counter = 0;

  async log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<string> {
    const id = `audit_${++this.counter}_${Date.now()}`;
    const fullEntry: AuditEntry = {
      ...entry,
      id,
      timestamp: new Date(),
    };
    this.entries.set(id, fullEntry);
    return id;
  }

  async query(filters: AuditQueryFilters): Promise<AuditEntry[]> {
    let results = Array.from(this.entries.values());

    if (filters.action) {
      results = results.filter((e) => e.action === filters.action);
    }
    if (filters.actor) {
      results = results.filter((e) => e.actor === filters.actor);
    }
    if (filters.resource) {
      results = results.filter((e) => e.resource === filters.resource);
    }
    if (filters.resourceId) {
      results = results.filter((e) => e.resourceId === filters.resourceId);
    }
    if (filters.startDate) {
      results = results.filter((e) => e.timestamp >= filters.startDate!);
    }
    if (filters.endDate) {
      results = results.filter((e) => e.timestamp <= filters.endDate!);
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Apply pagination
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  async getByResource(resource: string, resourceId: string): Promise<AuditEntry[]> {
    return this.query({ resource, resourceId });
  }

  async getByActor(actor: string, limit: number = 100): Promise<AuditEntry[]> {
    return this.query({ actor, limit });
  }

  async deleteOlderThan(date: Date): Promise<number> {
    let deleted = 0;
    for (const [id, entry] of this.entries) {
      if (entry.timestamp < date) {
        this.entries.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  stop(): void {
    // No cleanup needed for in-memory adapter
  }
}

// ============================================
// Service Implementation
// ============================================

export interface AuditConfig {
  adapter?: AuditAdapter;
}

class AuditImpl implements Audit {
  private adapter: AuditAdapter;

  constructor(config: AuditConfig = {}) {
    this.adapter = config.adapter ?? new MemoryAuditAdapter();
  }

  async log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<string> {
    return this.adapter.log(entry);
  }

  async query(filters: AuditQueryFilters): Promise<AuditEntry[]> {
    return this.adapter.query(filters);
  }

  async getByResource(resource: string, resourceId: string): Promise<AuditEntry[]> {
    return this.adapter.getByResource(resource, resourceId);
  }

  async getByActor(actor: string, limit?: number): Promise<AuditEntry[]> {
    return this.adapter.getByActor(actor, limit);
  }

  stop(): void {
    this.adapter.stop();
  }
}

// ============================================
// Factory Function
// ============================================

export function createAudit(config?: AuditConfig): Audit {
  return new AuditImpl(config);
}
