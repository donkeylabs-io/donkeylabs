# Server Lifecycle Hooks

Lifecycle hooks allow you to execute code at specific points in the server's lifecycle: after initialization, during shutdown, and when errors occur.

## Overview

| Hook | When Called | Use Case |
|------|-------------|----------|
| `onReady` | After server starts, plugins initialized | Initialize app-specific services, warm caches |
| `onShutdown` | Before server stops | Cleanup connections, flush buffers |
| `onError` | On unhandled errors | Error reporting, alerts |

## onReady Hook

Called after the server is fully initialized, plugins are ready, and the server is accepting requests.

```typescript
import { AppServer } from "@donkeylabs/server";

const server = new AppServer({ db, port: 3000 });

server.onReady(async (ctx) => {
  console.log("Server is ready!");

  // Access all services
  ctx.core.logger.info("Server started", { port: 3000 });

  // Initialize app-specific classes
  const dashboard = new AdminDashboard(ctx.plugins.auth);
  await dashboard.initialize();

  // Register as a service for use in routes
  ctx.setService("dashboard", dashboard);

  // Warm caches
  await ctx.core.cache.set("config", await loadConfig());

  // Start background tasks
  ctx.core.cron.schedule("0 * * * *", async () => {
    await ctx.plugins.reports.generateHourly();
  });
});

await server.start();
```

### HookContext

The `onReady` callback receives a `HookContext` with:

```typescript
interface HookContext {
  /** Database instance (Kysely) */
  db: Kysely<any>;

  /** Core services */
  core: {
    logger: Logger;
    cache: Cache;
    events: Events;
    cron: Cron;
    jobs: Jobs;
    sse: SSE;
    rateLimiter: RateLimiter;
    errors: Errors;
    workflows: Workflows;
    processes: Processes;
  };

  /** Plugin services */
  plugins: Record<string, any>;

  /** Server configuration */
  config: Record<string, any>;

  /** Custom registered services */
  services: Record<string, any>;

  /** Register a service at runtime */
  setService: <T>(name: string, service: T) => void;
}
```

### Multiple onReady Handlers

You can register multiple handlers - they execute in registration order:

```typescript
server.onReady(async (ctx) => {
  // First: Initialize core dependencies
  await initializeDatabase(ctx.db);
});

server.onReady(async (ctx) => {
  // Second: Warm caches
  await warmCaches(ctx);
});

server.onReady(async (ctx) => {
  // Third: Start background jobs
  ctx.core.jobs.start();
});
```

## onShutdown Hook

Called when the server is shutting down. Receives the same `HookContext` as `onReady` for cleanup operations.

```typescript
server.onShutdown(async (ctx) => {
  ctx.core.logger.info("Server shutting down...");

  // Close external connections
  await ctx.services.externalApi.disconnect();

  // Flush pending data
  await ctx.services.analytics.flush();

  // Access plugins for cleanup
  await ctx.plugins.cache.flushAll();
});
```

### Graceful Shutdown

Enable automatic graceful shutdown on SIGTERM/SIGINT:

```typescript
server
  .onShutdown(async (ctx) => {
    await cleanup(ctx);
  })
  .enableGracefulShutdown(); // Handles SIGTERM and SIGINT

await server.start();
```

With `enableGracefulShutdown()`:
1. SIGTERM/SIGINT triggers shutdown
2. Server stops accepting new requests
3. Running requests complete (with timeout)
4. `onShutdown` handlers execute
5. Core services shut down (jobs, cron, SSE, processes)
6. Process exits

### Manual Shutdown

You can also trigger shutdown programmatically:

```typescript
// Somewhere in your code
await server.shutdown();
```

## onError Hook

Called when an unhandled error occurs during request handling or in background tasks.

```typescript
server.onError(async (error, ctx) => {
  // Log the error
  ctx?.core.logger.error("Unhandled error", {
    message: error.message,
    stack: error.stack,
  });

  // Send to error tracking service
  await errorTracker.capture(error, {
    tags: { environment: process.env.NODE_ENV },
  });

  // Alert on critical errors
  if (isCritical(error)) {
    await ctx?.plugins.notifications.sendAlert({
      channel: "ops",
      message: `Critical error: ${error.message}`,
    });
  }
});
```

