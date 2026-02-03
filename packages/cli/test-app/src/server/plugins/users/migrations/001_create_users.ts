/**
 * Create users table migration
 *
 * Stores user account information with email-based lookup
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("users")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("name", "text")
    .addColumn("password_hash", "text")
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .execute();

  // Index for email lookups
  await db.schema
    .createIndex("idx_users_email")
    .ifNotExists()
    .on("users")
    .column("email")
    .execute();

  // Index for name searches
  await db.schema
    .createIndex("idx_users_name")
    .ifNotExists()
    .on("users")
    .column("name")
    .execute();

  // Index for created_at ordering
  await db.schema
    .createIndex("idx_users_created_at")
    .ifNotExists()
    .on("users")
    .column("created_at")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("users").ifExists().execute();
}
