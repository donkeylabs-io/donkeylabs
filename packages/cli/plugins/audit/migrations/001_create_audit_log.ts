/**
 * Create audit log table migration
 *
 * Stores comprehensive audit logs for compliance and debugging
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("audit_log")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("resource_type", "text", (col) => col.notNull())
    .addColumn("resource_id", "text")
    .addColumn("user_id", "text")
    .addColumn("user_email", "text")
    .addColumn("ip_address", "text")
    .addColumn("user_agent", "text")
    .addColumn("before_data", "text")
    .addColumn("after_data", "text")
    .addColumn("metadata", "text")
    .addColumn("severity", "text", (col) => col.notNull().defaultTo("info"))
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo("CURRENT_TIMESTAMP")
    )
    .execute();

  // Index for user activity queries
  await db.schema
    .createIndex("idx_audit_log_user_id")
    .ifNotExists()
    .on("audit_log")
    .column("user_id")
    .execute();

  // Index for resource lookups
  await db.schema
    .createIndex("idx_audit_log_resource")
    .ifNotExists()
    .on("audit_log")
    .columns(["resource_type", "resource_id"])
    .execute();

  // Index for action filtering
  await db.schema
    .createIndex("idx_audit_log_action")
    .ifNotExists()
    .on("audit_log")
    .column("action")
    .execute();

  // Index for severity filtering
  await db.schema
    .createIndex("idx_audit_log_severity")
    .ifNotExists()
    .on("audit_log")
    .column("severity")
    .execute();

  // Index for date range queries
  await db.schema
    .createIndex("idx_audit_log_created_at")
    .ifNotExists()
    .on("audit_log")
    .column("created_at")
    .execute();

  // Composite index for history queries
  await db.schema
    .createIndex("idx_audit_log_resource_created")
    .ifNotExists()
    .on("audit_log")
    .columns(["resource_type", "resource_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("audit_log").ifExists().execute();
}
