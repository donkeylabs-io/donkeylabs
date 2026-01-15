import { existsSync, watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import pc from "picocolors";

const execAsync = promisify(exec);

export class PluginWatcher {
  private pluginName: string;
  private pluginDir: string;
  private isGenerating = false;

  constructor(name: string) {
    this.pluginName = name;
    this.pluginDir = join(process.cwd(), "plugins", name);
  }

  async start() {
    if (!existsSync(this.pluginDir)) {
      console.error(pc.red(`❌ Plugin '${this.pluginName}' not found.`));
      return;
    }

    console.log(pc.cyan(pc.bold(`\n👀 Watching plugin: ${this.pluginName}`)));
    console.log(pc.gray(`   - Monitoring migrations/ -> gen:types`));
    console.log(pc.gray(`   - Monitoring index.ts    -> gen:registry`));

    // Watch migrations
    const migrationsDir = join(this.pluginDir, "migrations");
    if (existsSync(migrationsDir)) {
      watch(migrationsDir, { recursive: true }, async (eventType, filename) => {
        if (!filename) return;
        if (filename.endsWith(".ts")) {
           await this.triggerGenTypes(filename);
        }
      });
    }

    // Watch index.ts
    watch(this.pluginDir, async (eventType, filename) => {
        if (!filename) return;
        if (filename === "index.ts") {
            await this.triggerGenRegistry();
        }
    });
  }
  
  private async triggerGenTypes(file: string) {
      if (this.isGenerating) return;
      this.isGenerating = true;
      console.log(pc.yellow(`\n[Change] Migration ${file} detected.`));
      try {
          console.log(pc.blue("   ⟳ Regenerating schema..."));
          await execAsync(`bun scripts/generate-types.ts ${this.pluginName}`);
          console.log(pc.green("   ✔ Schema updated."));

          // Auto-update index.ts to use the schema if it exists
          await this.enableSchemaInIndex();
      } catch(e) {
          console.error(pc.red("   ❌ Error generating types:"), e);
      } finally {
          this.isGenerating = false;
      }
  }

  private async enableSchemaInIndex() {
      const indexPath = join(this.pluginDir, "index.ts");
      const schemaPath = join(this.pluginDir, "schema.ts");

      if (!existsSync(schemaPath)) return;

      try {
          let content = await readFile(indexPath, "utf-8");
          let updated = false;

          // Get PascalCase name for the schema type
          const PascalName = this.pluginName
              .split("-")
              .map(s => s.charAt(0).toUpperCase() + s.slice(1))
              .join("");

          // Uncomment schema import if commented
          // Pattern: // import type { DB as XxxSchema } from "./schema";
          const importPattern = `// import type { DB as ${PascalName}Schema } from "./schema";`;
          if (content.includes(importPattern)) {
              content = content.replace(
                  importPattern,
                  `import type { DB as ${PascalName}Schema } from "./schema";`
              );
              updated = true;
          }

          // Uncomment .withSchema if commented
          // Pattern:   // .withSchema<XxxSchema>()  // Uncomment after generating schema.ts
          const withSchemaPattern = `  // .withSchema<${PascalName}Schema>()  // Uncomment after generating schema.ts`;
          if (content.includes(withSchemaPattern)) {
              content = content.replace(
                  withSchemaPattern,
                  `  .withSchema<${PascalName}Schema>()`
              );
              updated = true;
          }

          // Also remove the instruction comment block if present
          const instructionBlock = `// After running migrations, import your schema:\n// import type { DB as ${PascalName}Schema } from "./schema";\n// Then add .withSchema<${PascalName}Schema>() below`;
          if (content.includes(instructionBlock)) {
              content = content.replace(
                  instructionBlock,
                  `import type { DB as ${PascalName}Schema } from "./schema";`
              );
              updated = true;
          }

          if (updated) {
              await writeFile(indexPath, content);
              console.log(pc.green("   ✔ index.ts updated to use schema."));

              // Trigger registry update since index.ts changed
              await execAsync("bun scripts/generate-registry.ts");
              console.log(pc.green("   ✔ Registry updated."));
          }
      } catch (e) {
          // Silently ignore if we can't update
      }
  }

  private async triggerGenRegistry() {
      if (this.isGenerating) return;
      this.isGenerating = true;
      console.log(pc.yellow(`\n[Change] Plugin definition (index.ts) detected.`));
      try {
          console.log(pc.blue("   ⟳ Regenerating registry..."));
          await execAsync("bun scripts/generate-registry.ts");
          // Also generate server context on plugin changes!
          await execAsync("bun scripts/generate-server.ts");
          console.log(pc.green("   ✔ Registry & Server Context updated."));
      } catch(e) {
         console.error(pc.red("   ❌ Error generating registry:"), e);
      } finally {
          this.isGenerating = false;
      }
  }
}

// Standalone Usage
if (import.meta.main) {
    const pluginName = process.argv[2];
    if (!pluginName) {
        console.error("Usage: bun scripts/watcher.ts <plugin-name>");
        process.exit(1);
    }
    new PluginWatcher(pluginName).start();
}