**Note:** `ctx` may be undefined if the error occurs outside of a request context.

## SvelteKit Adapter Usage

Lifecycle hooks are especially useful with the SvelteKit adapter where you don't call `server.start()` directly:

```typescript
// src/server/index.ts
import { AppServer } from "@donkeylabs/server";
import { db } from "./db";

export const server = new AppServer({ db })
  .use(authPlugin)
  .use(usersPlugin)
  .router(usersRouter)

  // Initialize app-specific services after plugins are ready
  .onReady(async (ctx) => {
    // This runs when SvelteKit starts
    const nvr = new NVR(ctx.plugins.auth);
    await nvr.connect();
    ctx.setService("nvr", nvr);
  })

  // Cleanup when SvelteKit stops
  .onShutdown(async (ctx) => {
    await ctx.services.nvr?.disconnect();
  })

  // Handle errors
  .onError(async (error, ctx) => {
    await reportError(error);
  });

// Export for SvelteKit adapter
export type AppContext = typeof server extends AppServer<infer C> ? C : never;
```

## Complete Example

```typescript
import { AppServer, defineService } from "@donkeylabs/server";

// Define services
const cacheWarmerService = defineService("cacheWarmer", (ctx) => ({
  warm: async () => {
    const users = await ctx.db.selectFrom("users").selectAll().execute();
    for (const user of users) {
      await ctx.core.cache.set(`user:${user.id}`, user, 3600000);
    }
  },
}));

// Create server
const server = new AppServer({
  db,
  port: 3000,
  config: {
    environment: process.env.NODE_ENV,
  },
});

// Register plugins and services
server
  .use(authPlugin)
  .use(usersPlugin)
  .registerService(cacheWarmerService);

// Lifecycle hooks
server.onReady(async (ctx) => {
  ctx.core.logger.info("Server ready", {
    port: 3000,
    environment: ctx.config.environment,
  });

  // Warm caches on startup
  await ctx.services.cacheWarmer.warm();

  // Schedule periodic cache warming
  ctx.core.cron.schedule("*/30 * * * *", async () => {
    await ctx.services.cacheWarmer.warm();
  });
});

server.onShutdown(async (ctx) => {
  ctx.core.logger.info("Graceful shutdown initiated");
  // Cleanup happens automatically for core services
});

server.onError(async (error, ctx) => {
  console.error("Unhandled error:", error);
  // Report to monitoring service
});

// Enable graceful shutdown and start
server.enableGracefulShutdown();
await server.start();

console.log("Server running on http://localhost:3000");
```

## Best Practices

### 1. Keep onReady Fast
Don't block startup with heavy operations:

```typescript
// Good - async initialization
server.onReady(async (ctx) => {
  // Fire and forget for non-critical warmup
  ctx.services.cacheWarmer.warm().catch(console.error);
});

// Avoid - blocking startup
server.onReady(async (ctx) => {
  // This delays server readiness
  await heavyInitialization(); // 30 seconds...
});
```

### 2. Handle Shutdown Timeouts
Don't let shutdown hang indefinitely:

```typescript
server.onShutdown(async (ctx) => {
  const timeout = setTimeout(() => {
    ctx.core.logger.error("Shutdown timeout - forcing exit");
    process.exit(1);
  }, 30000);

  try {
    await gracefulCleanup(ctx);
  } finally {
    clearTimeout(timeout);
  }
});
```

### 3. Order Matters
Hooks execute in registration order. Register dependencies first:

```typescript
// First: Initialize the connection
server.onReady(async (ctx) => {
  const conn = await createConnection();
  ctx.setService("conn", conn);
});

// Second: Use the connection
server.onReady(async (ctx) => {
  await ctx.services.conn.ping(); // conn is available
});
```

### 4. Error Handling in Hooks
Errors in hooks can prevent startup or cleanup:

```typescript
server.onReady(async (ctx) => {
  try {
    await riskyOperation();
  } catch (error) {
    ctx.core.logger.error("Non-critical init failed", { error });
    // Don't rethrow - allow server to start
  }
});
```
