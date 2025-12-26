import { afterAll, describe, expect, it } from "bun:test";
import { buildDB, paginationData, tableCount } from "../index";
import { Kysely } from "kysely";

type TestTables = {
  items: {
    id: number;
    status: string;
  };
};

let db: Kysely<TestTables> | undefined;

async function ensureDatabase() {
  if (!db) {
    db = buildDB<TestTables>(undefined);
    await db.schema
      .createTable("items")
      .ifNotExists()
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("status", "text", (col) => col.notNull())
      .execute();
  }

  await db!.deleteFrom("items").execute();
  await db!
    .insertInto("items")
    .values([
      { status: "active" },
      { status: "inactive" },
      { status: "active" },
    ] as any)
    .execute();
}

afterAll(async () => {
  if (db) {
    await db.schema.dropTable("items").ifExists().execute();
    await db.destroy();
  }
});

describe("database utilities", () => {
  it("counts rows with optional filters", async () => {
    await ensureDatabase();

    const total = await tableCount(db!, "items");
    expect(total).toBe(3);

    const active = await tableCount(db!, "items", "status = 'active'");
    expect(active).toBe(2);
  });

  it("computes pagination metadata", async () => {
    await ensureDatabase();

    const query = db!.selectFrom("items");
    const pagination = await paginationData(query, 2);

    expect(pagination.pageSize).toBe(2);
    expect(pagination.pageCount).toBe(2);
    expect(pagination.resultCount).toBe(3);
  });
});
