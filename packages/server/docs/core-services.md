# Core Services

Core services are foundational utilities automatically available to all plugins and route handlers via `ctx.core`. They provide essential functionality like logging, caching, background jobs, and real-time communication.

## Available Services

| Service | Purpose | Default Backend |
|---------|---------|-----------------|
| [Logger](logger.md) | Structured logging with levels | Console |
| [Cache](cache.md) | Key-value store with TTL | In-memory (LRU) |
| [Events](events.md) | Pub/sub event system | In-memory |
| [Cron](cron.md) | Scheduled recurring tasks | In-memory |
| [Jobs](jobs.md) | Background job queue | In-memory |
| [External Jobs](external-jobs.md) | Jobs in any language | SQLite |
| [Processes](processes.md) | Long-running daemons | SQLite |
| [Workflows](workflows.md) | Multi-step orchestration | In-memory |
| [SSE](sse.md) | Server-Sent Events | In-memory |
| [RateLimiter](rate-limiter.md) | Request throttling | In-memory |
| [Errors](errors.md) | HTTP error factories | - |

---

## Accessing Core Services

### In Route Handlers

```ts
router.route("example").typed({
  handle: async (input, ctx) => {
    // All services available via ctx.core
    ctx.core.logger.info("Processing request", { input });

    const cached = await ctx.core.cache.get("key");

    await ctx.core.events.emit("request.processed", { input });

    return { success: true };
  },
});
```

### In Plugins

```ts
createPlugin.define({
  name: "myPlugin",
  service: async (ctx) => {
    // Schedule background work
    ctx.core.cron.schedule("0 * * * *", () => {
      ctx.core.logger.info("Hourly task running");
    });

    // Register job handler
    ctx.core.jobs.register("sendEmail", async (data) => {
      // Process in background
    });

    // Subscribe to events
    ctx.core.events.on("user.created", async (user) => {
      await ctx.core.jobs.enqueue("sendEmail", {
        to: user.email,
        template: "welcome",
      });
    });

    return { /* service methods */ };
  },
});
```

### In Middleware

```ts
createMiddleware(async (req, ctx, next, config) => {
  const start = Date.now();

  const response = await next();

  ctx.core.logger.info("Request completed", {
    method: req.method,
    path: new URL(req.url).pathname,
    duration: Date.now() - start,
    status: response.status,
  });

  return response;
});
```

---

## CoreServices Interface

```ts
interface CoreServices {
  db: Kysely<any>;           // Database connection
  config: Record<string, any>; // Global config

  // Utility services
  logger: Logger;
  cache: Cache;
  events: Events;
  cron: Cron;
  jobs: Jobs;
  sse: SSE;
  rateLimiter: RateLimiter;
  errors: Errors;            // HTTP error factories
}
```

---

## Configuration

Configure services when creating the server:

```ts
import { AppServer } from "./server";

const server = new AppServer({
  db: database,
  port: 3000,

  // Service configurations (all optional)
  logger: {
    level: "debug",        // "debug" | "info" | "warn" | "error"
    format: "pretty",      // "pretty" | "json"
  },

  cache: {
    defaultTtlMs: 300000,  // 5 minutes
    maxSize: 10000,        // LRU max items
  },

  events: {
    maxHistorySize: 1000,  // Event history limit
  },

  cron: {
    timezone: "UTC",       // For future use
  },

  jobs: {
    concurrency: 5,        // Max parallel jobs
    pollInterval: 1000,    // Check interval (ms)
    maxAttempts: 3,        // Default retries
  },

  sse: {
    heartbeatInterval: 30000,  // Keep-alive interval
    retryInterval: 3000,       // Client reconnect hint
  },

  rateLimiter: {
    // Uses in-memory by default
  },
});
```

---

## Service Lifecycle

### Startup

When `server.start()` is called:

