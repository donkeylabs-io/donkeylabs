import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";

export const db = new Kysely<any>({
  dialect: new BunSqliteDialect({
    database: new Database("app.db"),
  }),
});
