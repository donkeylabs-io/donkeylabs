/**
 * Core Migration: Processes Table
 *
 * Creates the __donkeylabs_processes__ table for process persistence in the shared database.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("__donkeylabs_processes__")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("pid", "integer")
    .addColumn("socket_path", "text")
    .addColumn("tcp_port", "integer")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("stopped"))
    .addColumn("config", "text", (col) => col.notNull())
    .addColumn("metadata", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("started_at", "text")
    .addColumn("stopped_at", "text")
    .addColumn("last_heartbeat", "text")
    .addColumn("restart_count", "integer", (col) => col.defaultTo(0))
    .addColumn("consecutive_failures", "integer", (col) => col.defaultTo(0))
    .addColumn("error", "text")
    .execute();

  // Create indexes for efficient queries
  await db.schema
    .createIndex("idx_donkeylabs_processes_status")
    .ifNotExists()
    .on("__donkeylabs_processes__")
    .column("status")
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_processes_name")
    .ifNotExists()
    .on("__donkeylabs_processes__")
    .column("name")
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_processes_name_status")
    .ifNotExists()
    .on("__donkeylabs_processes__")
    .columns(["name", "status"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("__donkeylabs_processes__").ifExists().execute();
}
