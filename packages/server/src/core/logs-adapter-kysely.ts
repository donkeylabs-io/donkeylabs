/**
 * Kysely Logs Adapter
 *
 * Manages its own SQLite database at .donkeylabs/logs.db
 * Self-creates the table and indexes (no migration needed).
 */

import { Kysely, SqliteDialect, sql } from "kysely";
import type {
  LogsAdapter,
  PersistentLogEntry,
  LogsQueryFilters,
  LogSource,
} from "./logs";
import type { LogLevel } from "./logger";

// ============================================
// Database Types
// ============================================

interface LogsTable {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  source: string;
  source_id: string | null;
  tags: string | null;
  data: string | null;
  context: string | null;
}

interface Database {
  __donkeylabs_logs__: LogsTable;
}

// Log level ordering for queries
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ============================================
// Adapter Configuration
// ============================================

export interface KyselyLogsAdapterConfig {
  /** Database file path (default: ".donkeylabs/logs.db") */
  dbPath?: string;
  /** Use an existing Kysely instance */
  db?: Kysely<Database>;
}

// ============================================
// Adapter Implementation
// ============================================

export class KyselyLogsAdapter implements LogsAdapter {
  private db: Kysely<Database>;
  private tableReady = false;
  private ensureTablePromise: Promise<void> | null = null;

