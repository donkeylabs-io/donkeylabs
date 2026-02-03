/**
 * Create email queue table migration
 *
 * Stores queued emails for background processing with retry support
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("email_queue")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("to_address", "text", (col) => col.notNull())
    .addColumn("from_address", "text")
    .addColumn("subject", "text")
    .addColumn("text_content", "text")
    .addColumn("html_content", "text")
    .addColumn("cc", "text")
    .addColumn("bcc", "text")
    .addColumn("priority", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("scheduled_at", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error_message", "text")
    .addColumn("sent_at", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .execute();

  // Index for pending emails processing
  await db.schema
    .createIndex("idx_email_queue_status_scheduled")
    .ifNotExists()
    .on("email_queue")
    .columns(["status", "scheduled_at"])
    .execute();

  // Index for priority ordering
  await db.schema
    .createIndex("idx_email_queue_priority")
    .ifNotExists()
    .on("email_queue")
    .column("priority")
    .execute();

  // Index for cleanup of old sent emails
  await db.schema
    .createIndex("idx_email_queue_sent_at")
    .ifNotExists()
    .on("email_queue")
    .column("sent_at")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("email_queue").ifExists().execute();
}
