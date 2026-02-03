---
name: donkey
description: DonkeyLabs framework patterns and best practices for type-safe full-stack development with SvelteKit and @donkeylabs/server
compatibility: opencode
metadata:
  audience: developers
  workflow: full-stack
---

## When to Use Me

Use this skill when working with DonkeyLabs projects that involve:
- Creating or modifying plugins (business logic modules)
- Adding API routes (HTTP endpoints)
- Database schema changes (migrations)
- Type-safe API client usage
- Testing patterns

## Core Principles

### 1. Plugin vs Route Decision

**Always ask: Is this logic reusable?**

If YES → Create a Plugin
If NO but needs DB tables → Create Plugin with schema
If NO and just HTTP exposure → Create Route

**Plugin responsibilities:**
- Own database tables (if hasSchema: true)
- Provide service methods for business operations
- Define middleware and custom handlers
- Be reusable across routes/apps

**Route responsibilities:**
- Thin HTTP layer calling plugin methods
- Input/output validation with Zod
- App-specific combinations of plugin operations

### 2. Database - Kysely Only

NEVER use raw SQL. Always use Kysely schema builder:

```ts
// CORRECT ✅
export async function up(db: Kysely<any>) {
  await db.schema.createTable("users")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("email", "text", (c) => c.notNull().unique())
    .execute();
}

// WRONG ❌
await sql`CREATE TABLE...`.execute(db);
```

### 3. Type Safety Flow

1. Define plugin with schema types
2. Generate types: `bun run gen:types`
3. Use typed context in routes
4. Use generated client in frontend

**Never manually edit generated files** (api.ts, registry.d.ts, etc.)

### 4. Frontend Patterns (Svelte 5)

Use runes correctly:

```svelte
<script lang="ts">
  let { data } = $props();
  let count = $state(0);
  let doubled = $derived(count * 2);
  let users = $derived(data.users);  // NOT $state(data.users)
  
  // Use watch for effects
  import { watch } from "runed";
  watch(() => count, (val) => console.log(val));
</script>
```

## Common Workflows

### Creating a New Plugin

```ts
// src/server/plugins/orders/index.ts
import { createPlugin } from "@donkeylabs/server";

export const ordersPlugin = createPlugin
  .withSchema<{ orders: OrdersTable }>()
  .define({
    name: "orders",
    service: async (ctx) => ({
      create: async (data: CreateOrderInput) =>
        ctx.db.insertInto("orders")
          .values(data)
          .returningAll()
          .executeTakeFirstOrThrow(),
      
      getById: async (id: string) =>
        ctx.db.selectFrom("orders")
          .where("id", "=", id)
          .selectAll()
          .executeTakeFirst(),
    }),
  });
```

### Adding a Migration

```ts
// src/server/plugins/orders/migrations/001_create_orders.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<any>) {
  await db.schema.createTable("orders")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
    .addColumn("total", "real", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
    .addColumn("created_at", "text", (c) => c.defaultTo("CURRENT_TIMESTAMP"))
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable("orders").execute();
}
```

### Creating a Route

```ts
// src/server/routes/orders/index.ts
import { createRouter, defineRoute } from "@donkeylabs/server";
import { z } from "zod";
import { ordersPlugin } from "../../plugins/orders";

export const ordersRouter = createRouter("orders", {
  plugins: [ordersPlugin],
});

const createOrderSchema = z.object({
  userId: z.string(),
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number().min(1),
  })),
});

ordersRouter.route("create").typed(defineRoute({
  input: createOrderSchema,
  output: z.object({ id: z.string(), status: z.string() }),
  handle: async (input, ctx) => {
    const total = await calculateTotal(input.items);
    return ctx.plugins.orders.create({
      userId: input.userId,
      items: input.items,
      total,
      status: "pending",
    });
  },
}));
```

### Using the API Client

