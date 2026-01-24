import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Roles table
  await db.schema
    .createTable("roles")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("tenant_id", "text", (col) =>
      col.references("tenants.id").onDelete("cascade")
    ) // null = global role
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("permissions", "text", (col) => col.notNull().defaultTo("[]")) // JSON array
    .addColumn("inherits_from", "text", (col) =>
      col.references("roles.id").onDelete("set null")
    )
    .addColumn("is_default", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_roles_tenant_id")
    .ifNotExists()
    .on("roles")
    .column("tenant_id")
    .execute();

  await db.schema
    .createIndex("idx_roles_name_tenant")
    .ifNotExists()
    .on("roles")
    .columns(["tenant_id", "name"])
    .execute();

  // User roles table
  await db.schema
    .createTable("user_roles")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("users.id").onDelete("cascade")
    )
    .addColumn("role_id", "text", (col) =>
      col.notNull().references("roles.id").onDelete("cascade")
    )
    .addColumn("tenant_id", "text", (col) =>
      col.notNull().references("tenants.id").onDelete("cascade")
    )
    .addColumn("assigned_by", "text", (col) =>
      col.references("users.id").onDelete("set null")
    )
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .execute();

  await db.schema
    .createIndex("idx_user_roles_user_id")
    .ifNotExists()
    .on("user_roles")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("idx_user_roles_role_id")
    .ifNotExists()
    .on("user_roles")
    .column("role_id")
    .execute();

  await db.schema
    .createIndex("idx_user_roles_tenant_id")
    .ifNotExists()
    .on("user_roles")
    .column("tenant_id")
    .execute();

  await db.schema
    .createIndex("idx_user_roles_unique")
    .ifNotExists()
    .on("user_roles")
    .columns(["user_id", "role_id", "tenant_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("user_roles").ifExists().execute();
  await db.schema.dropTable("roles").ifExists().execute();
}
