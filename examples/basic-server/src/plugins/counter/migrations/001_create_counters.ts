import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("counters")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("value", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.defaultTo("CURRENT_TIMESTAMP"))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("counters").execute();
}
