import { Kysely } from "kysely";
import { SqliteDialect } from "kysely";
import { Database as BunDatabase } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

const dbPath = process.env.DATABASE_URL || "./data/app.db";

// Ensure directory exists
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Kysely<any>({
  dialect: new SqliteDialect({
    database: new BunDatabase(dbPath),
  }),
});
