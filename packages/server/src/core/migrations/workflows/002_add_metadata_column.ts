/**
 * Core Migration: Add metadata column to workflow instances
 *
 * Adds a metadata column to store custom JSON data that persists across workflow steps.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  const dialect = getDialectName(db);
  const hasMetadataColumn = await columnExists(db, dialect);

  if (!hasMetadataColumn) {
    await sql`
      ALTER TABLE __donkeylabs_workflow_instances__ ADD COLUMN metadata TEXT
    `.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // SQLite doesn't support DROP COLUMN directly
  // In practice, we don't need to remove it - the column can stay
}

async function columnExists(db: Kysely<any>, dialect: string): Promise<boolean> {
  if (dialect.includes("postgres")) {
    const result = await sql<{ name: string }>`
      SELECT column_name as name
      FROM information_schema.columns
      WHERE table_name = '__donkeylabs_workflow_instances__'
        AND column_name = 'metadata'
        AND table_schema = current_schema()
    `.execute(db);
    return result.rows.length > 0;
  }

  if (dialect.includes("mysql")) {
    const result = await sql<{ name: string }>`
      SELECT column_name as name
      FROM information_schema.columns
      WHERE table_name = '__donkeylabs_workflow_instances__'
        AND column_name = 'metadata'
        AND table_schema = database()
    `.execute(db);
    return result.rows.length > 0;
  }

  const tableInfo = await sql<{ name: string }>`
    PRAGMA table_info(__donkeylabs_workflow_instances__)
  `.execute(db);

  return tableInfo.rows.some((row) => row.name === "metadata");
}

function getDialectName(db: Kysely<any>): string {
  try {
    const adapter = (db as any).getExecutor?.().adapter;
    return adapter?.constructor?.name?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}
