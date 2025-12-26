import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add new retention_months column
  await db.schema
    .alterTable("retention_config")
    .addColumn("retention_months", "integer", (col) => col.notNull().defaultTo(3))
    .execute();

  // Convert days to months (approximately)
  await sql`
    UPDATE retention_config
    SET retention_months = CASE
      WHEN retention_days >= 365 THEN 12
      WHEN retention_days >= 180 THEN 6
      WHEN retention_days >= 90 THEN 3
      WHEN retention_days >= 30 THEN 1
      ELSE 1
    END
  `.execute(db);

  // Drop old column by recreating the table (SQLite doesn't support DROP COLUMN easily)
  await sql`
    CREATE TABLE retention_config_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL UNIQUE,
      retention_months INTEGER NOT NULL
    )
  `.execute(db);

  await sql`
    INSERT INTO retention_config_new (id, level, retention_months)
    SELECT id, level, retention_months FROM retention_config
  `.execute(db);

  await sql`DROP TABLE retention_config`.execute(db);
  await sql`ALTER TABLE retention_config_new RENAME TO retention_config`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Add retention_days column back
  await db.schema
    .alterTable("retention_config")
    .addColumn("retention_days", "integer", (col) => col.notNull().defaultTo(90))
    .execute();

  // Convert months to days (approximately)
  await sql`
    UPDATE retention_config
    SET retention_days = retention_months * 30
  `.execute(db);

  // Recreate table without retention_months
  await sql`
    CREATE TABLE retention_config_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL UNIQUE,
      retention_days INTEGER NOT NULL
    )
  `.execute(db);

  await sql`
    INSERT INTO retention_config_new (id, level, retention_days)
    SELECT id, level, retention_days FROM retention_config
  `.execute(db);

  await sql`DROP TABLE retention_config`.execute(db);
  await sql`ALTER TABLE retention_config_new RENAME TO retention_config`.execute(db);
}
