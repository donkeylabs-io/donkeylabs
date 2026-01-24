import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("email_tokens")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("type", "text", (col) => col.notNull()) // magic_link, password_reset, email_verification
    .addColumn("email", "text", (col) => col.notNull())
    .addColumn("token_hash", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("used_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .execute();

  await db.schema
    .createIndex("idx_email_tokens_email_type")
    .ifNotExists()
    .on("email_tokens")
    .columns(["email", "type"])
    .execute();

  await db.schema
    .createIndex("idx_email_tokens_expires_at")
    .ifNotExists()
    .on("email_tokens")
    .column("expires_at")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("email_tokens").ifExists().execute();
}
