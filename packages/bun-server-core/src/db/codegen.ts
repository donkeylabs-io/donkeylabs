import { generate } from "kysely-codegen";
import { KyselyBunSqliteDialect } from "kysely-codegen";
import type { Kysely } from "kysely";
import { logger } from "@donkeylabs/audit-logs";

// NOTE: This file should ideally not be imported in production code
// It's meant for development/scripts only
// If you see this being imported, consider refactoring your imports

export const introspectDatabaseTypes = async (db: Kysely<any>, outFile: string) => {
  logger.db.info("Introspecting database types and writing to " + outFile);
  logger.auth.tag("");

  await generate({
    // @ts-ignore
    db: db,
    dialect: new KyselyBunSqliteDialect(),
    outFile,
  });
};
