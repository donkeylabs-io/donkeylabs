---
description: Plugin system for Bun with type-safe handlers, core services, and auto-generated registries.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# Plugin Framework for Bun

A **type-safe plugin system** for building RPC-style APIs with Bun. Features automatic dependency resolution, database schema merging, custom handlers, middleware, and built-in core services.

## Quick Links

| Documentation | Description |
|---------------|-------------|
| [Project Structure](docs/project-structure.md) | Directory layout, naming conventions, do's and don'ts |
| [Plugins](docs/plugins.md) | Creating plugins, dependencies, configuration, services |
| [Core Services](docs/core-services.md) | Overview of all built-in services |
| [Router & Routes](docs/router.md) | Defining routes with the fluent API |
| [Handlers](docs/handlers.md) | Built-in and custom request handlers |
| [Middleware](docs/middleware.md) | Request/response middleware |
| [CLI](docs/cli.md) | Command-line tools and scripts (includes AI-friendly commands)

### Core Service Documentation

| Service | Description |
|---------|-------------|
| [Logger](docs/logger.md) | Structured logging with levels and transports |
| [Cache](docs/cache.md) | Key-value store with TTL and LRU eviction |
| [Events](docs/events.md) | Pub/sub event system with patterns |
| [Cron](docs/cron.md) | Scheduled recurring tasks |
| [Jobs](docs/jobs.md) | Background job queue with retries |
| [SSE](docs/sse.md) | Server-Sent Events for real-time updates |
| [Rate Limiter](docs/rate-limiter.md) | Request throttling with IP detection |

---

## Bun-First Development

Always use Bun instead of Node.js:

```sh
bun <file>              # Instead of node/ts-node
bun test                # Instead of jest/vitest
bun install             # Instead of npm/yarn/pnpm install
bun run <script>        # Instead of npm run
```

Bun automatically loads `.env` - don't use dotenv.

---

## Project Structure

```
├── core.ts              # Plugin system, PluginManager, type helpers
├── router.ts            # Route builder, handler registry
├── handlers.ts          # TypedHandler, RawHandler, createHandler
├── middleware.ts        # Middleware system
├── server.ts            # AppServer, HTTP handling, core services init
├── harness.ts           # Test harness with in-memory DB
├── context.d.ts         # Auto-generated GlobalContext type
├── registry.d.ts        # Auto-generated plugin/handler registry
├── core/                # Core services
│   ├── index.ts         # Re-exports all services
│   ├── logger.ts        # Logger service
│   ├── cache.ts         # Cache service
│   ├── events.ts        # Events service
│   ├── cron.ts          # Cron service
│   ├── jobs.ts          # Jobs service
│   ├── sse.ts           # SSE service
│   └── rate-limiter.ts  # Rate limiter service
├── plugins/             # Plugin modules
│   └── <plugin>/
│       ├── index.ts     # Plugin definition
│       ├── schema.ts    # Generated DB types
│       └── migrations/  # SQL migrations
├── scripts/             # CLI and generation scripts
└── test/                # Test files
```

### Generated Files (DO NOT EDIT)

- `registry.d.ts` - Plugin and handler type registry
- `context.d.ts` - Server context with merged schemas

---

## Quick Start

### 1. Create a Plugin

```ts
// plugins/myPlugin/index.ts
import { createPlugin } from "../../core";

export const myPlugin = createPlugin.define({
  name: "myPlugin",
  service: async (ctx) => ({
    greet: (name: string) => `Hello, ${name}!`
  })
});
```

### 2. Create Routes

```ts
// routes.ts
import { createRouter } from "./router";
import { z } from "zod";

export const router = createRouter("api")
  .route("greet").typed({
    input: z.object({ name: z.string() }),
    handle: async (input, ctx) => {
      return { message: ctx.plugins.myPlugin.greet(input.name) };
    }
  });
```

### 3. Start Server

```ts
// index.ts
import { AppServer } from "./server";
import { myPlugin } from "./plugins/myPlugin";
import { router } from "./routes";

const server = new AppServer({
  db: createDatabase(),
  port: 3000,
});

server.registerPlugin(myPlugin);
server.use(router);
await server.start();
```

### 4. Make Requests

```sh
curl -X POST http://localhost:3000/api.greet \
  -H "Content-Type: application/json" \
  -d '{"name": "World"}'
# {"message": "Hello, World!"}
```

---

## Server Context

Every route handler receives `ServerContext`:

```ts
interface ServerContext {
  db: Kysely<MergedSchema>;      // Database with all plugin schemas
  plugins: {                      // All plugin services
    myPlugin: MyPluginService;
    auth: AuthService;
    // ... auto-generated
  };
  core: CoreServices;             // Logger, cache, events, etc.
  ip: string;                     // Client IP address
  requestId: string;              // Unique request ID
  user?: any;                     // Set by auth middleware
}
```

---

## Key Commands

```sh
bun run gen:registry    # Regenerate registry.d.ts (after adding plugins/handlers)
bun run gen:server      # Regenerate context.d.ts (after schema changes)
bun run cli             # Interactive CLI
bun test                # Run all tests
bun --bun tsc --noEmit  # Type check
```

---

## Testing

```ts
import { createTestHarness } from "./harness";
import { myPlugin } from "./plugins/myPlugin";

const { manager, db, core } = await createTestHarness(myPlugin);

// Test with real in-memory SQLite + all core services
const service = manager.getServices().myPlugin;
expect(service.greet("Test")).toBe("Hello, Test!");
```

---

## Common Issues

### Handler autocomplete not working
1. Run `bun run gen:registry`
2. Restart TypeScript language server (Cmd+Shift+P > "Restart TS Server")

### Plugin types not recognized
1. Ensure file has `/// <reference path="./registry.d.ts" />`
2. Run `bun run gen:registry`

### Core services undefined
1. Check `ServerConfig` has required `db` property
2. Core services are auto-initialized in `AppServer` constructor

---

## Bun APIs

Use Bun's built-in APIs instead of npm packages:

| Use | Instead of |
|-----|------------|
| `Bun.serve()` | express, fastify |
| `bun:sqlite` | better-sqlite3 |
| `Bun.redis` | ioredis |
| `Bun.sql` | pg, postgres.js |
| `WebSocket` | ws |
| `Bun.file()` | fs.readFile |
| `Bun.$\`cmd\`` | execa |

See `node_modules/bun-types/docs/**.md` for full API documentation.
