---
description: Plugin system for Bun with type-safe handlers, core services, and auto-generated registries.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# @donkeylabs/server

A **type-safe plugin system** for building RPC-style APIs with Bun. Features automatic dependency resolution, database schema merging, custom handlers, middleware, and built-in core services.

---

## AI Assistant Instructions

**IMPORTANT: Follow these guidelines when working with this codebase.**

### 1. Use MCP Tools First

When the `donkeylabs` MCP server is available, **always use MCP tools** instead of writing code manually:

| Task | Use MCP Tool |
|------|--------------|
| Create a plugin | `create_plugin` |
| Add a route | `add_route` |
| Add database migration | `add_migration` |
| Add service method | `add_service_method` |
| Generate types | `generate_types` |

MCP tools ensure correct file structure, naming conventions, and patterns.

### 2. Read Docs Before Implementing

Before implementing any feature, **read the relevant documentation**:

| Feature | Read First |
|---------|------------|
| Testing | [docs/testing.md](docs/testing.md) - Test harness, unit & integration tests |
| Database queries | [docs/database.md](docs/database.md) - Use Kysely, NOT raw SQL |
| Creating plugins | [docs/plugins.md](docs/plugins.md) - Includes plugin vs route decision |
| Adding routes | [docs/router.md](docs/router.md) |
| Migrations | [docs/database.md](docs/database.md) - Use Kysely schema builder |
| Middleware | [docs/middleware.md](docs/middleware.md) |
| Background jobs | [docs/jobs.md](docs/jobs.md) |
| Cron tasks | [docs/cron.md](docs/cron.md) |

### 3. Key Patterns to Follow

- **Plugins vs Routes**: Plugins = reusable business logic; Routes = API endpoints. See [docs/plugins.md](docs/plugins.md)
- **Kysely for DB**: Always use Kysely query builder, never raw SQL. See [docs/database.md](docs/database.md)
- **Migrations**: Use TypeScript migrations with Kysely schema builder (NOT `sql` tagged templates)
- **Type generation**: Run `donkeylabs generate` after adding plugins/migrations
- **Thin routes**: Keep route handlers thin; delegate business logic to plugin services

### 4. Write Tests

**REQUIRED: Write tests for new functionality.** See [docs/testing.md](docs/testing.md)

```ts
import { createTestHarness } from "@donkeylabs/server/harness";
import { myPlugin } from "./plugins/myPlugin";

const { manager, db, core } = await createTestHarness(myPlugin);
const service = manager.getServices().myPlugin;
```

- **Unit tests**: Test plugin service methods in isolation
- **Integration tests**: Test plugins working together
- **Place tests next to code**: `plugins/users/tests/unit.test.ts`

### 5. Verify Before Committing

**REQUIRED: Always run these checks before finishing:**

```sh
# 1. Type check - catch type errors
bun --bun tsc --noEmit

# 2. Run tests - ensure nothing is broken
bun test

# 3. Generate types - if you added plugins/migrations
donkeylabs generate
```

**Do NOT skip these steps.** Type errors and failing tests must be fixed before completion.

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

## Package Structure

