import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add message column to log_entry table
  await db.schema
    .alterTable("log_entry")
    .addColumn("message", "text")
    .execute();

  // Recreate FTS table to include message column
  // First, drop existing triggers
  await sql`DROP TRIGGER IF EXISTS log_entry_ai`.execute(db);
  await sql`DROP TRIGGER IF EXISTS log_entry_ad`.execute(db);
  await sql`DROP TRIGGER IF EXISTS log_entry_au`.execute(db);

  // Drop existing FTS table
  await sql`DROP TABLE IF EXISTS log_entry_fts`.execute(db);

  // Create new FTS table with message column
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

  // Recreate triggers with message column
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

  // Rebuild FTS index with existing data
  await sql`INSERT INTO log_entry_fts(log_entry_fts) VALUES('rebuild')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop triggers
  await sql`DROP TRIGGER IF EXISTS log_entry_ai`.execute(db);
  await sql`DROP TRIGGER IF EXISTS log_entry_ad`.execute(db);
  await sql`DROP TRIGGER IF EXISTS log_entry_au`.execute(db);

  // Drop FTS table
  await sql`DROP TABLE IF EXISTS log_entry_fts`.execute(db);

  // Recreate FTS table without message
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

  // Recreate triggers without message
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

  // Note: SQLite doesn't support dropping columns, so we leave message column
  // It won't cause any issues as it's nullable
}
