import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import pc from "picocolors";

const execAsync = promisify(exec);

const DEBOUNCE_MS = 500; // Wait 500ms after last change before processing
const COOLDOWN_MS = 3000; // Ignore changes for 3s after we generate/write
const IGNORED_FILES = new Set(["schema.ts"]); // Files we generate, ignore changes to these

export class PluginWatcher {
  private pluginName: string;
  private pluginDir: string;
  private isGenerating = false;
  private watchers: FSWatcher[] = [];
  private debounceTimer: Timer | null = null;
  private pendingChanges = new Set<string>();
  private lastGenerationTime = 0;
  private lastIndexWriteTime = 0;

  constructor(name: string) {
    this.pluginName = name;
    this.pluginDir = join(process.cwd(), "plugins", name);
  }

  private scheduleProcessing() {
    // Clear existing timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Schedule processing after debounce period
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.processChanges();
    }, DEBOUNCE_MS);
  }

  private async processChanges() {
    // Check cooldown - ignore if we recently generated
    const now = Date.now();
    if (now - this.lastGenerationTime < COOLDOWN_MS) {
      this.pendingChanges.clear();
      return;
    }

    if (this.isGenerating || this.pendingChanges.size === 0) {
      return;
    }

    // Copy and clear pending changes
    const changes = new Set(this.pendingChanges);
    this.pendingChanges.clear();

    // Determine what to regenerate
    const hasMigrationChanges = Array.from(changes).some(f => f.startsWith("migrations/"));
    const hasIndexChange = changes.has("index.ts");

    if (hasMigrationChanges) {
      await this.triggerGenTypes();
    } else if (hasIndexChange) {
      await this.triggerGenRegistry();
    }
  }

  stop() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges.clear();
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
      const watcher = watch(migrationsDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (!filename.endsWith(".ts")) return;

        // Add to pending changes and schedule processing
        this.pendingChanges.add(`migrations/${filename}`);
        this.scheduleProcessing();
      });
      this.watchers.push(watcher);
    }

    // Watch plugin directory for index.ts changes
    const indexWatcher = watch(this.pluginDir, async (eventType, filename) => {
      if (!filename) return;

      // Ignore generated files
      if (IGNORED_FILES.has(filename)) return;

      if (filename === "index.ts") {
        // Check if this is a self-triggered change
        const now = Date.now();
        if (now - this.lastIndexWriteTime < COOLDOWN_MS) {
          return; // Ignore - we just wrote to this file
        }

        // Add to pending changes and schedule processing
        this.pendingChanges.add("index.ts");
        this.scheduleProcessing();
      }
    });
    this.watchers.push(indexWatcher);
  }
  
  private async triggerGenTypes() {
    if (this.isGenerating) return;
    this.isGenerating = true;
    this.lastGenerationTime = Date.now();

    console.log(pc.yellow(`\n[Change] Migration changes detected.`));
    try {
      console.log(pc.blue("   ⟳ Regenerating schema..."));
      await execAsync(`bun scripts/generate-types.ts ${this.pluginName}`);
      console.log(pc.green("   ✔ Schema updated."));

      // Auto-update index.ts to use the schema if it exists
      await this.enableSchemaInIndex();

      // Update generation time after all writes are done
      this.lastGenerationTime = Date.now();
    } catch (e) {
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
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
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
        // Mark that we're about to write to index.ts to prevent self-triggered loops
        this.lastIndexWriteTime = Date.now();
        await writeFile(indexPath, content);
        console.log(pc.green("   ✔ index.ts updated to use schema."));

        // Trigger registry update since index.ts changed
        await execAsync("bun scripts/generate-registry.ts");
        console.log(pc.green("   ✔ Registry updated."));

        // Update timestamps after all writes
        this.lastIndexWriteTime = Date.now();
        this.lastGenerationTime = Date.now();
      }
    } catch (e) {
      // Silently ignore if we can't update
    }
  }

  private async triggerGenRegistry() {
    if (this.isGenerating) return;
    this.isGenerating = true;
    this.lastGenerationTime = Date.now();

    console.log(pc.yellow(`\n[Change] Plugin definition (index.ts) detected.`));
    try {
      console.log(pc.blue("   ⟳ Regenerating registry..."));
      await execAsync("bun scripts/generate-registry.ts");
      // Also generate server context on plugin changes!
      await execAsync("bun scripts/generate-server.ts");
      console.log(pc.green("   ✔ Registry & Server Context updated."));

      // Update generation time after all writes
      this.lastGenerationTime = Date.now();
    } catch (e) {
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
    const watcher = new PluginWatcher(pluginName);
    watcher.start();

    // Cleanup on exit signals
    const cleanup = () => {
        console.log(pc.dim("\nStopping watcher..."));
        watcher.stop();
        process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("exit", () => watcher.stop());
}
