import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("resource_grants")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("tenant_id", "text", (col) =>
      col.notNull().references("tenants.id").onDelete("cascade")
    )
    .addColumn("resource_type", "text", (col) => col.notNull())
    .addColumn("resource_id", "text", (col) => col.notNull())
    .addColumn("grantee_type", "text", (col) => col.notNull()) // "user" | "role"
    .addColumn("grantee_id", "text", (col) => col.notNull())
    .addColumn("permissions", "text", (col) => col.notNull().defaultTo("[]")) // JSON array
    .addColumn("granted_by", "text", (col) =>
      col.references("users.id").onDelete("set null")
    )
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .execute();

  // Index for looking up grants by resource
  await db.schema
    .createIndex("idx_resource_grants_resource")
    .ifNotExists()
    .on("resource_grants")
    .columns(["tenant_id", "resource_type", "resource_id"])
    .execute();

  // Index for looking up grants by grantee
  await db.schema
    .createIndex("idx_resource_grants_grantee")
    .ifNotExists()
    .on("resource_grants")
    .columns(["tenant_id", "grantee_type", "grantee_id"])
    .execute();

  // Unique constraint: one grant per resource+grantee combination
  await db.schema
    .createIndex("idx_resource_grants_unique")
    .ifNotExists()
    .on("resource_grants")
    .columns(["tenant_id", "resource_type", "resource_id", "grantee_type", "grantee_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("resource_grants").ifExists().execute();
}
