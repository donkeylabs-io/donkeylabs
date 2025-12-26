import { Kysely, type LogEvent } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database as Sqlite } from "bun:sqlite";
import { serverStats } from "../stats";
import { logger } from "@donkeylabs/audit-logs";

// Create a database with built-in instrumentation
export function buildInstrumentedDB<DB = any>(storageDir: string | undefined): Kysely<DB> {
  return new Kysely<DB>({
    // @ts-ignore - Type compatibility fix for BunSqliteDialect
    dialect: new BunSqliteDialect({
      database: new Sqlite(storageDir, { create: true }),
    }),
    log: (event: LogEvent) => {
      // Track query performance for stats
      if (event.level === "query") {
        const duration = event.queryDurationMillis || 0;
        serverStats.trackDatabaseQuery(duration);

        // Log slow queries for debugging
        if (duration > 100) {
          logger.db.tag("SLOW").warn(`${duration}ms: ${event.query.sql.slice(0, 80)}...`);
        }
      }

      // Optional: log all queries in development
      if (Bun.env.STAGE === "dev") {
        // console.log("Executing query:", event.query.sql);
        // console.log("Query parameters:", event.query.parameters);
      }
    },
  });
}

// For backward compatibility - wraps an existing DB with instrumentation
export function addDatabaseInstrumentation<DB>(db: Kysely<DB>): Kysely<DB> {
  // For now, just return the original db since the real instrumentation
  // should happen at database creation time
  logger.db.warn("Database already created. Use buildInstrumentedDB() instead for full instrumentation.");
  return db;
}
