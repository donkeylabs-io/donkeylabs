import prompts from "prompts";
import pc from "picocolors";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";

const execAsync = promisify(exec);

// ============================================
// Non-Interactive Mode (AI-Friendly)
// ============================================

interface NonInteractiveOptions {
  name: string;
  schema?: boolean;
  config?: boolean;
  deps?: string[];
  handlers?: boolean;
  middleware?: boolean;
}

export async function createPluginNonInteractive(options: NonInteractiveOptions): Promise<{ name: string }> {
  const { name, schema = false, deps = [] } = options;
  const pluginsDir = join(process.cwd(), "plugins");
  const pluginPath = join(pluginsDir, name);

  // Validation
  if (!name) throw new Error("Plugin name is required");
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Use lowercase letters, numbers, and hyphens only");
  if (existsSync(pluginPath)) throw new Error(`Plugin '${name}' already exists`);

  const PascalName = name.split("-").map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join("");

  console.log(`Creating plugin: ${name}...`);

  // Create directories
  await mkdir(pluginPath, { recursive: true });
  if (schema) {
    await mkdir(join(pluginPath, "migrations"), { recursive: true });
  }

  // Create index.ts
  const indexContent = generateIndexFile(name, PascalName, schema, deps);
  await writeFile(join(pluginPath, "index.ts"), indexContent);
  console.log(`  Created index.ts`);

  // Create initial migration (if has schema)
  if (schema) {
    const migrationContent = generateMigrationFile(name);
    await writeFile(join(pluginPath, "migrations", "001_init.ts"), migrationContent);
    console.log(`  Created migrations/001_init.ts`);
  }

  console.log(`Plugin '${name}' created!`);

  // Update local registry types
  console.log("Updating registry...");
  try {
    await execAsync("bun scripts/generate-registry.ts");
    console.log("Done!");
  } catch (e: any) {
    console.error(`Warning: Could not update registry: ${e.message}`);
  }

  return { name };
}

interface PluginInfo {
    name: string;
    source: "local" | "global";
}

async function getAvailablePlugins(): Promise<PluginInfo[]> {
    const plugins: PluginInfo[] = [];
    const pluginsDir = join(process.cwd(), "plugins");

    // Get local plugins
    try {
        const files = await readdir(pluginsDir);
        for (const f of files) {
            if (!f.startsWith(".")) {
                plugins.push({ name: f, source: "local" });
            }
        }
    } catch {}

    // Get global plugins
    try {
        const { GlobalRegistry } = await import("./global-registry.ts");
        const reg = new GlobalRegistry();
        const globalPlugins = await reg.getAvailablePlugins();
        for (const p of globalPlugins) {
            // Only add if not already in local
            if (!plugins.some(lp => lp.name === p.name)) {
                plugins.push({ name: p.name, source: "global" });
            }
        }
    } catch {}

    return plugins;
}

export async function createPluginInteractive(): Promise<{ name: string } | null> {
    console.log(pc.bold("  Create New Plugin\n"));

    const pluginsDir = join(process.cwd(), "plugins");
    const availablePlugins = await getAvailablePlugins();

    // 1. Get plugin name
    const nameRes = await prompts({
        type: "text",
        name: "name",
        message: "Plugin name:",
        validate: (value) => {
            if (!value) return "Name is required";
            if (existsSync(join(pluginsDir, value))) return "Plugin already exists locally";
            if (!/^[a-z0-9-]+$/.test(value)) return "Use lowercase letters, numbers, and hyphens only";
            return true;
        }
    });

    if (!nameRes.name) {
        console.log(pc.yellow("Cancelled."));
        return null;
    }

    // 2. Ask about database schema
    const schemaRes = await prompts({
        type: "confirm",
        name: "hasSchema",
        message: "Will this plugin have database tables?",
        initial: false
    });

    if (schemaRes.hasSchema === undefined) {
        console.log(pc.yellow("Cancelled."));
        return null;
    }

    // 3. Select dependencies (if any plugins exist)
    let dependencies: string[] = [];
    if (availablePlugins.length > 0) {
        const depRes = await prompts({
            type: "multiselect",
            name: "deps",
            message: "Dependencies " + pc.gray("(space to select)"),
            choices: availablePlugins.map(p => ({
                title: p.source === "global"
                    ? `${p.name} ${pc.blue("(global)")}`
                    : `${p.name} ${pc.green("(local)")}`,
                value: p.name
            })),
            instructions: false,
            hint: ""
        });
        dependencies = depRes.deps || [];

        // Check if any global dependencies need to be installed
        const globalDeps = dependencies.filter(d =>
            availablePlugins.find(p => p.name === d && p.source === "global")
        );

        if (globalDeps.length > 0) {
            console.log(pc.yellow(`\nInstalling global dependencies: ${globalDeps.join(", ")}`));
            const { GlobalRegistry } = await import("./global-registry.ts");
            const reg = new GlobalRegistry();

            for (const dep of globalDeps) {
                const globalPlugins = await reg.getAvailablePlugins();
                const plugin = globalPlugins.find(p => p.name === dep);
                if (plugin) {
                    const dest = join(pluginsDir, dep);
                    try {
                        await reg.install(dep, plugin.latest, dest);
                    } catch (e: any) {
                        console.error(pc.red(`Failed to install ${dep}: ${e.message}`));
                    }
                }
            }
        }
    }

    const { name, hasSchema } = { name: nameRes.name, hasSchema: schemaRes.hasSchema };
    const pluginPath = join(pluginsDir, name);
    const PascalName = name.split("-").map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join("");

    console.log(pc.gray(`\nScaffolding plugin: ${name}...`));

    // 4. Create directories
    await mkdir(pluginPath, { recursive: true });
    if (hasSchema) {
        await mkdir(join(pluginPath, "migrations"), { recursive: true });
    }

    // 5. Create index.ts
    const depsVal = JSON.stringify(dependencies);
    const indexContent = generateIndexFile(name, PascalName, hasSchema, dependencies);
    await writeFile(join(pluginPath, "index.ts"), indexContent);

    // 6. Create initial migration (if has schema)
    if (hasSchema) {
        const migrationContent = generateMigrationFile(name);
        await writeFile(join(pluginPath, "migrations", "001_init.ts"), migrationContent);
        console.log(pc.gray(`  Created migrations/001_init.ts`));
    }

    console.log(pc.gray(`  Created index.ts`));
    console.log(pc.green(`\n✔ Plugin '${name}' created!`));

    // 7. Publish to global registry (source of truth)
    console.log(pc.gray("\nPublishing to global registry..."));
    try {
        const { GlobalRegistry } = await import("./global-registry.ts");
        const reg = new GlobalRegistry();
        await reg.publish(name, pluginPath, "1.0.0");
    } catch (e: any) {
        console.error(pc.yellow(`Warning: Could not publish to global: ${e.message}`));
    }

    // 8. Update local registry types
    console.log(pc.gray("Updating local registry..."));
    try {
        await execAsync("bun scripts/generate-registry.ts");
        console.log(pc.green("✔ Done!"));
    } catch (e: any) {
        console.error(pc.yellow("Warning: Could not update registry."));
    }

    // 9. Show next steps
    console.log(pc.cyan("\n  Next steps:\n"));
    if (hasSchema) {
        console.log(pc.white(`  1. Edit ${pc.bold(`plugins/${name}/migrations/001_init.ts`)}`));
        console.log(pc.gray(`     Add your CREATE TABLE statements\n`));
        console.log(pc.white(`  2. Run ${pc.bold(`bun scripts/generate-types.ts ${name}`)}`));
        console.log(pc.gray(`     Generates schema.ts from migrations\n`));
    } else {
        console.log(pc.white(`  1. Edit ${pc.bold(`plugins/${name}/index.ts`)}`));
        console.log(pc.gray(`     Add your plugin service logic\n`));
    }
    console.log(pc.gray(`  When ready, publish new version via CLI → "Publish Plugin"\n`));

    // 10. Ask if user wants to watch the plugin
    const watchRes = await prompts({
        type: "confirm",
        name: "watch",
        message: "Start watching this plugin for changes?",
        initial: true
    });

    if (watchRes.watch) {
        return { name }; // Signal to start watcher
    }

    return null;
}

