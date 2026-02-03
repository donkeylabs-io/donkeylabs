---
description: DonkeyLabs framework - Full-stack SvelteKit + @donkeylabs/server
globs: "*.ts, *.tsx, *.svelte, *.html, *.css, *.js, *.jsx, package.json, donkeylabs.config.ts"
alwaysApply: true
---

# DonkeyLabs Full-Stack Framework

A production-ready TypeScript framework combining SvelteKit frontend with @donkeylabs/server backend. Full type safety from DB to UI.

## Architecture Overview

**Plugin System**: Business logic is organized in plugins - self-contained modules with DB schema, services, and middleware.
**Routes**: API endpoints that use plugins - thin layer for HTTP exposure.
**Handlers**: Multiple handler types (typed, stream, SSE, formData, html) for different use cases.

```
src/
├── server/
│   ├── plugins/     # Reusable business logic
│   │   └── users/
│   │       ├── index.ts      # Plugin definition
│   │       └── migrations/   # DB schema evolution
│   ├── routes/      # API endpoints
│   │   └── users/
│   │       ├── index.ts
│   │       └── schemas.ts    # Zod validation
│   └── index.ts     # Server entry
├── lib/
│   ├── api.ts       # Generated client (DO NOT EDIT)
│   └── components/
│       └── ui/      # shadcn-svelte components
└── routes/          # SvelteKit pages
```

## CRITICAL RULES

### 1. Use MCP Tools When Available

If the `donkeylabs` MCP server is active, prefer its tools over manual edits:
- `create_plugin` - Scaffold new plugins
- `add_route` - Add API endpoints
- `add_migration` - Database migrations
- `add_service_method` - Add plugin methods
- `generate_types` - Regenerate types
- `list_plugins` - See available plugins

### 2. Migrations - KYSELY ONLY

Never use raw SQL. Always use Kysely schema builder:

```ts
// CORRECT ✅
export async function up(db: Kysely<any>) {
  await db.schema.createTable("users")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("email", "text", (c) => c.notNull().unique())
    .addColumn("created_at", "text", (c) => c.defaultTo("CURRENT_TIMESTAMP"))
    .execute();
}

// WRONG ❌
await sql`CREATE TABLE users...`.execute(db);  // Never do this
```

### 3. Frontend - Svelte 5 & shadcn-svelte

Use Svelte 5 runes correctly:

```svelte
<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { watch } from "runed";
  import { onMount } from "svelte";

  let { data } = $props();
  let count = $state(0);
  let doubled = $derived(count * 2);
  let users = $derived(data.users);  // NOT $state(data.users)

  // Use watch for effects, NEVER $effect
  watch(() => count, (val) => console.log(val));

  onMount(() => { 
    // Setup
    return () => { 
      // Cleanup
    }; 
  });
</script>

<Button onclick={() => count++}>Click</Button>
```

### 4. API Client Patterns

```ts
// +page.server.ts (SSR - direct calls, no HTTP)
import { createApi } from "$lib/api";
const api = createApi({ locals });
return { users: await api.users.list({}) };

// +page.svelte (browser - uses HTTP)
import { createApi } from "$lib/api";
const api = createApi();
await api.users.create({ email, name });

// NEVER use fetch directly ❌
await fetch('/users.list', {...})  // Wrong
```

### 5. Plugin vs Route Decision Tree

```
Is this logic reusable?
  ├── Yes → Create Plugin
  └── No
       ├── Does it need DB tables?
       │     └── Yes → Create Plugin (withSchema)
       └── Is it just HTTP exposure?
             └── Yes → Create Route using existing plugins
```

**Plugins** encapsulate reusable business logic:
- User management, auth, email, payments
- Database tables owned by the plugin
- Service methods for operations

**Routes** are HTTP endpoints:
- Thin layer calling plugin methods
- Input validation with Zod
- App-specific combinations

### 6. Error Handling

Always use framework errors, never raw throw:

```ts
throw ctx.errors.NotFound("User not found");     // 404
throw ctx.errors.BadRequest("Invalid input");    // 400
throw ctx.errors.Unauthorized("Login required"); // 401
throw ctx.errors.Forbidden("Access denied");     // 403
```

