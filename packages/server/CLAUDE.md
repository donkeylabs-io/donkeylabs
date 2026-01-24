---
description: DonkeyLabs SvelteKit project with type-safe API, plugins, and Svelte 5.
globs: "*.ts, *.tsx, *.svelte, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: true
---

# DonkeyLabs Project

SvelteKit + @donkeylabs/server full-stack app with type-safe APIs and Svelte 5.

## CRITICAL RULES

### 1. Use MCP Tools First
When `donkeylabs` MCP is available, use tools instead of manual code: `create_plugin`, `add_route`, `add_migration`, `add_service_method`, `generate_types`.

### 2. Migrations - KYSELY ONLY (No Raw SQL)
```ts
// CORRECT - Kysely schema builder
await db.schema.createTable("users").ifNotExists()
  .addColumn("id", "text", (col) => col.primaryKey())
  .addColumn("email", "text", (col) => col.notNull().unique())
  .execute();

// WRONG - Never use raw SQL
await sql`CREATE TABLE...`.execute(db);  // NO!
```

### 3. Frontend - Svelte 5 & shadcn-svelte ONLY
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

  onMount(() => { /* setup */ return () => { /* cleanup */ }; });
</script>
<Button onclick={() => count++}>Click</Button>
```

## Project Structure
```
src/
├── server/
│   ├── index.ts           # Server entry
│   ├── plugins/           # Business logic (reusable)
│   │   └── users/
│   │       ├── index.ts
│   │       └── migrations/
│   └── routes/            # API routes
│       └── orders/        # Feature modules (app-specific)
│           ├── index.ts
│           ├── orders.schemas.ts
│           └── handlers/
├── lib/
│   ├── api.ts             # Generated client (DO NOT EDIT)
│   └── components/ui/     # shadcn-svelte
└── routes/                # SvelteKit pages
```

## Common Pitfalls

| Wrong | Correct |
|-------|---------|
| `let x = $state(data.x)` | `let x = $derived(data.x)` |
| `$effect(() => {...})` | `watch(() => val, (v) => {...})` |
| `await fetch('/route')` | `await api.route.method({})` |
| `new EventSource(...)` | `api.sse.subscribe([...], cb)` |
| Raw SQL in migrations | Kysely schema builder |

## Plugin Quick Reference
```ts
export const usersPlugin = createPlugin
  .withSchema<{ users: UsersTable }>()
  .define({
    name: "users",
    service: async (ctx) => ({
      getById: async (id) => ctx.db.selectFrom("users").where("id", "=", id).selectAll().executeTakeFirst(),
    }),
  });
```

## Route Quick Reference
```ts
router.route("get").typed(defineRoute({
  input: z.object({ id: z.string() }),
  output: userSchema.nullable(),
  handle: async (input, ctx) => ctx.plugins.users.getById(input.id),
}));
```

## Feature Module Pattern
For app-specific routes, use handler classes:
```ts
// handlers/create.handler.ts
export class CreateOrderHandler implements Handler<Routes.Orders.Create> {
  constructor(private ctx: AppContext) {}
  async handle(input) { /* business logic here */ }
}

// index.ts (thin router)
router.route("create").typed({ input, output, handle: CreateOrderHandler });
```

## API Client Usage
```ts
// +page.server.ts (SSR - direct calls)
const api = createApi({ locals });
return { users: await api.users.list({}) };

// +page.svelte (browser - HTTP)
const api = createApi();
await api.users.create({ email, name });
```

## Handler Types
| Handler | Use Case |
|---------|----------|
| `.typed()` | JSON APIs |
| `.stream()` | File downloads |
| `.sse()` | Real-time |
| `.formData()` | File uploads |
| `.html()` | htmx partials |

## Core Services (ctx.core)
`ctx.core.logger`, `ctx.core.cache`, `ctx.core.jobs`, `ctx.core.events`, `ctx.core.rateLimiter`, `ctx.core.sse`, `ctx.core.processes`, `ctx.core.workflows`

## Error Handling
```ts
throw ctx.errors.NotFound("User not found");     // 404
throw ctx.errors.BadRequest("Invalid input");    // 400
throw ctx.errors.Unauthorized("Login required"); // 401
```

## Commands
```sh
bun run dev               # Dev server
bunx donkeylabs generate  # Regen types after changes
bun --bun tsc --noEmit    # Type check
```

## MCP Tools
`get_project_info`, `create_plugin`, `add_migration`, `add_service_method`, `create_router`, `add_route`, `generate_types`, `list_plugins`, `scaffold_feature`

## Detailed Docs
See `docs/` for: handlers, middleware, database, plugins, testing, jobs, external-jobs, processes, cron, sse, workflows, router, errors, sveltekit-adapter.
