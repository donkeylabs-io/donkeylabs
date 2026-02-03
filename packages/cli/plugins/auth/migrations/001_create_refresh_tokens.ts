/**
 * Create refresh tokens table migration
 *
 * Stores refresh tokens for JWT authentication with automatic cleanup support
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("refresh_tokens")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("token_hash", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .addColumn("revoked", "integer", (col) =>
      col.notNull().defaultTo(0)
    )
    .execute();

  // Index for token lookups
  await db.schema
    .createIndex("idx_refresh_tokens_hash")
    .ifNotExists()
    .on("refresh_tokens")
    .column("token_hash")
    .execute();

  // Index for user lookups
  await db.schema
    .createIndex("idx_refresh_tokens_user_id")
    .ifNotExists()
    .on("refresh_tokens")
    .column("user_id")
    .execute();

  // Index for cleanup of expired tokens
  await db.schema
    .createIndex("idx_refresh_tokens_expires_at")
    .ifNotExists()
    .on("refresh_tokens")
    .column("expires_at")
    .execute();

  // Index for finding revoked tokens
  await db.schema
    .createIndex("idx_refresh_tokens_revoked")
    .ifNotExists()
    .on("refresh_tokens")
    .column("revoked")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("refresh_tokens").ifExists().execute();
}
