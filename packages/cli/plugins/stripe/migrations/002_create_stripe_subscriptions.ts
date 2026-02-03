/**
 * Create stripe_subscriptions table migration
 *
 * Stores subscription data synced from Stripe
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("stripe_subscriptions")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("stripe_subscription_id", "text", (col) => col.notNull().unique())
    .addColumn("stripe_customer_id", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("price_id", "text", (col) => col.notNull())
    .addColumn("product_id", "text", (col) => col.notNull())
    .addColumn("quantity", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("current_period_start", "text", (col) => col.notNull())
    .addColumn("current_period_end", "text", (col) => col.notNull())
    .addColumn("cancel_at_period_end", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("canceled_at", "text")
    .addColumn("ended_at", "text")
    .addColumn("trial_start", "text")
    .addColumn("trial_end", "text")
    .addColumn("metadata", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .execute();

  await db.schema
    .createIndex("idx_stripe_subscriptions_user_id")
    .ifNotExists()
    .on("stripe_subscriptions")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("idx_stripe_subscriptions_stripe_subscription_id")
    .ifNotExists()
    .on("stripe_subscriptions")
    .column("stripe_subscription_id")
    .execute();

  await db.schema
    .createIndex("idx_stripe_subscriptions_stripe_customer_id")
    .ifNotExists()
    .on("stripe_subscriptions")
    .column("stripe_customer_id")
    .execute();

  await db.schema
    .createIndex("idx_stripe_subscriptions_status")
    .ifNotExists()
    .on("stripe_subscriptions")
    .column("status")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("stripe_subscriptions").ifExists().execute();
}
