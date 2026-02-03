import { AppServer, type LogLevel } from "@donkeylabs/server";
import { db } from "./db";

// Global type declaration for hot reload guard
declare global {
  var __donkeylabsServerStarted__: boolean | undefined;
}

const PORT = parseInt(process.env.PORT || "3000");

// Plugins
import { usersPlugin } from "./plugins/users";

// Routes
import { apiRouter } from "./routes/api";

const server = new AppServer({
  port: PORT,
  db,
  
  // Production logging
  logger: {
    level: (process.env.LOG_LEVEL as LogLevel) || "info",
    format: process.env.NODE_ENV === "production" ? "json" : "pretty",
  },
  
  // Enable admin dashboard in development
  admin: process.env.NODE_ENV !== "production" ? { enabled: true } : undefined,
  
  // Cache
  cache: {
    defaultTtlMs: 300000,
    maxSize: 10000,
  },
});

// Register plugins
server.registerPlugin(usersPlugin);

// Register routes
server.use(apiRouter);

// Health check
server.onReady((ctx) => {
  ctx.core.logger.info("Server ready", { 
    port: PORT,
    plugins: ["users"],
  });
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await server.shutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await server.shutdown();
  process.exit(0);
});

// Export server for adapter
export { server };

// Guard against re-initialization on hot reload
if (!globalThis.__donkeylabsServerStarted__) {
  globalThis.__donkeylabsServerStarted__ = true;
  await server.start();
  console.log(`🚀 Server running at http://localhost:${PORT}`);
}
