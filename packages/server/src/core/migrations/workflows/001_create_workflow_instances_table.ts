/**
 * Core Migration: Workflow Instances Table
 *
 * Creates the __donkeylabs_workflow_instances__ table for workflow persistence in the shared database.
 * This is a critical migration as workflows previously had NO persistence (in-memory only).
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("__donkeylabs_workflow_instances__")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("workflow_name", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("current_step", "text")
    .addColumn("input", "text", (col) => col.notNull())
    .addColumn("output", "text")
    .addColumn("error", "text")
    .addColumn("step_results", "text", (col) => col.notNull().defaultTo("{}"))
    .addColumn("branch_instances", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("started_at", "text")
    .addColumn("completed_at", "text")
    .addColumn("parent_id", "text")
    .addColumn("branch_name", "text")
    .execute();

  // Create indexes for efficient queries
  await db.schema
    .createIndex("idx_donkeylabs_workflows_name")
    .ifNotExists()
    .on("__donkeylabs_workflow_instances__")
    .column("workflow_name")
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_workflows_status")
    .ifNotExists()
    .on("__donkeylabs_workflow_instances__")
    .column("status")
    .execute();

  await db.schema
    .createIndex("idx_donkeylabs_workflows_parent")
    .ifNotExists()
    .on("__donkeylabs_workflow_instances__")
    .column("parent_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("__donkeylabs_workflow_instances__").ifExists().execute();
}
