/**
 * Plugin Command
 *
 * Plugin management commands
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import pc from "picocolors";
import prompts from "prompts";

export async function pluginCommand(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "create":
    case "new":
      await createPlugin(args[1]);
      break;

    case "list":
      await listPlugins();
      break;

    default:
      console.log(`
${pc.bold("Plugin Management")}

${pc.bold("Commands:")}
  ${pc.cyan("create <name>")}    Create a new plugin
  ${pc.cyan("list")}             List installed plugins

${pc.bold("Examples:")}
  donkeylabs plugin create auth
  donkeylabs plugin list
`);
  }
}

async function createPlugin(name?: string) {
  // Prompt for name if not provided
  if (!name) {
    const response = await prompts({
      type: "text",
      name: "name",
      message: "Plugin name:",
      validate: (v) =>
        /^[a-z][a-z0-9-]*$/.test(v) ||
        "Name must be lowercase alphanumeric with dashes",
    });
    name = response.name;
  }

  if (!name) {
    console.log(pc.yellow("Cancelled."));
    return;
  }

  // Ask for configuration
  const { hasSchema, hasDependencies } = await prompts([
    {
      type: "confirm",
      name: "hasSchema",
      message: "Does this plugin need a database schema?",
      initial: false,
    },
    {
      type: "confirm",
      name: "hasDependencies",
      message: "Does this plugin depend on other plugins?",
      initial: false,
    },
  ]);

  let dependencies: string[] = [];
  if (hasDependencies) {
    const { deps } = await prompts({
      type: "list",
      name: "deps",
      message: "Enter dependency names (comma-separated):",
      separator: ",",
    });
    dependencies = deps?.filter(Boolean) || [];
  }

  // Determine plugin directory
  const pluginDir = join(process.cwd(), "src/plugins", name);

  if (existsSync(pluginDir)) {
    console.log(pc.red(`Plugin directory already exists: ${pluginDir}`));
    return;
  }

  await mkdir(pluginDir, { recursive: true });

  // Generate plugin code
  const camelName = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const pascalName = camelName.charAt(0).toUpperCase() + camelName.slice(1);

  const schemaImport = hasSchema
    ? `import type { DB as ${pascalName}Schema } from "./schema";\n`
    : "";

  const schemaType = hasSchema ? `<${pascalName}Schema>()` : "";

  const depsLine =
    dependencies.length > 0
      ? `  dependencies: [${dependencies.map((d) => `"${d}"`).join(", ")}] as const,\n`
      : "";

  const pluginContent = `import { createPlugin } from "@donkeylabs/server";
${schemaImport}
export interface ${pascalName}Service {
  // Define your service interface here
  getData(): Promise<string>;
}

export const ${camelName}Plugin = createPlugin${hasSchema ? `\n  .withSchema${schemaType}` : ""}
  .define({
    name: "${name}",
    version: "1.0.0",
${depsLine}
    service: async (ctx): Promise<${pascalName}Service> => {
      console.log("[${pascalName}Plugin] Initializing...");
${
  dependencies.length > 0
    ? dependencies.map((d) => `      // Access ${d} via: ctx.deps.${d}`).join("\n") + "\n"
    : ""
}
      return {
        getData: async () => {
          return "Hello from ${name} plugin!";
        },
      };
    },
  });
`;

  await writeFile(join(pluginDir, "index.ts"), pluginContent);
  console.log(pc.green("  Created:"), `src/plugins/${name}/index.ts`);

  if (hasSchema) {
    // Create schema.ts
    const schemaContent = `// Database schema types for ${name} plugin
// Run \`bun run gen:types\` to regenerate from database

export interface DB {
  // Define your table interfaces here
  // Example:
  // ${name}: {
  //   id: Generated<number>;
  //   name: string;
  //   created_at: Generated<string>;
  // };
}
`;
    await writeFile(join(pluginDir, "schema.ts"), schemaContent);
    console.log(pc.green("  Created:"), `src/plugins/${name}/schema.ts`);

    // Create migrations directory
    await mkdir(join(pluginDir, "migrations"), { recursive: true });

    // Create initial migration
    const migrationContent = `import { Kysely } from "kysely";

export async function up(db: Kysely<any>) {
  // Create your tables here
  // await db.schema
  //   .createTable("${name}")
  //   .ifNotExists()
  //   .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
  //   .addColumn("name", "text", (col) => col.notNull())
  //   .addColumn("created_at", "text", (col) => col.defaultTo(sql\`CURRENT_TIMESTAMP\`))
  //   .execute();
}

export async function down(db: Kysely<any>) {
  // Drop your tables here
  // await db.schema.dropTable("${name}").ifExists().execute();
}
`;
    await writeFile(
      join(pluginDir, "migrations", "001_initial.ts"),
      migrationContent
    );
    console.log(
      pc.green("  Created:"),
      `src/plugins/${name}/migrations/001_initial.ts`
    );
  }

  console.log(`
${pc.bold(pc.green("Plugin created!"))}

${pc.bold("Next steps:")}
  1. Edit your plugin at ${pc.cyan(`src/plugins/${name}/index.ts`)}
${hasSchema ? `  2. Define your schema in ${pc.cyan(`src/plugins/${name}/schema.ts`)}\n  3. Add migrations in ${pc.cyan(`src/plugins/${name}/migrations/`)}\n` : ""}  ${hasSchema ? "4" : "2"}. Regenerate types: ${pc.cyan("donkeylabs generate")}
`);
}

async function listPlugins() {
  console.log(pc.yellow("Plugin listing not yet implemented."));
  console.log("Run 'donkeylabs generate' to see discovered plugins.");
}
