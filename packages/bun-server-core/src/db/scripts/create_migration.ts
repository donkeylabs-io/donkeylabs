import fs from "fs/promises";
import path from "path";
import readline from "readline/promises";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const timestamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0];

const defaultContent = `import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Add migration code here
}

export async function down(db: Kysely<any>): Promise<void> {
  // Add rollback code here
}
`;

export const createMigrationScript = async (migrationsDir: string) => {
  const migrationName = await rl.question("Enter migration name: ");
  const filename = `${timestamp}_${migrationName.replace(/\s+/g, "_")}.ts`;

  await fs.writeFile(path.join(migrationsDir, filename), defaultContent);
  console.log(`Created new migration: ${filename}`);
  rl.close();
};
