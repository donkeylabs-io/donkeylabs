import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database as Sqlite } from "bun:sqlite";
import { syncPermissions } from "../scripts";

type PermissionTable = {
  permission: {
    id: number;
    name: string;
  };
};

let db: Kysely<PermissionTable> | undefined;

beforeEach(async () => {
  if (db) {
    await db.destroy();
  }
  db = new Kysely<PermissionTable>({
    dialect: new BunSqliteDialect({
      database: new Sqlite(":memory:"),
    }),
  });

  await db.schema
    .createTable("permission")
    .ifNotExists()
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull().unique())
    .execute();
});

afterAll(async () => {
  if (db) {
    await db.destroy();
    db = undefined;
  }
});

describe("syncPermissions", () => {
  it("inserts missing permissions and avoids duplicates", async () => {
    await syncPermissions(db!, false);
    const firstRun = await db!.selectFrom("permission").selectAll().execute();
    expect(firstRun.length).toBeGreaterThan(0);

    await syncPermissions(db!, false);
    const secondRun = await db!.selectFrom("permission").selectAll().execute();
    expect(secondRun.length).toBe(firstRun.length);
  });
});
