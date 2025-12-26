import { Migrator, Kysely } from "kysely";

export const up = async (migrator: Migrator, db: Kysely<any>, outFile: string) => {
  // dynamic import
  const { introspectDatabaseTypes } = await import("../codegen");

  const { error, results } = await migrator.migrateUp();

  if (error) {
    console.error("Error during migration:", error);
    process.exit(1);
  }

  console.log("Results:", results);

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