1. All services are already initialized (in constructor)
2. Cron scheduler starts (`cron.start()`)
3. Job processor starts (`jobs.start()`)
4. Server begins accepting requests

### Shutdown

When `server.shutdown()` is called:

1. SSE connections are closed
2. Job processor stops (waits for active jobs)
3. Cron scheduler stops

```ts
// Graceful shutdown
process.on("SIGTERM", async () => {
  await server.shutdown();
  process.exit(0);
});
```

---

## Common Patterns

### Caching Database Queries

```ts
async function getUser(id: number, ctx: ServerContext) {
  return ctx.core.cache.getOrSet(
    `user:${id}`,
    () => ctx.db.selectFrom("users").where("id", "=", id).executeTakeFirst(),
    60000 // 1 minute TTL
  );
}
```

### Event-Driven Architecture

```ts
// In plugin: emit events
service: async (ctx) => ({
  async createOrder(data) {
    const order = await ctx.db.insertInto("orders").values(data).execute();
    await ctx.core.events.emit("order.created", order);
    return order;
  },
});

// In another plugin: react to events
service: async (ctx) => {
  ctx.core.events.on("order.created", async (order) => {
    await ctx.core.jobs.enqueue("sendOrderConfirmation", order);
    await ctx.core.jobs.enqueue("updateInventory", order.items);
  });
};
```

### Rate Limiting Routes

```ts
router.route("api").typed({
  handle: async (input, ctx) => {
    const result = await ctx.core.rateLimiter.check(
      `api:${ctx.ip}`,
      100,    // 100 requests
      60000   // per minute
    );

    if (!result.allowed) {
      throw new Error(`Rate limited. Retry in ${result.retryAfter}s`);
    }

    // Process request...
  },
});
```

### Real-Time Updates with SSE

```ts
// Route to establish SSE connection
router.route("subscribe").raw({
  handle: async (req, ctx) => {
    const { client, response } = ctx.core.sse.addClient();

    // Subscribe to user's channel
    ctx.core.sse.subscribe(client.id, `user:${ctx.user.id}`);

    return response;
  },
});

// Broadcast updates from anywhere
ctx.core.sse.broadcast(`user:${userId}`, "notification", {
  message: "You have a new message",
});
```

### Background Job Processing

```ts
// Register handler in plugin
ctx.core.jobs.register("processImage", async (data) => {
  const { imageId, operations } = data;
  // Heavy processing...
  return { processed: true };
});

// Enqueue from route handler
router.route("upload").typed({
  handle: async (input, ctx) => {
    const image = await saveImage(input.file);

    // Process in background
    await ctx.core.jobs.enqueue("processImage", {
      imageId: image.id,
      operations: ["resize", "optimize"],
    });

    return { imageId: image.id, status: "processing" };
  },
});
```

---

## Testing with Core Services

The test harness automatically creates all core services:

```ts
import { createTestHarness } from "./harness";

const { core } = await createTestHarness(myPlugin);

// All services available
core.logger.info("Test starting");
await core.cache.set("test", "value");
await core.events.emit("test.event", { data: 1 });

// Jobs and cron are created but not started
// Call manually if needed:
core.jobs.start();
core.cron.start();
```

---

## Custom Adapters

Each service supports custom adapters for different backends:

```ts
import { createCache, type CacheAdapter } from "./core/cache";

// Implement custom adapter (e.g., Redis)
class RedisCacheAdapter implements CacheAdapter {
  async get<T>(key: string): Promise<T | null> { /* ... */ }
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> { /* ... */ }
  // ... other methods
}

// Use custom adapter
const cache = createCache({
  adapter: new RedisCacheAdapter(redisClient),
});
```

See individual service documentation for adapter interfaces:
- [Cache Adapters](cache.md#custom-adapters)
- [Events Adapters](events.md#custom-adapters)
- [Jobs Adapters](jobs.md#custom-adapters)
- [Rate Limiter Adapters](rate-limiter.md#custom-adapters)
