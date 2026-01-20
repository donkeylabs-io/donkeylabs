/**
 * Create stripe_customers table migration
 *
 * Links application users to Stripe customers
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("stripe_customers")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().unique())
    .addColumn("stripe_customer_id", "text", (col) => col.notNull().unique())
    .addColumn("email", "text")
    .addColumn("name", "text")
    .addColumn("metadata", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .addColumn("deleted_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_stripe_customers_user_id")
    .ifNotExists()
    .on("stripe_customers")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("idx_stripe_customers_stripe_customer_id")
    .ifNotExists()
    .on("stripe_customers")
    .column("stripe_customer_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("stripe_customers").ifExists().execute();
}