function generateIndexFile(name: string, PascalName: string, hasSchema: boolean, dependencies: string[]): string {
    const depsVal = JSON.stringify(dependencies);

    // Note: schema.ts doesn't exist yet - it will be generated after migrations run
    const schemaComment = hasSchema
        ? `// After running migrations, import your schema:
// import type { DB as ${PascalName}Schema } from "./schema";
// Then add .withSchema<${PascalName}Schema>() below`
        : "";

    const withSchemaComment = hasSchema
        ? `  // .withSchema<${PascalName}Schema>()  // Uncomment after generating schema.ts`
        : "";

    return `import { createPlugin } from "../../core";
${schemaComment}

export interface ${PascalName}Service {
  hello(): string;
}

export const ${name}Plugin = createPlugin
${withSchemaComment}
  .define({
    name: "${name}",
    version: "1.0.0",
    dependencies: ${depsVal} as const,

    service: async (ctx) => {
      console.log("[${PascalName}Plugin] Initializing...");
      ${dependencies.length > 0 ? `\n      // Access dependencies:\n      // const ${dependencies[0]} = ctx.deps.${dependencies[0]};` : ""}

      return {
        hello: () => "Hello from ${name}!"
      };
    }
  });
`;
}

function generateMigrationFile(name: string): string {
    return `import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("${name.replace(/-/g, "_")}")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("created_at", "text", (col) => col.defaultTo("CURRENT_TIMESTAMP"))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("${name.replace(/-/g, "_")}").execute();
}
`;
}

// ============================================
// CLI Entry Point
// ============================================

function printUsage() {
  console.log(`
Usage: bun scripts/create-plugin.ts [options]

Non-Interactive Mode (AI-friendly):
  --name <name>        Plugin name (required)
  --schema             Include database schema
  --deps <list>        Comma-separated dependencies

Interactive Mode:
  Run without arguments for guided prompts

Examples:
  bun scripts/create-plugin.ts --name analytics
  bun scripts/create-plugin.ts --name orders --schema --deps auth,products
`);
}

// Allow running directly or importing
if (import.meta.main) {
  const args = Bun.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  // If no arguments, run interactive mode
  if (args.length === 0) {
    createPluginInteractive().catch(console.error);
  } else {
    // Parse arguments for non-interactive mode
    try {
      const { values } = parseArgs({
        args,
        options: {
          name: { type: "string" },
          schema: { type: "boolean", default: false },
          deps: { type: "string", default: "" },
          config: { type: "boolean", default: false },
          handlers: { type: "boolean", default: false },
          middleware: { type: "boolean", default: false },
        },
      });

      if (!values.name) {
        console.error("Error: --name is required");
        printUsage();
        process.exit(1);
      }

      const deps = values.deps ? values.deps.split(",").map(d => d.trim()).filter(Boolean) : [];

      createPluginNonInteractive({
        name: values.name,
        schema: values.schema,
        config: values.config,
        deps,
        handlers: values.handlers,
        middleware: values.middleware,
      }).catch((e) => {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      });
    } catch (e: any) {
      console.error(`Error parsing arguments: ${e.message}`);
      printUsage();
      process.exit(1);
    }
  }
}
