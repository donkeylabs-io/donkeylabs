import { Kysely, Migrator, FileMigrationProvider } from "kysely";
import { sql } from "kysely";
import type { SelectQueryBuilder } from "kysely";

import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database as Sqlite } from "bun:sqlite";
import fs from "fs/promises";
import path from "path";

export const buildDB = <DB>(storageDir: string | undefined) => {
  return new Kysely<DB>({
    dialect: new BunSqliteDialect({
      database: new Sqlite(storageDir, { create: true }),
    }),
  });
};

// Database managed by kysely in memory for testing

export const buildMigrator = <DB>(db: Kysely<DB>, migrationsDir: string) =>
  new Migrator({
    db: db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: migrationsDir,
    }),
  });

type TableName<T> = keyof T;

export const tableCount = async <DB extends Record<string, any>>(
  db: Kysely<DB>,
  table: TableName<DB>,
  rawSqlWhere?: string,
): Promise<number> => {
  // @ts-ignore
  let query = db.selectFrom(table).select(db.fn.count("id").as("count"));

  if (rawSqlWhere) {
    // @ts-ignore
    query = query.where(sql.raw(rawSqlWhere));
  }

  // @ts-ignore
  const [{ count }] = await query.execute();
  return parseInt(`${count}`);
};

export const paginationData = async <DB>(
  queryBuilder: SelectQueryBuilder<DB, any, object>,
  pageSize: number = 15,
  db?: Kysely<DB>,
): Promise<{ pageSize: number; pageCount: number; resultCount: number }> => {
  let count: number;

  if (db) {
    // Use a subquery to correctly count results even with GROUP BY clauses
    const result = await sql<{ count: number }>`SELECT count(*) as count FROM (${queryBuilder}) as subquery`.execute(
      db,
    );
    count = Number(result.rows[0]?.count ?? 0);
  } else {
    // Fallback: use simple count (may not work correctly with GROUP BY)
    // @ts-ignore
    const result = await queryBuilder.select(sql<number>`count(*)`.as("count")).executeTakeFirst();
    count = Number((result as any)?.count ?? 0);
  }

  return {
    pageSize,
    pageCount: Math.ceil(count / pageSize),
    resultCount: count,
  };
};

export * from "./scripts";
