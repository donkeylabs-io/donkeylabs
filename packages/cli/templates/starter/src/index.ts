import { AppServer, createRouter } from "@donkeylabs/server";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { healthRouter } from "./routes/health";
import { statsPlugin } from "./plugins/stats";

// Simple in-memory database
const db = new Kysely<{}>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

const server = new AppServer({
  port: Number(process.env.PORT) || 3000,
  db,
  config: { env: process.env.NODE_ENV || "development" },
  generateTypes: {
    output: "./.@donkeylabs/server/api.ts",
    baseImport: 'import { ApiClientBase, type ApiClientOptions } from "@donkeylabs/server/client";',
    baseClass: "ApiClientBase",
    constructorSignature: "baseUrl: string, options?: ApiClientOptions",
    constructorBody: "super(baseUrl, options);",
    factoryFunction: `/**
 * Create an API client instance
 * @param baseUrl - The base URL of the API server
 */
export function createApi(baseUrl: string, options?: ApiClientOptions) {
  return new ApiClient(baseUrl, options);
}`,
  },
});

// Register plugins
server.registerPlugin(statsPlugin);

const api = createRouter("api");
// Register routes
api.router(healthRouter);

server.use(api);

// Handle DONKEYLABS_GENERATE mode for CLI type generation
if (process.env.DONKEYLABS_GENERATE === "1") {
  const routes = api.getRoutes().map((route) => ({
    name: route.name,
    handler: route.handler || "typed",
    inputType: route.input ? "(generated)" : undefined,
    outputType: route.output ? "(generated)" : undefined,
  }));
  console.log(JSON.stringify({ routes }));
  process.exit(0);
}

await server.start();
