import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("snapshots")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("counter_name", "text", (col) => col.notNull())
    .addColumn("value_at_snapshot", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.defaultTo("CURRENT_TIMESTAMP"))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("snapshots").execute();
}
