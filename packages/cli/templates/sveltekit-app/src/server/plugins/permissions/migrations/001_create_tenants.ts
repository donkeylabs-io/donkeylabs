import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Tenants table
  await db.schema
    .createTable("tenants")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("slug", "text", (col) => col.notNull().unique())
    .addColumn("settings", "text") // JSON
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_tenants_slug")
    .ifNotExists()
    .on("tenants")
    .column("slug")
    .execute();

  // Tenant members table
  await db.schema
    .createTable("tenant_members")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("tenant_id", "text", (col) =>
      col.notNull().references("tenants.id").onDelete("cascade")
    )
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("users.id").onDelete("cascade")
    )
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .execute();

  await db.schema
    .createIndex("idx_tenant_members_tenant_id")
    .ifNotExists()
    .on("tenant_members")
    .column("tenant_id")
    .execute();

  await db.schema
    .createIndex("idx_tenant_members_user_id")
    .ifNotExists()
    .on("tenant_members")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("idx_tenant_members_unique")
    .ifNotExists()
    .on("tenant_members")
    .columns(["tenant_id", "user_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("tenant_members").ifExists().execute();
  await db.schema.dropTable("tenants").ifExists().execute();
}