```
@donkeylabs/server/
├── src/                    # Library source code
│   ├── index.ts            # Main exports
│   ├── core.ts             # Plugin system, PluginManager, type helpers
│   ├── router.ts           # Route builder, handler registry
│   ├── handlers.ts         # TypedHandler, RawHandler, createHandler
│   ├── middleware.ts       # Middleware system
│   ├── server.ts           # AppServer, HTTP handling, core services init
│   ├── harness.ts          # Test harness with in-memory DB
│   ├── client/             # API client base
│   │   └── base.ts         # Client base class
│   └── core/               # Core services
│       ├── index.ts        # Re-exports all services
│       ├── logger.ts       # Logger service
│       ├── cache.ts        # Cache service
│       ├── events.ts       # Events service
│       ├── cron.ts         # Cron service
│       ├── jobs.ts         # Jobs service
│       ├── sse.ts          # SSE service
│       ├── rate-limiter.ts # Rate limiter service
│       └── errors.ts       # Error factories
├── cli/                    # CLI commands
│   ├── index.ts            # CLI entry point (donkeylabs command)
│   └── commands/
│       ├── init.ts         # Project scaffolding
│       ├── generate.ts     # Type generation
│       └── plugin.ts       # Plugin creation
├── templates/              # Templates for init and plugin commands
│   ├── init/               # New project templates
│   └── plugin/             # Plugin scaffolding templates
├── examples/               # Example projects
│   └── starter/            # Complete starter template
│       ├── src/index.ts
│       ├── src/plugins/    # Example plugins (stats with middleware)
│       ├── src/routes/     # Example routes with typing
│       └── donkeylabs.config.ts
├── scripts/                # Build and generation scripts
├── test/                   # Test files
├── registry.d.ts           # Auto-generated plugin/handler registry
└── context.d.ts            # Auto-generated GlobalContext type
```

### Generated Files (DO NOT EDIT)

- `registry.d.ts` - Plugin and handler type registry
- `context.d.ts` - Server context with merged schemas
- `.@donkeylabs/server/` - Generated types in user projects (gitignored)

---

## User Project Structure

After running `donkeylabs init`:

```
my-project/
├── src/
│   ├── index.ts              # Server entry point
│   └── plugins/              # Your plugins
│       └── myPlugin/
│           ├── index.ts      # Plugin definition
│           ├── schema.ts     # Generated DB types
│           └── migrations/   # SQL migrations
├── .@donkeylabs/server/      # Generated types (gitignored)
│   ├── registry.d.ts
│   └── context.d.ts
├── donkeylabs.config.ts      # Configuration file
├── package.json
└── tsconfig.json
```

---

## Quick Start

### 1. Create a Plugin

```ts
// src/plugins/myPlugin/index.ts
import { createPlugin } from "@donkeylabs/server";

export const myPlugin = createPlugin.define({
  name: "myPlugin",
  service: async (ctx) => ({
    greet: (name: string) => `Hello, ${name}!`
  })
});
```

### 2. Create Routes

```ts
// src/index.ts
import { createRouter } from "@donkeylabs/server";
import { z } from "zod";

const router = createRouter("api")
  .route("greet").typed({
    input: z.object({ name: z.string() }),
    handle: async (input, ctx) => {
      return { message: ctx.plugins.myPlugin.greet(input.name) };
    }
  });
```

### 3. Start Server

```ts
// src/index.ts
import { AppServer } from "@donkeylabs/server";
import { myPlugin } from "./plugins/myPlugin";

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

## CLI Commands

```sh
donkeylabs                   # Interactive menu (context-aware)
donkeylabs init              # Create new project
donkeylabs generate          # Generate types from plugins
donkeylabs plugin create     # Interactive plugin creation
```

### Interactive Mode

Running `donkeylabs` with no arguments launches an interactive menu:

**From project root:**
- Create New Plugin
- Initialize New Project
- Generate Types
- Generate Registry
- Generate Server Context

**From inside a plugin directory (`src/plugins/<name>/`):**
- Generate Schema Types
- Create Migration
- Back to Global Menu

### Development Commands

```sh
bun run gen:registry    # Regenerate registry.d.ts
bun run gen:server      # Regenerate context.d.ts
bun run cli             # Interactive CLI
bun test                # Run all tests
bun --bun tsc --noEmit  # Type check
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
  errors: Errors;                 // Error factories (BadRequest, NotFound, etc.)
  ip: string;                     // Client IP address
  requestId: string;              // Unique request ID
  user?: any;                     // Set by auth middleware
}
```

---

## Configuration File

```ts
// donkeylabs.config.ts
import { defineConfig } from "@donkeylabs/server";

