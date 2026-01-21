// Server entry for @donkeylabs/adapter-sveltekit
import { AppServer } from "@donkeylabs/server";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { demoPlugin } from "./plugins/demo";
import { workflowDemoPlugin } from "./plugins/workflow-demo";
import demoRoutes from "./routes/demo";

// Simple in-memory database
const db = new Kysely<{}>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

// Create server with auto type generation in dev mode
export const server = new AppServer({
  db,
  port: 0, // Port managed by adapter
  generateTypes: {
    output: "./src/lib/api.ts",
  },
});

// Register plugins
server.registerPlugin(demoPlugin);
server.registerPlugin(workflowDemoPlugin);

// Register routes
server.use(demoRoutes);

// Handle CLI type generation (must be after routes are registered)
server.handleGenerateMode();
