// scripts/generate-types.ts
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { PluginManager, type CoreServices } from "../core";
import { generate, KyselyBunSqliteDialect } from "kysely-codegen";
import { parseArgs } from "util";
import {
  createLogger,
  createCache,
  createEvents,
  createCron,
  createJobs,
  createSSE,
  createRateLimiter,
  createErrors,
} from "../core/index";

// Parse CLI args
const { values, positionals } = parseArgs({
  args: Bun.argv,
  options: {
    out: {
      type: 'string',
    },
  },
  strict: true,
  allowPositionals: true,
});

const pluginName = positionals[2]; // bun run scripts/gen.ts <plugin>

async function main() {
  if (!pluginName) {
    console.error("Usage: bun run scripts/generate-types.ts <plugin-name> [--out <path>]");
    process.exit(1);
  }

  console.log(`Generating types for plugin: ${pluginName}...`);

  // 1. Setup Temp DB
  const dbPath = `temp_codegen_${pluginName}.db`;
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(dbPath) }),
  });

  // 2. Run Migrations
  try {
    const pluginModule = await import(`../plugins/${pluginName}/index.ts`);
    const pluginObj = Object.values(pluginModule).find((e: any) => e?.name === pluginName);
    
    if (!pluginObj) throw new Error("Plugin object not found (must export object with 'name' property)");

    // Create minimal core services for migration
    const logger = createLogger({ level: "warn" });
    const cache = createCache();
    const events = createEvents();
    const cron = createCron();
    const jobs = createJobs({ events });
    const sse = createSSE();
    const rateLimiter = createRateLimiter();
    const errors = createErrors();

    const core: CoreServices = {
      db,
      config: {},
      logger,
      cache,
      events,
      cron,
      jobs,
      sse,
      rateLimiter,
      errors,
    };

    const manager = new PluginManager(core);
    manager.register(pluginObj as any); 
    await manager.migrate();

    // 3. Run Codegen
    const outPath = values.out || join("plugins", pluginName, "schema.ts");
    console.log(`Running kysely-codegen -> ${outPath}`);

    await generate({
        db, 
        outFile: outPath,
        dialect: new KyselyBunSqliteDialect(),
    });

  } catch (error) {
      console.error("Error during generation:", error);
      process.exit(1);
  } finally {
      // 4. Cleanup
      await db.destroy();
      try {
        await unlink(dbPath);
      } catch {}
      console.log("Done.");
  }
}

main();