  constructor(config: KyselyLogsAdapterConfig = {}) {
    if (config.db) {
      this.db = config.db;
      return;
    }

    const dbPath = config.dbPath ?? ".donkeylabs/logs.db";

    // Ensure directory exists
    try {
      const { mkdirSync } = require("node:fs");
      const { dirname } = require("node:path");
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch {
      // Ignore - directory may already exist
    }

    // Create own Kysely instance with BunSqliteDialect
    // Use dynamic import pattern for the SQLite database
    const BunSqlite = require("bun:sqlite");
    const sqliteDb = new BunSqlite.default(dbPath);

    // Enable WAL mode for better concurrent read/write performance
    sqliteDb.exec("PRAGMA journal_mode = WAL");
    sqliteDb.exec("PRAGMA synchronous = NORMAL");
    sqliteDb.exec("PRAGMA busy_timeout = 5000");

    this.db = new Kysely<Database>({
      dialect: new SqliteDialect({
        database: sqliteDb,
      }),
    });
  }

  private async ensureTable(): Promise<void> {
    if (this.tableReady) return;

    // Use a shared promise to avoid multiple concurrent table creation attempts
    if (!this.ensureTablePromise) {
      this.ensureTablePromise = this.createTable();
    }

    await this.ensureTablePromise;
  }

  private async createTable(): Promise<void> {
    try {
      await this.db.schema
        .createTable("__donkeylabs_logs__")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("timestamp", "text", (col) => col.notNull())
        .addColumn("level", "text", (col) => col.notNull())
        .addColumn("message", "text", (col) => col.notNull())
        .addColumn("source", "text", (col) => col.notNull())
        .addColumn("source_id", "text")
        .addColumn("tags", "text")
        .addColumn("data", "text")
        .addColumn("context", "text")
        .execute();

      // Create indexes for common queries
      await sql`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON __donkeylabs_logs__(timestamp)`.execute(this.db);
      await sql`CREATE INDEX IF NOT EXISTS idx_logs_source ON __donkeylabs_logs__(source, source_id)`.execute(this.db);
      await sql`CREATE INDEX IF NOT EXISTS idx_logs_level ON __donkeylabs_logs__(level)`.execute(this.db);
      await sql`CREATE INDEX IF NOT EXISTS idx_logs_source_timestamp ON __donkeylabs_logs__(source, timestamp)`.execute(this.db);

      this.tableReady = true;
    } catch (err) {
      console.error("[LogsAdapter] Failed to create table:", err);
      throw err;
    }
  }

  async writeBatch(entries: PersistentLogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    await this.ensureTable();

    // Use individual inserts within implicit transaction for SQLite compatibility
    for (const entry of entries) {
      await this.db
        .insertInto("__donkeylabs_logs__")
        .values({
          id: entry.id,
          timestamp: entry.timestamp.toISOString(),
          level: entry.level,
          message: entry.message,
          source: entry.source,
          source_id: entry.sourceId ?? null,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          data: entry.data ? JSON.stringify(entry.data) : null,
          context: entry.context ? JSON.stringify(entry.context) : null,
        })
        .execute();
    }
  }

  async write(entry: PersistentLogEntry): Promise<void> {
    await this.writeBatch([entry]);
  }

  async query(filters: LogsQueryFilters): Promise<PersistentLogEntry[]> {
    await this.ensureTable();

    let query = this.db.selectFrom("__donkeylabs_logs__").selectAll();

    if (filters.source) {
      query = query.where("source", "=", filters.source);
    }
    if (filters.sourceId) {
      query = query.where("source_id", "=", filters.sourceId);
    }
    if (filters.level) {
      // Filter by minimum level - include the specified level and above
      const minLevel = LOG_LEVEL_VALUES[filters.level];
      const validLevels = (Object.keys(LOG_LEVEL_VALUES) as LogLevel[]).filter(
        (l) => LOG_LEVEL_VALUES[l] >= minLevel
      );
      query = query.where("level", "in", validLevels);
    }
    if (filters.search) {
      query = query.where("message", "like", `%${filters.search}%`);
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

    let results = rows.map((r) => this.rowToEntry(r));

    // Tag filtering done in-memory (JSON column)
    if (filters.tags && filters.tags.length > 0) {
      results = results.filter(
        (e) => e.tags && filters.tags!.every((t) => e.tags!.includes(t))
      );
    }

    return results;
  }

  async getBySource(
    source: LogSource,
    sourceId?: string,
    limit: number = 100
  ): Promise<PersistentLogEntry[]> {
    return this.query({ source, sourceId, limit });
  }

  async count(filters: LogsQueryFilters): Promise<number> {
    await this.ensureTable();

    let query = this.db
      .selectFrom("__donkeylabs_logs__")
      .select(sql<number>`count(*)`.as("count"));

    if (filters.source) {
      query = query.where("source", "=", filters.source);
    }
    if (filters.sourceId) {
      query = query.where("source_id", "=", filters.sourceId);
    }
    if (filters.level) {
      const minLevel = LOG_LEVEL_VALUES[filters.level];
      const validLevels = (Object.keys(LOG_LEVEL_VALUES) as LogLevel[]).filter(
        (l) => LOG_LEVEL_VALUES[l] >= minLevel
      );
      query = query.where("level", "in", validLevels);
    }
    if (filters.search) {
      query = query.where("message", "like", `%${filters.search}%`);
    }
    if (filters.startDate) {
      query = query.where("timestamp", ">=", filters.startDate.toISOString());
    }
    if (filters.endDate) {
      query = query.where("timestamp", "<=", filters.endDate.toISOString());
    }

    const result = await query.executeTakeFirst();
    return Number(result?.count ?? 0);
  }

  async deleteOlderThan(date: Date, source?: LogSource): Promise<number> {
    await this.ensureTable();

    let query = this.db
      .deleteFrom("__donkeylabs_logs__")
      .where("timestamp", "<", date.toISOString());

    if (source) {
      query = query.where("source", "=", source);
    }

    const result = await query.execute();
    return Number(result[0]?.numDeletedRows ?? 0);
  }

  stop(): void {
    try {
      this.db.destroy();
    } catch {
      // Ignore errors during cleanup
    }
  }

  private rowToEntry(row: LogsTable): PersistentLogEntry {
    return {
      id: row.id,
      timestamp: new Date(row.timestamp),
      level: row.level as LogLevel,
      message: row.message,
      source: row.source as LogSource,
      sourceId: row.source_id ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      data: row.data ? JSON.parse(row.data) : undefined,
      context: row.context ? JSON.parse(row.context) : undefined,
    };
  }
}
