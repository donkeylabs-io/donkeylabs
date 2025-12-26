import { Migrator, Kysely } from "kysely";

export const latestScript = async (migrator: Migrator, db: Kysely<any>, outFile: string) => {
  const { introspectDatabaseTypes } = await import("../codegen");
  const { error, results } = await migrator.migrateToLatest();

  if (error) {
    console.error("Error during migration:", error);
    process.exit(1);
  }

  if (results && results.length > 0) {
    console.log("Migration successful. Applied migrations up:");
    results.forEach((migration) => {
      console.log(`- ${migration.migrationName} ^`);
    });

    await introspectDatabaseTypes(db, outFile);
  } else {
    console.log("No migrations to apply.");
  }
};
