import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { buildInstrumentedDB } from "../instrumentation";
import { serverStats } from "../../stats";
import type { Kysely } from "kysely";

type InstrumentedTables = {
  instrumented: {
    id: number;
    value: string;
  };
};

let db: Kysely<InstrumentedTables> | undefined;

beforeEach(() => {
  serverStats.resetStats();
});

afterAll(async () => {
  if (db) {
    await db.schema.dropTable("instrumented").ifExists().execute();
    await db.destroy();
  }
});

describe("buildInstrumentedDB", () => {
  it("records query metrics while executing statements", async () => {
    db = buildInstrumentedDB<InstrumentedTables>(undefined);

    await db.schema
      .createTable("instrumented")
      .ifNotExists()
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("value", "text")
      .execute();

    await db.insertInto("instrumented").values({ value: "hello" } as any).execute();
    await db.selectFrom("instrumented").selectAll().execute();

    const metrics = serverStats.getDbMetrics();
    expect(metrics.queryCount).toBeGreaterThan(0);
    expect(metrics.totalQueryTime).toBeGreaterThanOrEqual(0);
  });
});
