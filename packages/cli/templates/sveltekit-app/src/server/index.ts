// Server entry for @donkeylabs/adapter-sveltekit
import { AppServer } from "@donkeylabs/server";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { demoPlugin } from "./plugins/demo";
import { workflowDemoPlugin } from "./plugins/workflow-demo";
import { authPlugin } from "./plugins/auth";
import { emailPlugin } from "./plugins/email";
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

// =============================================================================
// AUTH PLUGIN CONFIGURATION
// =============================================================================
// Choose your auth strategy:
//
// 1. SESSION (default) - Stateful, stores sessions in database
//    Best for: Web apps, server-rendered pages
//    server.registerPlugin(authPlugin());
//
// 2. JWT - Stateless tokens, no database lookup needed
//    Best for: Mobile apps, microservices, APIs
//    server.registerPlugin(authPlugin({
//      strategy: "jwt",
//      jwt: { secret: process.env.JWT_SECRET! },
//    }));
//
// 3. REFRESH-TOKEN - Short-lived access + long-lived refresh token
//    Best for: SPAs, mobile apps needing token refresh
//    server.registerPlugin(authPlugin({
//      strategy: "refresh-token",
//      jwt: {
//        secret: process.env.JWT_SECRET!,
//        accessExpiry: "15m",
//        refreshExpiry: "30d",
//      },
//      cookie: { httpOnly: true, secure: true },
//    }));
//
// =============================================================================

// Using default session strategy for this template
server.registerPlugin(authPlugin());

// Email plugin - supports Resend or console (for development)
// Configure with process.env.RESEND_API_KEY for production
server.registerPlugin(emailPlugin({
  provider: process.env.RESEND_API_KEY ? "resend" : "console",
  resend: process.env.RESEND_API_KEY ? { apiKey: process.env.RESEND_API_KEY } : undefined,
  from: process.env.EMAIL_FROM || "noreply@example.com",
  baseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:5173",
}));

server.registerPlugin(demoPlugin);
server.registerPlugin(workflowDemoPlugin);

// Register routes
server.use(authRouter);
server.use(demoRoutes);
server.use(exampleRouter);

// Handle CLI type generation (must be after routes are registered)
server.handleGenerateMode();