```svelte
<!-- +page.svelte -->
<script lang="ts">
  import { createApi } from "$lib/api";
  
  const api = createApi();
  
  async function handleSubmit(formData: FormData) {
    const result = await api.orders.create({
      userId: "user-123",
      items: [{ productId: "prod-456", quantity: 2 }],
    });
    
    console.log("Created order:", result.id);
  }
</script>
```

## Error Handling

Always use framework errors:

```ts
throw ctx.errors.NotFound("User not found");     // 404
throw ctx.errors.BadRequest("Invalid input");    // 400
throw ctx.errors.Unauthorized("Login required"); // 401
throw ctx.errors.Forbidden("Access denied");     // 403
throw ctx.errors.Conflict("Already exists");     // 409
throw ctx.errors.TooManyRequests("Rate limited"); // 429
```

## Testing Patterns

### Unit Test (No HTTP)

```ts
import { createTestHarness } from "@donkeylabs/server";

test("orders.create creates order", async () => {
  const { manager } = await createTestHarness(ordersPlugin);
  
  const order = await manager.plugins.orders.create({
    userId: "user-1",
    items: [{ productId: "prod-1", quantity: 1 }],
    total: 99.99,
    status: "pending",
  });
  
  expect(order.id).toBeDefined();
  expect(order.status).toBe("pending");
});
```

### Integration Test (With HTTP)

```ts
import { createIntegrationHarness } from "@donkeylabs/server";
import { createApiClient } from "../lib/api";

test("POST /orders.create creates order", async () => {
  const harness = await createIntegrationHarness({
    routers: [ordersRouter],
    plugins: [ordersPlugin],
  });
  
  const api = harness.createClient(createApiClient);
  
  const result = await api.orders.create({
    userId: "user-1",
    items: [{ productId: "prod-1", quantity: 1 }],
  });
  
  expect(result.id).toBeDefined();
  await harness.shutdown();
});
```

## Debugging Tips

### Hot Reload Not Working?
1. Use `bun --bun run dev` (in-process mode)
2. Check console for `[donkeylabs-dev]` messages
3. Ensure route files match `**/routes/**/*.ts` pattern

### Types Not Updating?
1. Run `bun run gen:types` manually
2. Check for TypeScript errors in plugin files
3. Verify migrations compile without errors

### Database Errors?
1. Check migration files exist and are valid
2. Verify schema.ts was generated (if using withSchema)
3. Look for Kysely syntax errors

## Anti-Patterns to Avoid

**❌ Putting business logic in routes:**
```ts
// BAD
router.route("create").typed({
  handle: async (input, ctx) => {
    // 50 lines of validation, DB calls, side effects...
  },
});
```

**✅ Thin route, logic in plugin:**
```ts
// GOOD
router.route("create").typed({
  handle: async (input, ctx) => ctx.plugins.orders.create(input),
});
```

**❌ Using raw SQL:**
```ts
// BAD
await sql`SELECT * FROM users WHERE id = ${id}`.execute(db);
```

**✅ Using Kysely:**
```ts
// GOOD
await ctx.db.selectFrom("users").where("id", "=", id).executeTakeFirst();
```

**❌ Fetch in frontend:**
```ts
// BAD
await fetch('/orders.create', {...})
```

**✅ Using generated client:**
```ts
// GOOD
await api.orders.create({...})
```

## Dev Server Modes

**In-Process Mode** (recommended):
```bash
bun --bun run dev
```
- Single port (e.g., 5173)
- Fastest performance
- Same process as Vite
- Full hot reload support

**Subprocess Mode**:
```bash
bun run dev
```
- Two ports (Vite + backend on 3001)
- Proxy between processes
- Fallback for non-Bun environments

## Useful Commands

```bash
# Generate types
bun run gen:types

# Create plugin interactively
bunx donkeylabs plugin create

# Type check
bun --bun tsc --noEmit

# Run tests
bun test

# Watch specific plugin for changes
bun scripts/watcher.ts <plugin-name>
```
