/**
 * Create images table migration
 *
 * Stores image upload metadata and processing status
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("images")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("filename", "text", (col) => col.notNull())
    .addColumn("original_filename", "text", (col) => col.notNull())
    .addColumn("mime_type", "text", (col) => col.notNull())
    .addColumn("size", "integer", (col) => col.notNull())
    .addColumn("s3_key", "text", (col) => col.notNull().unique())
    .addColumn("s3_bucket", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("processing_stage", "text")
    .addColumn("processing_progress", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error", "text")
    .addColumn("width", "integer")
    .addColumn("height", "integer")
    .addColumn("format", "text")
    .addColumn("metadata", "text")
    .addColumn("variants", "text")
    .addColumn("watermark_config", "text")
    .addColumn("upload_id", "text")
    .addColumn("user_id", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .addColumn("completed_at", "text")
    .addColumn("deleted_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_images_status")
    .ifNotExists()
    .on("images")
    .column("status")
    .execute();

  await db.schema
    .createIndex("idx_images_user_id")
    .ifNotExists()
    .on("images")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("idx_images_created_at")
    .ifNotExists()
    .on("images")
    .column("created_at")
    .execute();

  await db.schema
    .createIndex("idx_images_upload_id")
    .ifNotExists()
    .on("images")
    .column("upload_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("images").ifExists().execute();
}
