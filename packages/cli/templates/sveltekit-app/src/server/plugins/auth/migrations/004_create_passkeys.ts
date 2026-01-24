import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Passkey credentials (WebAuthn)
  await db.schema
    .createTable("passkeys")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("users.id").onDelete("cascade")
    )
    .addColumn("credential_id", "text", (col) => col.notNull().unique())
    .addColumn("public_key", "text", (col) => col.notNull()) // Base64 encoded
    .addColumn("counter", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("device_type", "text") // platform, cross-platform
    .addColumn("backed_up", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("transports", "text") // JSON array
    .addColumn("name", "text") // User-friendly name
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .addColumn("last_used_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_passkeys_user_id")
    .ifNotExists()
    .on("passkeys")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("idx_passkeys_credential_id")
    .ifNotExists()
    .on("passkeys")
    .column("credential_id")
    .execute();

  // Passkey challenges (temporary storage)
  await db.schema
    .createTable("passkey_challenges")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("challenge", "text", (col) => col.notNull())
    .addColumn("user_id", "text") // Null for registration
    .addColumn("type", "text", (col) => col.notNull()) // registration, authentication
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .execute();

  await db.schema
    .createIndex("idx_passkey_challenges_expires_at")
    .ifNotExists()
    .on("passkey_challenges")
    .column("expires_at")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("passkey_challenges").ifExists().execute();
  await db.schema.dropTable("passkeys").ifExists().execute();
}