### 7. Type Safety Checklist

After any change, run:
```bash
bun run gen:types     # Regenerate types
bun --bun tsc --noEmit  # Type check
```

## Development Commands

```bash
# Start dev server (hot reload enabled)
bun run dev

# Or with Bun runtime (recommended - single process, faster)
bun --bun run dev

# Generate types after plugin/route changes
bunx donkeylabs generate
# or
bun run gen:types

# Create new plugin interactively
bunx donkeylabs plugin create

# Deploy to serverless (Vercel, Cloudflare, AWS)
donkeylabs deploy vercel

# View deployment history
bunx donkeylabs deploy history

# Rollback to previous version
donkeylabs deploy rollback

# Interactive configuration
donkeylabs config

# Type check
bun --bun tsc --noEmit

# Run tests
bun test

# Run E2E tests
bunx playwright test
```

## Hot Reload System

The framework has sophisticated hot reload:

1. **Route Hot Reload**: Changes to route files are hot-reloaded without server restart
2. **Type Auto-Generation**: File watcher triggers type regeneration
3. **Plugin Watcher**: Individual plugins can be watched for changes

**Dev Server Modes:**
- `bun --bun run dev` - **In-process mode** (recommended): Single port, fastest, same process
- `bun run dev` - Subprocess mode: Separate backend process on port 3001

**What Gets Hot Reloaded:**
- ✅ Route handlers (instant)
- ✅ Plugin service changes (need type regen)
- ✅ Schema changes (triggers migration + type gen)
- ❌ Plugin structure changes (requires restart)

## Testing

```ts
// Unit test plugins (no HTTP, fast)
import { createTestHarness } from "@donkeylabs/server";
const { manager } = await createTestHarness(myPlugin);
const result = await manager.plugins.myPlugin.someMethod();

// Integration test with HTTP (full stack)
import { createIntegrationHarness } from "@donkeylabs/server";
const harness = await createIntegrationHarness({
  routers: [usersRouter],
  plugins: [usersPlugin],
});
const api = harness.createClient(createApiClient);
await api.users.create({ name: "Test" });
await harness.shutdown();

// E2E Testing with Playwright
import { test, expect, defineE2EConfig } from "@donkeylabs/server";

test("user can sign up", async ({ page, api }) => {
  await page.goto("/signup");
  await page.fill('[name="email"]', "test@example.com");
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL("/dashboard");
});

// Database Testing
import { createTestDatabase, seedTestData } from "@donkeylabs/server";
const db = await createTestDatabase({ type: "sqlite", runMigrations: true });
await seedTestData(db, { users: [{ email: "test@test.com" }] });
```

## Core Services (ctx.core)

Available in all route handlers and plugin services:

| Service | Purpose |
|---------|---------|
| `ctx.core.logger` | Structured logging with child loggers |
| `ctx.core.cache` | In-memory caching with TTL |
| `ctx.core.events` | Type-safe event bus |
| `ctx.core.cron` | Scheduled jobs |
| `ctx.core.jobs` | Background job queue |
| `ctx.core.sse` | Server-sent events |
| `ctx.core.rateLimiter` | Request throttling |
| `ctx.core.workflows` | Step functions |
| `ctx.core.processes` | Managed subprocesses |
| `ctx.core.audit` | Audit logging |
| `ctx.core.websocket` | WebSocket connections |
| `ctx.core.storage` | File storage (local/S3) |

## Handler Types

| Handler | Use Case | Example |
|---------|----------|---------|
| `.typed()` | JSON APIs | `router.route("create").typed({...})` |
| `.stream()` | File downloads | Streaming images, CSV |
| `.sse()` | Real-time | Live updates, notifications |
| `.formData()` | File uploads | Image uploads, documents |
| `.html()` | htmx partials | Server-rendered fragments |

## Common Patterns

### Plugin with Schema

```ts
export const usersPlugin = createPlugin
  .withSchema<{ users: UsersTable }>()
  .define({
    name: "users",
    service: async (ctx) => ({
      getById: async (id: string) => 
        ctx.db.selectFrom("users")
          .where("id", "=", id)
          .selectAll()
          .executeTakeFirst(),
      
      create: async (data: CreateUserInput) =>
        ctx.db.insertInto("users")
          .values(data)
          .returningAll()
          .executeTakeFirstOrThrow(),
    }),
  });
```

