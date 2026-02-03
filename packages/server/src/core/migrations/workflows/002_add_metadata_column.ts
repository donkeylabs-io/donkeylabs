/**
 * Core Migration: Add metadata column to workflow instances
 *
 * Adds a metadata column to store custom JSON data that persists across workflow steps.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
  // Check if column exists first
  const tableInfo = await sql<{ name: string }>`
    PRAGMA table_info(__donkeylabs_workflow_instances__)
  `.execute(db);

  const hasMetadataColumn = tableInfo.rows.some((row) => row.name === "metadata");

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
