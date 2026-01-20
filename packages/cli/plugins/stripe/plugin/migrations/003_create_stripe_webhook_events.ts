/**
 * Create stripe_webhook_events table migration
 *
 * Tracks processed webhook events for idempotency
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("stripe_webhook_events")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("stripe_event_id", "text", (col) => col.notNull().unique())
    .addColumn("event_type", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("processing"))
    .addColumn("error", "text")
    .addColumn("processed_at", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .execute();

  await db.schema
    .createIndex("idx_stripe_webhook_events_stripe_event_id")
    .ifNotExists()
    .on("stripe_webhook_events")
    .column("stripe_event_id")
    .execute();

  await db.schema
    .createIndex("idx_stripe_webhook_events_event_type")
    .ifNotExists()
    .on("stripe_webhook_events")
    .column("event_type")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("stripe_webhook_events").ifExists().execute();
}