### Route Using Plugin

```ts
export const usersRouter = createRouter("users", {
  plugins: [usersPlugin],
});

router.route("get").typed(defineRoute({
  input: z.object({ id: z.string() }),
  output: userSchema.nullable(),
  handle: async (input, ctx) => 
    ctx.plugins.users.getById(input.id),
}));

router.route("create").typed(defineRoute({
  input: createUserSchema,
  output: userSchema,
  handle: async (input, ctx) =>
    ctx.plugins.users.create(input),
}));
```

### Custom Handler

```ts
const XMLHandler = createHandler<XMLHandlerFn>(
  async (req, def, handle, ctx) => {
    const xml = await req.text();
    const result = await handle(xml, ctx);
    return new Response(result, {
      headers: { "Content-Type": "application/xml" },
    });
  }
);

// In router
router.route("process").xml({
  handle: async (xmlBody, ctx) => {
    // Process XML
    return `<response>ok</response>`;
  },
});
```

### Middleware

```ts
export const authPlugin = createPlugin.define({
  name: "auth",
  service: async (ctx) => ({
    validateToken: async (token: string) => ({ id: 1, roles: ["user"] }),
  }),
  middleware: (ctx, service) => ({
    authRequired: createMiddleware(
      async (req, reqCtx, next) => {
        const token = req.headers.get("Authorization")?.replace("Bearer ", "");
        if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
        
        reqCtx.user = await service.validateToken(token);
        return next();
      }
    ),
  }),
});

// Usage
router.middleware.authRequired().route("admin-only").typed({...});
```

## Troubleshooting

### Types not updating after changes?
1. Check if file watcher is running
2. Run `bun run gen:types` manually
3. Restart dev server if needed

### Hot reload not working?
1. Verify using `bun --bun run dev` (in-process mode)
2. Check console for `[donkeylabs-dev]` messages
3. Ensure file is in watched directory

### Plugin dependencies not resolving?
1. Check dependencies array is correct
2. Ensure dependency plugin is registered first
3. Look for circular dependency errors

### Database errors?
1. Run migrations: Check `src/server/plugins/*/migrations/`
2. Verify schema types: `bun run gen:types`
3. Check Kysely syntax (no raw SQL)

## VS Code Extension Ideas

The framework could benefit from a VS Code extension providing:
- **Snippets**: `plugin`, `route`, `migration`, `handler` templates
- **Go to Definition**: Jump from route to plugin service
- **Auto-import**: Suggest plugins when typing `ctx.plugins.`
- **Type Hints**: Show generated types inline
- **Status Bar**: Type generation status, hot reload indicator
- **Commands**: Quick access to `gen:types`, `create:plugin`, etc.

## Deployment

### VPS (Docker) - Recommended for production
```bash
# Project created with --deployment docker
donkeylabs init my-app  # Select Docker deployment
cd my-app
docker-compose up -d
```

### Serverless (Vercel/Cloudflare/AWS)
```bash
# Create project with PostgreSQL (SQLite won't work serverless!)
donkeylabs init my-api  # Select PostgreSQL + Vercel
cd my-api

# Set DATABASE_URL in .env.local

# Deploy
donkeylabs deploy vercel
# or
donkeylabs deploy cloudflare
# or  
donkeylabs deploy aws
```

### Deployment Management
```bash
# View deployment history
donkeylabs deploy history

# View stats
donkeylabs deploy stats

# Rollback to previous version
donkeylabs deploy rollback

# Rollback to specific version
donkeylabs deploy rollback v1.2.3
```

## Additional Resources

- **Package**: `@donkeylabs/server` (core), `@donkeylabs/cli` (CLI), `@donkeylabs/adapter-sveltekit` (SvelteKit), `@donkeylabs/adapter-serverless` (Vercel/Cloudflare/AWS)
- **MCP Server**: `@donkeylabs/mcp` for AI-assisted development
- **Docs**: See `packages/server/docs/` for detailed guides
- **Plugins**: `packages/server/src/plugins/` for built-in plugins (backup, etc.)
