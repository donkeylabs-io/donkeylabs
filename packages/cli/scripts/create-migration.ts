#!/usr/bin/env bun
/**
 * Create Migration Script (Non-Interactive)
 *
 * Usage:
 *   bun scripts/create-migration.ts <plugin> <migration_name>
 *
 * Examples:
 *   bun scripts/create-migration.ts users add_avatar_column
 *   bun scripts/create-migration.ts orders add_shipping_address
 */

import { readdir, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";

function printUsage() {
  console.log(`
Usage: bun scripts/create-migration.ts <plugin> <migration_name>

Arguments:
  plugin           Name of the plugin
  migration_name   Name for the migration (use snake_case)

Examples:
  bun scripts/create-migration.ts users add_avatar_column
  bun scripts/create-migration.ts orders add_shipping_address
`);
}

async function main() {
  const args = Bun.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const [plugin, migrationName] = args;

  if (!plugin || !migrationName) {
    console.error("Error: Both plugin name and migration name are required");
    printUsage();
    process.exit(1);
  }

  // Validate migration name
  if (!/^[a-z0-9_]+$/.test(migrationName)) {
    console.error("Error: Migration name must use lowercase letters, numbers, and underscores only");
    process.exit(1);
  }

  // Determine migrations directory
  const cwd = process.cwd();
  const migrationsDir = join(cwd, "plugins", plugin, "migrations");

  // Check if plugin exists
  const pluginDir = join(cwd, "plugins", plugin);
  if (!existsSync(pluginDir)) {
    console.error(`Error: Plugin '${plugin}' does not exist`);
    console.error(`Expected directory: ${pluginDir}`);
    process.exit(1);
  }

  // Ensure migrations directory exists
  if (!existsSync(migrationsDir)) {
    await mkdir(migrationsDir, { recursive: true });
    console.log(`Created migrations directory: ${migrationsDir}`);
  }

  // Get next migration number
  let nextNum = 1;
  try {
    const files = await readdir(migrationsDir);
    const nums = files
      .map((f) => parseInt(f.split("_")[0] || "", 10))
      .filter((n) => !isNaN(n));
    if (nums.length > 0) {
      nextNum = Math.max(...nums) + 1;
    }
  } catch {}

  const filename = `${String(nextNum).padStart(3, "0")}_${migrationName}.ts`;
  const filepath = join(migrationsDir, filename);

  const content = `import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Add your migration here
  // Examples:
  //
  // Create table:
  // await db.schema
  //   .createTable("table_name")
  //   .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
  //   .addColumn("name", "text", (col) => col.notNull())
  //   .execute();
  //
  // Add column:
  // await db.schema
  //   .alterTable("table_name")
  //   .addColumn("new_column", "text")
  //   .execute();
  //
  // Create index:
  // await db.schema
  //   .createIndex("index_name")
  //   .on("table_name")
  //   .column("column_name")
  //   .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse the migration
  // Examples:
  //
  // Drop table:
  // await db.schema.dropTable("table_name").execute();
  //
  // Drop column:
  // await db.schema
  //   .alterTable("table_name")
  //   .dropColumn("new_column")
  //   .execute();
  //
  // Drop index:
  // await db.schema.dropIndex("index_name").execute();
}
`;

  await writeFile(filepath, content);
  console.log(`Created: plugins/${plugin}/migrations/${filename}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Edit the migration file to add your schema changes`);
  console.log(`  2. Run: bun scripts/generate-types.ts ${plugin}`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
