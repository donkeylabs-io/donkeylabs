import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Remove duplicate keys before creating unique index
  // Keep only the most recent entry (highest id) for each key
  // Using NOT EXISTS with correlated subquery is more efficient than NOT IN
  // as it can use the index and stops early
  await sql`
    DELETE FROM cache AS c1
    WHERE EXISTS (
      SELECT 1 FROM cache AS c2
      WHERE c2.key = c1.key AND c2.id > c1.id
    )
  `.execute(db);

  // Add unique index on key column to enable atomic upserts
  // This prevents race conditions in rate limiting
  await db.schema.createIndex("cache_key_unique").on("cache").column("key").unique().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("cache_key_unique").execute();
}
