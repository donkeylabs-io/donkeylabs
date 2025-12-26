import { Migrator, Kysely } from "kysely";

export const down = async (migrator: Migrator, db: Kysely<any>, outFile: string) => {
  const { introspectDatabaseTypes } = await import("../codegen");

  const { error, results } = await migrator.migrateDown();

  if (error) {
    console.error("Error during migration:", error);
    process.exit(1);
  }

  console.log("Results:", results);

  if (results && results.length > 0) {
    console.log("Migration successful. Applied migrations down:");
    results.forEach((migration) => {
      console.log(`- ${migration.migrationName} V`);
    });

    await introspectDatabaseTypes(db, outFile);
  } else {
    console.log("No migrations to apply.");
  }
};
