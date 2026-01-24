// Server entry for @donkeylabs/adapter-sveltekit
import { AppServer } from "@donkeylabs/server";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { demoPlugin } from "./plugins/demo";
import { workflowDemoPlugin } from "./plugins/workflow-demo";
import { authPlugin } from "./plugins/auth";
import demoRoutes from "./routes/demo";
import { exampleRouter } from "./routes/example";
import { authRouter } from "./routes/auth";

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
server.registerPlugin(authPlugin);  // Auth first - other plugins may depend on it
server.registerPlugin(demoPlugin);
server.registerPlugin(workflowDemoPlugin);

// Register routes
server.use(authRouter);
server.use(demoRoutes);
server.use(exampleRouter);

// Handle CLI type generation (must be after routes are registered)
server.handleGenerateMode();
