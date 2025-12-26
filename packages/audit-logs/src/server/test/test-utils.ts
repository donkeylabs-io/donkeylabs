import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import type { AuditLogDB } from "../db";

/**
 * Creates an in-memory SQLite database for testing with all tables set up
 */
export async function createTestDatabase(): Promise<Kysely<AuditLogDB>> {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode = WAL");

  const db = new Kysely<AuditLogDB>({
    dialect: new BunSqliteDialect({ database: sqlite }),
  });

  // Create log_entry table
  await db.schema
    .createTable("log_entry")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("timestamp", "integer", (col) => col.notNull())
    .addColumn("level", "text", (col) => col.notNull())
    .addColumn("event", "text", (col) => col.notNull())
    .addColumn("user_id", "integer")
    .addColumn("company_id", "integer")
    .addColumn("employee_id", "integer")
    .addColumn("username", "text")
    .addColumn("ip_address", "text")
    .addColumn("user_agent", "text")
    .addColumn("geo_country", "text")
    .addColumn("geo_city", "text")
    .addColumn("method", "text")
    .addColumn("path", "text")
    .addColumn("status_code", "integer")
    .addColumn("duration_ms", "integer")
    .addColumn("metadata", "text")
    .addColumn("message", "text")
    .addColumn("trace_id", "text")
    .execute();

  // Create indexes
  await db.schema.createIndex("idx_log_timestamp").on("log_entry").column("timestamp").execute();
  await db.schema.createIndex("idx_log_user_timestamp").on("log_entry").columns(["user_id", "timestamp"]).execute();
  await db.schema.createIndex("idx_log_company_timestamp").on("log_entry").columns(["company_id", "timestamp"]).execute();
  await db.schema.createIndex("idx_log_event_timestamp").on("log_entry").columns(["event", "timestamp"]).execute();
  await db.schema.createIndex("idx_log_level_timestamp").on("log_entry").columns(["level", "timestamp"]).execute();
  await db.schema.createIndex("idx_log_ip").on("log_entry").column("ip_address").execute();
  await db.schema.createIndex("idx_log_trace").on("log_entry").column("trace_id").execute();

  // Create FTS5 virtual table
  await sql`
    CREATE VIRTUAL TABLE log_entry_fts USING fts5(
      event,
      username,
      ip_address,
      path,
      metadata,
      message,
      content='log_entry',
      content_rowid='rowid'
    )
  `.execute(db);

  // Create triggers for FTS
  await sql`
    CREATE TRIGGER log_entry_ai AFTER INSERT ON log_entry BEGIN
      INSERT INTO log_entry_fts(rowid, event, username, ip_address, path, metadata, message)
      VALUES (new.rowid, new.event, new.username, new.ip_address, new.path, new.metadata, new.message);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER log_entry_ad AFTER DELETE ON log_entry BEGIN
      INSERT INTO log_entry_fts(log_entry_fts, rowid, event, username, ip_address, path, metadata, message)
      VALUES('delete', old.rowid, old.event, old.username, old.ip_address, old.path, old.metadata, old.message);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER log_entry_au AFTER UPDATE ON log_entry BEGIN
      INSERT INTO log_entry_fts(log_entry_fts, rowid, event, username, ip_address, path, metadata, message)
      VALUES('delete', old.rowid, old.event, old.username, old.ip_address, old.path, old.metadata, old.message);
      INSERT INTO log_entry_fts(rowid, event, username, ip_address, path, metadata, message)
      VALUES (new.rowid, new.event, new.username, new.ip_address, new.path, new.metadata, new.message);
    END
  `.execute(db);

  // Create retention_config table
  await db.schema
    .createTable("retention_config")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("level", "text", (col) => col.notNull().unique())
    .addColumn("retention_months", "integer", (col) => col.notNull())
    .execute();

  // Insert default retention config
  await db
    .insertInto("retention_config")
    .values([
      { level: "default", retention_months: 3 },
      { level: "security", retention_months: 12 },
      { level: "error", retention_months: 6 },
      { level: "warn", retention_months: 3 },
      { level: "info", retention_months: 3 },
      { level: "debug", retention_months: 1 },
    ])
    .execute();

  return db;
}

/**
 * Clears all log entries from the test database
 */
export async function clearLogEntries(db: Kysely<AuditLogDB>): Promise<void> {
  await db.deleteFrom("log_entry").execute();
}
