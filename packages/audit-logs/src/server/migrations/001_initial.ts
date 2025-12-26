import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
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
    .addColumn("trace_id", "text")
    .execute();

  // Create indexes for common queries
  await db.schema.createIndex("idx_log_timestamp").on("log_entry").column("timestamp").execute();

  await db.schema
    .createIndex("idx_log_user_timestamp")
    .on("log_entry")
    .columns(["user_id", "timestamp"])
    .execute();

  await db.schema
    .createIndex("idx_log_company_timestamp")
    .on("log_entry")
    .columns(["company_id", "timestamp"])
    .execute();

  await db.schema
    .createIndex("idx_log_event_timestamp")
    .on("log_entry")
    .columns(["event", "timestamp"])
    .execute();

  await db.schema
    .createIndex("idx_log_level_timestamp")
    .on("log_entry")
    .columns(["level", "timestamp"])
    .execute();

  await db.schema.createIndex("idx_log_ip").on("log_entry").column("ip_address").execute();

  await db.schema.createIndex("idx_log_trace").on("log_entry").column("trace_id").execute();

  // Create FTS5 virtual table for full-text search
  await sql`
    CREATE VIRTUAL TABLE log_entry_fts USING fts5(
      event,
      username,
      ip_address,
      path,
      metadata,
      content='log_entry',
      content_rowid='rowid'
    )
  `.execute(db);

  // Create triggers to keep FTS in sync
  await sql`
    CREATE TRIGGER log_entry_ai AFTER INSERT ON log_entry BEGIN
      INSERT INTO log_entry_fts(rowid, event, username, ip_address, path, metadata)
      VALUES (new.rowid, new.event, new.username, new.ip_address, new.path, new.metadata);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER log_entry_ad AFTER DELETE ON log_entry BEGIN
      INSERT INTO log_entry_fts(log_entry_fts, rowid, event, username, ip_address, path, metadata)
      VALUES('delete', old.rowid, old.event, old.username, old.ip_address, old.path, old.metadata);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER log_entry_au AFTER UPDATE ON log_entry BEGIN
      INSERT INTO log_entry_fts(log_entry_fts, rowid, event, username, ip_address, path, metadata)
      VALUES('delete', old.rowid, old.event, old.username, old.ip_address, old.path, old.metadata);
      INSERT INTO log_entry_fts(rowid, event, username, ip_address, path, metadata)
      VALUES (new.rowid, new.event, new.username, new.ip_address, new.path, new.metadata);
    END
  `.execute(db);

  // Create retention_config table
  await db.schema
    .createTable("retention_config")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("level", "text", (col) => col.notNull().unique())
    .addColumn("retention_days", "integer", (col) => col.notNull())
    .execute();

  // Insert default retention config
  await db
    .insertInto("retention_config" as never)
    .values([
      { level: "default", retention_days: 90 },
      { level: "security", retention_days: 365 },
      { level: "error", retention_days: 180 },
      { level: "warn", retention_days: 90 },
      { level: "info", retention_days: 90 },
      { level: "debug", retention_days: 30 },
    ] as never)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop triggers first
  await sql`DROP TRIGGER IF EXISTS log_entry_ai`.execute(db);
  await sql`DROP TRIGGER IF EXISTS log_entry_ad`.execute(db);
  await sql`DROP TRIGGER IF EXISTS log_entry_au`.execute(db);

  // Drop FTS table
  await sql`DROP TABLE IF EXISTS log_entry_fts`.execute(db);

  // Drop tables
  await db.schema.dropTable("retention_config").ifExists().execute();
  await db.schema.dropTable("log_entry").ifExists().execute();
}
