/**
 * Core Migration: Audit Log Table
 *
 * Creates the __donkeylabs_audit__ table for audit logging in the shared database.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("__donkeylabs_audit__")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("timestamp", "text", (col) => col.notNull())
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("actor", "text", (col) => col.notNull())
    .addColumn("resource", "text", (col) => col.notNull())
    .addColumn("resource_id", "text")
    .addColumn("metadata", "text")
    .addColumn("ip", "text")
    .addColumn("request_id", "text")
    .execute();

  // Create indexes for efficient queries
  await db.schema
    .createIndex("idx_donkeylabs_audit_actor")
    .ifNotExists()
    .on("__donkeylabs_audit__")
    .column("actor")
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_audit_timestamp")
    .ifNotExists()
    .on("__donkeylabs_audit__")
    .column("timestamp")
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_audit_resource")
    .ifNotExists()
    .on("__donkeylabs_audit__")
    .columns(["resource", "resource_id"])
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_audit_action")
    .ifNotExists()
    .on("__donkeylabs_audit__")
    .column("action")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("__donkeylabs_audit__").ifExists().execute();
}
