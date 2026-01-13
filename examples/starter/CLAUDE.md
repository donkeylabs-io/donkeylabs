# {{PROJECT_NAME}}

Built with @donkeylabs/server - a type-safe RPC framework for Bun.

## Project Structure

```
src/
├── index.ts              # Server entry point
├── db.ts                 # Database setup
├── routes/               # Route handlers
│   └── health/
│       ├── index.ts      # Route definitions
│       └── ping/
│           ├── handler.ts
│           ├── models/
│           │   └── model.ts  # Input/output schemas
│           └── tests/
│               ├── unit.test.ts
│               └── integ.test.ts
└── plugins/              # Business logic plugins
    └── example/
        ├── index.ts      # Plugin definition
        ├── schema.ts     # DB types
        └── migrations/   # SQL migrations
docs/                     # Framework documentation
```

## Quick Start

See `src/routes/health/ping/` for a complete example with handler, model, and tests.

## Plugins

Plugins encapsulate business logic with optional database schemas.

```ts
import { createPlugin } from "@donkeylabs/server";

export const notesPlugin = createPlugin.define({
  name: "notes",
  service: async (ctx) => ({
    async create(title: string) {
      return ctx.db.insertInto("notes").values({ title }).execute();
    },
  }),
});
```

→ See **docs/plugins.md** for schemas, migrations, and dependencies.

## Routes

Routes are organized by feature in `src/routes/`. Each route has:
- `handler.ts` - Handler logic
- `models/model.ts` - Zod schemas for input/output
- `tests/unit.test.ts` - Unit tests
- `tests/integ.test.ts` - Integration tests

```ts
// routes/notes/index.ts
import { createRouter } from "@donkeylabs/server";
import { createHandler } from "./create/handler";

export const notesRouter = createRouter("notes")
  .route("create").typed(createHandler);
```

→ See **docs/router.md** and **src/routes/health/** for examples.

## Errors

Use built-in error factories for proper HTTP responses.

```ts
throw ctx.errors.NotFound("User not found");
throw ctx.errors.BadRequest("Invalid email");
```

→ See **docs/errors.md** for all error types and custom errors.

## Core Services

Available via `ctx.core`. **Only use what you need.**

| Service | Purpose | Docs |
|---------|---------|------|
| `logger` | Structured logging | docs/logger.md |
| `cache` | In-memory key-value cache | docs/cache.md |
| `events` | Pub/sub between plugins | docs/events.md |
| `jobs` | Background job queue | docs/jobs.md |
| `cron` | Scheduled tasks | docs/cron.md |
| `sse` | Server-sent events | docs/sse.md |
| `rateLimiter` | Request rate limiting | docs/rate-limiter.md |

→ See **docs/core-services.md** for overview.

## Middleware

Add authentication, logging, or other cross-cutting concerns.

→ See **docs/middleware.md** for usage patterns.

## API Client

Generate a typed client for your frontend:

```sh
bun run gen:client --output ./frontend/src/lib/api
```

→ See **docs/api-client.md** for client configuration and usage.

## Svelte 5 Frontend

Build type-safe frontends with Svelte 5 and SvelteKit.

```svelte
<script lang="ts">
  import { api } from "$lib/api";
  let items = $state<Item[]>([]);

  $effect(() => {
    api.items.list({}).then((r) => items = r.items);
  });
</script>
```

→ See **docs/svelte-frontend.md** for patterns and SSE integration.

## CLI Commands

```sh
bun run dev          # Start with hot reload
bun run test         # Run tests
bun run gen:types    # Generate types after adding plugins
```

## Guidelines

- **Keep it simple** - don't add services you don't need
- **One concern per plugin** - auth, notes, billing as separate plugins
- **Minimal logging** - log errors and key events, not every call
- **Read the docs** - check docs/*.md before implementing something complex