export default defineConfig({
  plugins: ["./src/plugins/**/index.ts"],  // Plugin glob patterns
  outDir: ".@donkeylabs/server",           // Generated types directory
  client: {                                 // Optional client generation
    output: "./src/client/api.ts",
  },
});
```

---

## Testing

```ts
import { createTestHarness } from "@donkeylabs/server/harness";
import { myPlugin } from "./plugins/myPlugin";

const { manager, db, core } = await createTestHarness(myPlugin);

// Test with real in-memory SQLite + all core services
const service = manager.getServices().myPlugin;
expect(service.greet("Test")).toBe("Hello, Test!");
```

---

## Package Exports

```ts
// Main exports
import { createPlugin, AppServer, createRouter } from "@donkeylabs/server";

// Client base class
import { RpcClient } from "@donkeylabs/server/client";

// Test harness
import { createTestHarness } from "@donkeylabs/server/harness";
```

---

## Common Issues

### Handler autocomplete not working
1. Run `donkeylabs generate` or `bun run gen:registry`
2. Restart TypeScript language server (Cmd+Shift+P > "Restart TS Server")

### Plugin types not recognized
1. Ensure `.@donkeylabs/server` is in your tsconfig's `include` array
2. Run `donkeylabs generate`

### ctx.plugins shows as `any`
1. Make sure `service` comes BEFORE `middleware` in plugin definition
2. Run `donkeylabs generate` to regenerate types
3. Restart TypeScript language server

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

---

## Documentation

Detailed documentation is available in the `docs/` directory:

| Document | Description |
|----------|-------------|
| [testing.md](docs/testing.md) | Test harness, unit tests, integration tests, mocking |
| [database.md](docs/database.md) | Kysely queries, CRUD operations, joins, transactions, migrations |
| [plugins.md](docs/plugins.md) | Creating plugins, schemas, dependencies, middleware, and init hooks |
| [router.md](docs/router.md) | Routes, handlers, input/output validation, middleware chains |
| [middleware.md](docs/middleware.md) | Creating and using middleware with typed configuration |
| [handlers.md](docs/handlers.md) | Custom handlers (typed, raw, plugin handlers) |
| [core-services.md](docs/core-services.md) | Overview of all core services |
| [logger.md](docs/logger.md) | Structured logging with child loggers |
| [cache.md](docs/cache.md) | In-memory caching with TTL |
| [events.md](docs/events.md) | Pub/sub event system |
| [cron.md](docs/cron.md) | Scheduled tasks |
| [jobs.md](docs/jobs.md) | Background job queue |
| [sse.md](docs/sse.md) | Server-sent events |
| [rate-limiter.md](docs/rate-limiter.md) | Request rate limiting |
| [errors.md](docs/errors.md) | Error factories and custom errors |
| [api-client.md](docs/api-client.md) | Generated API client usage |
| [project-structure.md](docs/project-structure.md) | Recommended project organization |
| [cli.md](docs/cli.md) | CLI commands and interactive mode |
| [sveltekit-adapter.md](docs/sveltekit-adapter.md) | SvelteKit adapter integration |

---

## MCP Server (AI Integration)

An MCP server is available for AI assistants to create and manage plugins following project conventions.

### Available Tools

| Tool | Description |
|------|-------------|
| `create_plugin` | Create a new plugin with correct structure |
| `add_route` | Add a route to a router with proper typing |
| `add_migration` | Create a numbered migration file |
| `add_service_method` | Add a method to a plugin's service |
| `generate_types` | Run type generation |
| `list_plugins` | List all plugins with their methods |
| `get_project_info` | Get project structure info |

### Configuration

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "donkeylabs": {
      "command": "bun",
      "args": ["packages/mcp/src/server.ts"]
    }
  }
}
```

The MCP server lives in the `packages/mcp/` directory of the monorepo.

### Example Usage

AI can call these tools to scaffold code correctly:

```
Tool: create_plugin
Args: { "name": "notifications", "hasSchema": true, "dependencies": ["auth"] }

Result: Creates src/plugins/notifications/ with index.ts, schema.ts, migrations/
```
