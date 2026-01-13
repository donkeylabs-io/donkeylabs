#!/usr/bin/env bun
/**
 * Create Server Script (Non-Interactive)
 *
 * Usage:
 *   bun scripts/create-server.ts [options]
 *
 * Options:
 *   --name <filename>    Output filename (default: server.ts)
 *   --port <number>      Server port (default: 3000)
 *   --plugins <list>     Comma-separated plugins to include
 *
 * Examples:
 *   bun scripts/create-server.ts --name app.ts --port 8080
 *   bun scripts/create-server.ts --name api.ts --port 3000 --plugins auth,users,orders
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

function printUsage() {
  console.log(`
Usage: bun scripts/create-server.ts [options]

Options:
  --name <filename>    Output filename (default: server.ts)
  --port <number>      Server port (default: 3000)
  --plugins <list>     Comma-separated plugins to include
  --force              Overwrite existing file

Examples:
  bun scripts/create-server.ts --name app.ts --port 8080
  bun scripts/create-server.ts --name api.ts --port 3000 --plugins auth,users,orders
`);
}

function generateServerCode(filename: string, port: number, plugins: string[]): string {
  const pluginImports = plugins
    .map((p) => `import { ${p}Plugin } from "./plugins/${p}";`)
    .join("\n");

  const pluginRegistrations = plugins
    .map((p) => `server.registerPlugin(${p}Plugin);`)
    .join("\n");

  // Determine which plugin to use as router namespace (first one, or "api" if none)
  const routerNamespace = plugins[0] || "api";

  return `/// <reference path="./registry.d.ts" />
import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { AppServer } from "./server";
import { createRouter } from "./router";
import { z } from "zod";
${pluginImports ? "\n" + pluginImports : ""}

// ==========================================
// Database Setup (Replace with real dialect)
// ==========================================

const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

// ==========================================
// Create Server
// ==========================================

const server = new AppServer({
  db,
  port: ${port},
});

// ==========================================
// Register Plugins
// ==========================================
${pluginRegistrations ? "\n" + pluginRegistrations : ""}

// ==========================================
// Define Routes
// ==========================================

const appRouter = createRouter("${routerNamespace}")
  .route("hello").typed({
    input: z.object({ name: z.string().optional() }),
    output: z.object({ message: z.string() }),
    handle: async (input, ctx) => {
      return { message: \`Hello, \${input.name || "World"}!\` };
    },
  })
  .route("status").raw({
    handle: async () => {
      return new Response("OK");
    },
  });

server.use(appRouter);

// ==========================================
// Start Server
// ==========================================

await server.start();

console.log(\`Server running at http://localhost:${port}\`);
console.log(\`Try: curl -X POST http://localhost:${port}/${routerNamespace}.hello -d '{"name": "World"}'\`);
`;
}

async function main() {
  const args = Bun.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  // Parse arguments
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string", default: "server.ts" },
      port: { type: "string", default: "3000" },
      plugins: { type: "string", default: "" },
      force: { type: "boolean", default: false },
    },
  });

  const filename = values.name!;
  const port = parseInt(values.port!, 10);
  const plugins = values.plugins
    ? values.plugins.split(",").map((p) => p.trim()).filter(Boolean)
    : [];
  const force = values.force;

  // Validate filename
  if (!filename.endsWith(".ts")) {
    console.error("Error: Filename must end with .ts");
    process.exit(1);
  }

  // Validate port
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error("Error: Invalid port number");
    process.exit(1);
  }

  const filepath = join(process.cwd(), filename);

  // Check if file exists
  if (existsSync(filepath) && !force) {
    console.error(`Error: File '${filename}' already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  // Generate and write server file
  const serverCode = generateServerCode(filename, port, plugins);
  await writeFile(filepath, serverCode);

  console.log(`Created: ${filename}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Run: bun run ${filename}`);
  console.log(`  2. Test: curl -X POST http://localhost:${port}/${plugins[0] || "api"}.hello -d '{"name": "World"}'`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
