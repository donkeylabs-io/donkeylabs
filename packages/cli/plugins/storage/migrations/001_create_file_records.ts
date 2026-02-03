/**
 * Create files table migration
 *
 * Stores file metadata with support for S3 and local storage
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("files")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("original_name", "text", (col) => col.notNull())
    .addColumn("storage_key", "text", (col) => col.notNull())
    .addColumn("mime_type", "text", (col) => col.notNull())
    .addColumn("size", "integer", (col) => col.notNull())
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("metadata", "text")
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("is_public", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .addColumn("deleted_at", "text")
    .execute();

  // Index for storage key lookups
  await db.schema
    .createIndex("idx_files_storage_key")
    .ifNotExists()
    .on("files")
    .column("storage_key")
    .execute();

  // Index for provider filtering
  await db.schema
    .createIndex("idx_files_provider")
    .ifNotExists()
    .on("files")
    .column("provider")
    .execute();

  // Index for public file queries
  await db.schema
    .createIndex("idx_files_is_public")
    .ifNotExists()
    .on("files")
    .column("is_public")
    .execute();

  // Index for deleted file cleanup
  await db.schema
    .createIndex("idx_files_deleted_at")
    .ifNotExists()
    .on("files")
    .column("deleted_at")
    .execute();

  // Index for recent files
  await db.schema
    .createIndex("idx_files_created_at")
    .ifNotExists()
    .on("files")
    .column("created_at")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("files").ifExists().execute();
}
