/**
 * Core Migration: Jobs Table
 *
 * Creates the __donkeylabs_jobs__ table for job persistence in the shared database.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("__donkeylabs_jobs__")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("data", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("run_at", "text")
    .addColumn("started_at", "text")
    .addColumn("completed_at", "text")
    .addColumn("result", "text")
    .addColumn("error", "text")
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("max_attempts", "integer", (col) => col.notNull().defaultTo(3))
    .addColumn("external", "integer", (col) => col.defaultTo(0))
    .addColumn("pid", "integer")
    .addColumn("socket_path", "text")
    .addColumn("tcp_port", "integer")
    .addColumn("last_heartbeat", "text")
    .addColumn("process_state", "text")
    .execute();

  // Create indexes for efficient queries
  await db.schema
    .createIndex("idx_donkeylabs_jobs_status")
    .ifNotExists()
    .on("__donkeylabs_jobs__")
    .column("status")
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_jobs_name")
    .ifNotExists()
    .on("__donkeylabs_jobs__")
    .column("name")
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_jobs_external")
    .ifNotExists()
    .on("__donkeylabs_jobs__")
    .columns(["external", "status"])
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_jobs_scheduled")
    .ifNotExists()
    .on("__donkeylabs_jobs__")
    .columns(["status", "run_at"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("__donkeylabs_jobs__").ifExists().execute();
}
