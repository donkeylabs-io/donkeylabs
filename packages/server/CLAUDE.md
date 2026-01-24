---
description: DonkeyLabs SvelteKit project with type-safe API, plugins, and Svelte 5.
globs: "*.ts, *.tsx, *.svelte, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: true
---

# DonkeyLabs Project

This is a **SvelteKit + @donkeylabs/server** full-stack application with type-safe APIs, database plugins, and Svelte 5 frontend.

---

## CRITICAL RULES

### 1. Use MCP Tools First

When the `donkeylabs` MCP server is available, **ALWAYS use MCP tools** instead of writing code manually:

| Task | MCP Tool |
|------|----------|
| Create a plugin | `create_plugin` |
| Add a route | `add_route` |
| Add database migration | `add_migration` |
| Add service method | `add_service_method` |
| Generate types | `generate_types` |

### 2. Database Migrations - KYSELY ONLY

**CRITICAL: Migrations MUST use Kysely schema builder. NEVER use raw SQL.**

```ts
// ✅ CORRECT - Kysely schema builder
import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("users")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .execute();

  await db.schema
    .createIndex("idx_users_email")
    .ifNotExists()
    .on("users")
    .column("email")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("users").ifExists().execute();
}
```

```ts
// ❌ WRONG - Never do this
import { sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE users (id TEXT PRIMARY KEY)`.execute(db);  // NO!
  await db.executeQuery(sql`ALTER TABLE...`);  // NO!
}
```

**Kysely schema builder methods:**
- `createTable()`, `dropTable()`, `alterTable()`
- `addColumn()`, `dropColumn()`, `renameColumn()`
- `createIndex()`, `dropIndex()`
- Column modifiers: `.primaryKey()`, `.notNull()`, `.unique()`, `.defaultTo()`, `.references()`

### 3. Frontend - Svelte 5 & shadcn-svelte ONLY

**UI Components:** Use **shadcn-svelte** exclusively. Never use other UI libraries.

```svelte
<!-- ✅ CORRECT - shadcn-svelte components -->
<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
</script>

<Card>
  <CardHeader>
    <CardTitle>My Card</CardTitle>
  </CardHeader>
  <CardContent>
    <Input placeholder="Enter text" />
    <Button onclick={handleClick}>Submit</Button>
  </CardContent>
</Card>
```

**Svelte 5 Patterns - NEVER use $effect, use `watch` from runed:**

```svelte
<!-- ✅ CORRECT - Svelte 5 runes with runed -->
<script lang="ts">
  import { onMount } from "svelte";
  import { watch } from "runed";

  // Props
  let { data } = $props();

  // Reactive state
  let count = $state(0);
  let items = $state<string[]>([]);

  // Derived values
  let doubled = $derived(count * 2);
  let total = $derived(items.length);

  // ✅ CORRECT - Use watch from runed for reactive side effects
  watch(
    () => count,
    (newCount) => {
      console.log("Count changed to:", newCount);
      // React to count changes
    }
  );

  // ✅ CORRECT - Watch multiple values
  watch(
    () => [count, items.length],
    ([newCount, newLength]) => {
      console.log("Values changed:", newCount, newLength);
    }
  );

  // Lifecycle - use onMount for setup/cleanup
  onMount(() => {
    // Setup code here
    fetchData();

    return () => {
      // Cleanup code here
    };
  });

  // Event handlers
  function handleClick() {
    count++;
  }
</script>

<!-- ✅ CORRECT - onclick not on:click -->
<button onclick={handleClick}>Count: {count}</button>
```

```svelte
<!-- ❌ WRONG - Never use $effect -->
<script lang="ts">
  let count = $state(0);

  // ❌ NEVER DO THIS - use watch from runed instead
  $effect(() => {
    console.log(count);  // NO!
  });
</script>
```

**Svelte 5 Rules:**
- Use `$state()` for reactive variables
- Use `$derived()` for computed values
- Use `$props()` to receive props
- Use `watch()` from **runed** for reactive side effects, **NEVER $effect**
- Use `onMount()` for lifecycle setup/cleanup
- Use `onclick={}` not `on:click={}`
- Use `{@render children()}` for slots/snippets

---

## Project Structure

```
my-project/
├── src/
│   ├── server/                    # @donkeylabs/server API
│   │   ├── index.ts               # Server entry point
│   │   ├── plugins/               # Business logic plugins
│   │   │   └── users/
│   │   │       ├── index.ts       # Plugin definition
│   │   │       └── migrations/    # Kysely migrations
│   │   │           └── 001_create_users_table.ts
│   │   └── routes/                # API route definitions
│   │       └── users.ts           # User routes
│   │
│   ├── lib/
│   │   ├── api.ts                 # Generated typed API client (DO NOT EDIT)
│   │   ├── components/ui/         # shadcn-svelte components
│   │   └── utils/                 # Utility functions
│   │
│   ├── routes/                    # SvelteKit pages
│   │   ├── +layout.svelte
│   │   ├── +page.svelte
│   │   └── +page.server.ts
│   │
│   ├── app.html
│   ├── app.css
│   └── hooks.server.ts            # SvelteKit hooks
│
├── docs/                          # Documentation
├── .mcp.json                      # MCP server config
├── svelte.config.js
├── vite.config.ts
└── package.json
```

---

## Common Pitfalls - AVOID THESE

### 1. State from Props - Does NOT Auto-Update

```svelte
<!-- ❌ WRONG - This only copies initial value, won't update when data changes -->
<script lang="ts">
  let { data } = $props();
  let users = $state(data.users);  // BROKEN! Won't update on navigation
</script>

<!-- ✅ CORRECT - Use $derived for reactive props -->
<script lang="ts">
  let { data } = $props();
  let users = $derived(data.users);  // Updates when data changes

  // Or if you need to mutate locally:
  let localUsers = $state<User[]>([]);
  watch(() => data.users, (newUsers) => {
    localUsers = [...newUsers];
  });
</script>
```

### 2. Loading States - Always Handle Async Properly

```svelte
<!-- ✅ CORRECT - Track loading state -->
<script lang="ts">
  import { Button } from "$lib/components/ui/button";

  let loading = $state(false);
  let error = $state<string | null>(null);
  let data = $state<Data | null>(null);

  async function fetchData() {
    loading = true;
    error = null;
    try {
      data = await api.users.list({});
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load";
    } finally {
      loading = false;
    }
  }
</script>

<Button onclick={fetchData} disabled={loading}>
  {loading ? "Loading..." : "Refresh"}
</Button>
{#if error}
  <p class="text-destructive">{error}</p>
{/if}
```

### 3. API Client - SSR vs Browser

```ts
// +page.server.ts - SSR: Pass locals for direct calls (no HTTP)
export const load = async ({ locals }) => {
  const api = createApi({ locals });  // ✅ Direct call
  return { users: await api.users.list({}) };
};

// +page.svelte - Browser: No locals needed (uses HTTP)
<script lang="ts">
  const api = createApi();  // ✅ HTTP calls

  // ❌ WRONG - Don't try to pass locals in browser
  // const api = createApi({ locals });  // Won't work!
</script>
```

### 5. NEVER Use Raw fetch() or EventSource - Use the Generated Client

**The generated client in `$lib/api.ts` handles everything. NEVER bypass it.**

```ts
// ❌ WRONG - Never use raw fetch
const response = await fetch('/users.get', {
  method: 'POST',
  body: JSON.stringify({ id: '123' })
});
const user = await response.json();

// ✅ CORRECT - Use the typed client
const api = createApi();
const user = await api.users.get({ id: '123' });
```

```ts
// ❌ WRONG - Never use raw EventSource
const eventSource = new EventSource('/sse?channels=notifications');
eventSource.onmessage = (e) => console.log(e.data);

// ✅ CORRECT - Use client.sse.subscribe()
const api = createApi();
const unsubscribe = api.sse.subscribe(
  ['notifications'],
  (event, data) => {
    console.log(event, data);  // Typed and parsed!
  }
);
// Later: unsubscribe();
```

**The client provides:**
- Type safety for all inputs/outputs
- Automatic JSON parsing
- SSR direct calls (no HTTP overhead when using `{ locals }`)
- Auto-reconnect for SSE
- Proper error handling

### 4. Migration Files MUST Be Numbered Sequentially

```
src/server/plugins/users/migrations/
├── 001_create_users_table.ts      ✅ First migration
├── 002_add_avatar_column.ts       ✅ Second migration
├── 003_create_sessions_table.ts   ✅ Third migration
└── create_something.ts            ❌ WRONG - No number prefix!
```

---

## Schema Type Definitions

**Define table types alongside your migrations:**

```ts
// src/server/plugins/users/index.ts
import { createPlugin } from "@donkeylabs/server";
import type { Generated, ColumnType } from "kysely";

// Define your table schema type
interface UsersTable {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: ColumnType<string, string | undefined, never>;  // Read: string, Insert: optional, Update: never
  updated_at: string;
}

// Use in plugin
export const usersPlugin = createPlugin
  .withSchema<{ users: UsersTable }>()
  .define({
    name: "users",
    service: async (ctx) => ({
      // ctx.db is now typed with users table
    }),
  });
```

---

## Error Handling

### In Plugins - Throw Errors

```ts
// src/server/plugins/users/index.ts
service: async (ctx) => ({
  getById: async (id: string) => {
    const user = await ctx.db
      .selectFrom("users")
      .where("id", "=", id)
      .selectAll()
      .executeTakeFirst();

    if (!user) {
      throw ctx.errors.NotFound("User not found");  // ✅ Use ctx.errors
    }
    return user;
  },

  create: async (data: CreateUserInput) => {
    // Check for duplicates
    const existing = await ctx.db
      .selectFrom("users")
      .where("email", "=", data.email)
      .selectAll()
      .executeTakeFirst();

    if (existing) {
      throw ctx.errors.BadRequest("Email already exists");  // ✅
    }

    // ... create user
  },
}),
```

### Available Error Types

```ts
ctx.errors.BadRequest(message)     // 400
ctx.errors.Unauthorized(message)   // 401
ctx.errors.Forbidden(message)      // 403
ctx.errors.NotFound(message)       // 404
ctx.errors.Conflict(message)       // 409
ctx.errors.InternalError(message)  // 500
```

---

## Core Services (ctx.core)

Access built-in services via `ctx.core` in plugins:

```ts
service: async (ctx) => ({
  doSomething: async () => {
    // Logging
    ctx.core.logger.info("Something happened", { userId: "123" });
    ctx.core.logger.error("Failed", { error: err.message });

    // Caching
    await ctx.core.cache.set("key", value, 60000);  // 60s TTL
    const cached = await ctx.core.cache.get("key");

    // Background Jobs
    await ctx.core.jobs.enqueue("send-email", { to: "user@example.com" });

    // Events (pub/sub)
    await ctx.core.events.emit("user.created", { userId: "123" });

    // Rate Limiting
    const { allowed } = await ctx.core.rateLimiter.check("user:123", 10, 60000);

    // SSE Broadcast
    ctx.core.sse.broadcast("notifications", "new-message", { text: "Hello" });
  },
}),
```

---

## Plugin Dependencies

Access other plugins via `ctx.plugins`:

```ts
// src/server/plugins/orders/index.ts
export const ordersPlugin = createPlugin
  .withSchema<{ orders: OrdersTable }>()
  .define({
    name: "orders",
    dependencies: ["users"],  // Declare dependency
    service: async (ctx) => ({
      createOrder: async (userId: string, items: Item[]) => {
        // Access users plugin
        const user = await ctx.plugins.users.getById(userId);  // ✅
        if (!user) throw ctx.errors.NotFound("User not found");

        // Create order...
      },
    }),
  });
```

---

## Generated Files - DO NOT EDIT

These files are auto-generated and will be overwritten:

```
src/lib/api.ts                    # Typed API client - regenerated by donkeylabs generate
.@donkeylabs/                     # Type definitions - gitignored
```

**After ANY change to plugins, routes, or migrations, run:**
```sh
bunx donkeylabs generate
```

---

## Creating Features

### 1. Create a Plugin (Business Logic)

```ts
// src/server/plugins/users/index.ts
import { createPlugin } from "@donkeylabs/server";

export const usersPlugin = createPlugin
  .withSchema<{ users: UsersTable }>()
  .define({
    name: "users",
    service: async (ctx) => ({
      getById: async (id: string) => {
        return ctx.db
          .selectFrom("users")
          .where("id", "=", id)
          .selectAll()
          .executeTakeFirst();
      },
      create: async (data: { email: string; name: string }) => {
        const id = crypto.randomUUID();
        await ctx.db
          .insertInto("users")
          .values({ id, ...data, created_at: new Date().toISOString() })
          .execute();
        return { id };
      },
    }),
  });
```

### 2. Create Routes (API Endpoints)

```ts
// src/server/routes/users.ts
import { createRouter, defineRoute } from "@donkeylabs/server";
import { z } from "zod";

const users = createRouter("users");

users.route("get").typed(
  defineRoute({
    input: z.object({ id: z.string() }),
    output: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
    }).nullable(),
    handle: async (input, ctx) => {
      return ctx.plugins.users.getById(input.id);
    },
  })
);

users.route("create").typed(
  defineRoute({
    input: z.object({
      email: z.string().email(),
      name: z.string().min(1),
    }),
    output: z.object({ id: z.string() }),
    handle: async (input, ctx) => {
      return ctx.plugins.users.create(input);
    },
  })
);

export default users;
```

---

## Feature Module Pattern (Recommended for App Routes)

**For app-specific routes, use feature modules with handler classes containing business logic.**

**Plugins** = Reusable power-ups (auth, notifications, payments)
**Feature Modules** = App-specific handlers with business logic

### Structure

```
src/server/routes/orders/
├── index.ts                    # Router (thin) - just wires handlers to routes
├── orders.schemas.ts           # Zod schemas + TypeScript types
├── handlers/
│   ├── create.handler.ts       # CreateOrderHandler - contains business logic
│   ├── list.handler.ts         # ListOrdersHandler
│   └── get-by-id.handler.ts    # GetOrderByIdHandler
└── orders.test.ts              # Tests for handlers
```

### Handler Class (Business Logic Lives Here)

```ts
// handlers/create.handler.ts
import type { Handler, Routes, AppContext } from "$server/api";

export class CreateOrderHandler implements Handler<Routes.Orders.Create> {
  constructor(private ctx: AppContext) {}

  async handle(input: Routes.Orders.Create.Input): Promise<Routes.Orders.Create.Output> {
    // Validate business rules
    const user = await this.ctx.plugins.auth.getCurrentUser();
    if (!user) throw this.ctx.errors.Unauthorized("Must be logged in");

    // Database operations
    const id = crypto.randomUUID();
    await this.ctx.db
      .insertInto("orders")
      .values({ id, user_id: user.id, ...input })
      .execute();

    // Use plugins for cross-cutting concerns
    await this.ctx.plugins.notifications.send(user.id, "Order created");

    // Return result
    return this.ctx.db
      .selectFrom("orders")
      .where("id", "=", id)
      .selectAll()
      .executeTakeFirstOrThrow();
  }
}
```

### Router (Thin Wiring Only)

```ts
// index.ts
import { createRouter } from "@donkeylabs/server";
import { createOrderSchema, orderSchema, listOrdersSchema } from "./orders.schemas";
import { CreateOrderHandler } from "./handlers/create.handler";
import { ListOrdersHandler } from "./handlers/list.handler";

export const ordersRouter = createRouter("orders")

  .route("create").typed({
    input: createOrderSchema,
    output: orderSchema,
    handle: CreateOrderHandler,
  })

  .route("list").typed({
    input: listOrdersSchema,
    output: orderSchema.array(),
    handle: ListOrdersHandler,
  });
```

### Schemas (Validation + Types)

```ts
// orders.schemas.ts
import { z } from "zod";

export const createOrderSchema = z.object({
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number().int().positive(),
  })),
  shippingAddress: z.string(),
});

export const orderSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "paid", "shipped", "delivered"]),
  total: z.number(),
  createdAt: z.string(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type Order = z.infer<typeof orderSchema>;
```

### Testing Handlers Directly

```ts
// orders.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { createTestHarness } from "@donkeylabs/server/harness";
import { CreateOrderHandler } from "./handlers/create.handler";

describe("CreateOrderHandler", () => {
  let handler: CreateOrderHandler;

  beforeEach(async () => {
    const { ctx } = await createTestHarness();
    handler = new CreateOrderHandler(ctx);
  });

  test("creates order successfully", async () => {
    const order = await handler.handle({
      items: [{ productId: "prod-1", quantity: 2 }],
      shippingAddress: "123 Main St",
    });

    expect(order.id).toBeDefined();
    expect(order.status).toBe("pending");
  });
});
```

### When to Use Feature Modules vs Plugins

| Use Feature Modules | Use Plugins |
|---------------------|-------------|
| App-specific routes | Reusable across projects |
| Business logic for one feature | Shared services (auth, email) |
| CRUD operations | Database schemas with migrations |
| Route handlers with context | Middleware, cron jobs, events |

---

### Route Handler Types

**Use the right handler for each use case:**

| Handler | Use Case | Input | Output |
|---------|----------|-------|--------|
| `.typed()` | Standard JSON APIs | Zod JSON | Zod JSON |
| `.stream()` | File downloads, video/images | Zod | Response (binary) |
| `.sse()` | Real-time notifications | Zod | SSE connection |
| `.formData()` | File uploads | Zod fields + files | Zod JSON |
| `.html()` | htmx, server components | Zod | HTML string |
| `.raw()` | Proxies, WebSockets | Request | Response |

```ts
// Stream handler - for file downloads, video, images
router.route("files.download").stream({
  input: z.object({ fileId: z.string() }),
  handle: async (input, ctx) => {
    const file = await ctx.plugins.storage.getFile(input.fileId);
    return new Response(file.stream, {
      headers: { "Content-Type": file.mimeType },
    });
  },
});

// SSE handler - for real-time updates with typed events
router.route("notifications.subscribe").sse({
  input: z.object({ userId: z.string() }),
  events: {
    notification: z.object({ message: z.string(), id: z.string() }),
    alert: z.object({ level: z.string(), text: z.string() }),
  },
  handle: (input, ctx) => {
    // Return channel names to subscribe to
    return [`user:${input.userId}`, "global"];
  },
});

// FormData handler - for file uploads
router.route("files.upload").formData({
  input: z.object({ folder: z.string() }),
  files: { maxSize: 10 * 1024 * 1024, accept: ["image/*"] },
  handle: async ({ fields, files }, ctx) => {
    const ids = await Promise.all(
      files.map((f) => ctx.plugins.storage.save(f, fields.folder))
    );
    return { ids };
  },
});

// HTML handler - for htmx partials
router.route("partials.userCard").html({
  input: z.object({ userId: z.string() }),
  handle: async (input, ctx) => {
    const user = await ctx.plugins.users.getById(input.userId);
    return `<div class="card">${user.name}</div>`;
  },
});
```

**Using stream routes in Svelte:**
```svelte
<script lang="ts">
  const api = createApi();
</script>

<!-- Use .url() for browser src attributes -->
<video src={api.files.download.url({ fileId: "video-123" })} controls />
<img src={api.images.thumbnail.url({ id: "img-456" })} />
<a href={api.files.download.url({ fileId: "doc-789" })} download>Download</a>
```

### 3. Register in Server

```ts
// src/server/index.ts
import { AppServer } from "@donkeylabs/server";
import { usersPlugin } from "./plugins/users";
import usersRoutes from "./routes/users";

export const server = new AppServer({
  db,
  port: 0,
  generateTypes: { output: "./src/lib/api.ts" },
});

server.registerPlugin(usersPlugin);
server.use(usersRoutes);
server.handleGenerateMode();
```

### 4. Use in SvelteKit Page

```ts
// src/routes/users/+page.server.ts
import { createApi } from "$lib/api";

export const load = async ({ locals }) => {
  const api = createApi({ locals }); // Direct call, no HTTP overhead
  const users = await api.users.list({});
  return { users };
};
```

```svelte
<!-- src/routes/users/+page.svelte -->
<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { createApi } from "$lib/api";

  let { data } = $props();
  const api = createApi();

  // Use $derived for SSR data (updates on navigation)
  let users = $derived(data.users);

  // For refresh, we need local state + watch pattern
  let localUsers = $state<typeof data.users | null>(null);
  let displayUsers = $derived(localUsers ?? users);
  let loading = $state(false);

  async function refresh() {
    loading = true;
    try {
      localUsers = await api.users.list({});
    } finally {
      loading = false;
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Users</CardTitle>
  </CardHeader>
  <CardContent>
    {#each displayUsers as user}
      <p>{user.name} - {user.email}</p>
    {/each}
    <Button onclick={refresh} disabled={loading}>
      {loading ? "Loading..." : "Refresh"}
    </Button>
  </CardContent>
</Card>
```

---

## Middleware - Auth, Rate Limiting, etc.

**Apply middleware to routes for cross-cutting concerns:**

```ts
// Routes with middleware chain
const router = createRouter("api");

// Single middleware
router.middleware
  .auth({ required: true })
  .route("protected").typed({
    handle: async (input, ctx) => {
      // ctx.user is set by auth middleware
      return { userId: ctx.user.id };
    },
  });

// Chained middleware (executes left to right)
router.middleware
  .cors({ origin: "*" })
  .auth({ required: true })
  .rateLimit({ limit: 100, window: "1m" })
  .route("admin").typed({
    handle: async (input, ctx) => { ... },
  });

// Reusable middleware chain
const protectedRoute = router.middleware
  .auth({ required: true })
  .rateLimit({ limit: 1000, window: "1h" });

protectedRoute.route("users.list").typed({ ... });
protectedRoute.route("users.create").typed({ ... });
```

**Creating custom middleware in a plugin:**

```ts
// src/server/plugins/auth/index.ts
import { createPlugin, createMiddleware } from "@donkeylabs/server";

export const authPlugin = createPlugin.define({
  name: "auth",

  // Service MUST come before middleware
  service: async (ctx) => ({
    validateToken: async (token: string) => {
      // Validation logic...
      return { id: "user-123", role: "admin" };
    },
  }),

  // Middleware can access its own service
  middleware: (ctx, service) => ({
    auth: createMiddleware<{ required?: boolean }>(
      async (req, reqCtx, next, config) => {
        const token = req.headers.get("Authorization")?.replace("Bearer ", "");

        if (!token && config?.required) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (token) {
          reqCtx.user = await service.validateToken(token);
        }

        return next();  // Continue to handler
      }
    ),
  }),
});
```

---

## Testing

**Use the test harness for plugin testing:**

```ts
// src/server/plugins/users/tests/unit.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { createTestHarness } from "@donkeylabs/server/harness";
import { usersPlugin } from "../index";

describe("usersPlugin", () => {
  let users: ReturnType<typeof manager.getServices>["users"];
  let db: Awaited<ReturnType<typeof createTestHarness>>["db"];

  beforeEach(async () => {
    // Fresh in-memory DB for each test
    const harness = await createTestHarness(usersPlugin);
    users = harness.manager.getServices().users;
    db = harness.db;
  });

  test("create() inserts user", async () => {
    const user = await users.create({ email: "test@example.com", name: "Test" });

    expect(user.id).toBeDefined();

    // Verify in database
    const dbUser = await db
      .selectFrom("users")
      .where("id", "=", user.id)
      .selectAll()
      .executeTakeFirst();

    expect(dbUser?.email).toBe("test@example.com");
  });
});
```

**With plugin dependencies:**

```ts
import { ordersPlugin } from "../plugins/orders";
import { usersPlugin } from "../plugins/users";

// ordersPlugin depends on usersPlugin
const { manager } = await createTestHarness(ordersPlugin, [usersPlugin]);

const orders = manager.getServices().orders;
const users = manager.getServices().users;
```

---

## Generated API Client - Full Capabilities

**ALWAYS use `createApi()` from `$lib/api.ts`. NEVER use raw fetch/EventSource.**

### Basic API Calls

```ts
import { createApi } from "$lib/api";

const api = createApi();

// All calls are typed - input and output
const user = await api.users.get({ id: "123" });
const result = await api.users.create({ email: "a@b.com", name: "Test" });
```

### SSE (Server-Sent Events)

```ts
// Subscribe to channels with auto-reconnect
const unsubscribe = api.sse.subscribe(
  ["notifications", "alerts"],  // Channel names
  (eventType, data) => {
    // eventType: "cron-event", "job-completed", "manual", etc.
    // data: Already parsed JSON
    console.log(eventType, data);
  },
  { reconnect: true }  // Auto-reconnect on disconnect (default: true)
);

// Cleanup in onMount return or when done
onMount(() => {
  const unsub = api.sse.subscribe([...], callback);
  return () => unsub();  // Cleanup on unmount
});
```

### File Uploads (FormData)

```ts
// If a route uses .formData() handler
const result = await api.files.upload(
  { folder: "avatars", userId: "123" },  // Typed fields
  [selectedFile]  // File objects
);
```

### Streaming Responses

```ts
// For routes that return streams (video, large files, etc.)
const response = await api.media.stream({ videoId: "abc" });
// response is raw Response - handle as needed

// Or get URL for <video>, <img>, <a download>
const videoUrl = api.media.streamUrl({ videoId: "abc" });
// Use in: <video src={videoUrl}>
```

### HTML Responses

```ts
// For routes that return HTML
const html = await api.reports.render({ reportId: "123" });
// html is a string
```

### SSR vs Browser - The Client Handles It

```ts
// +page.server.ts - Direct calls, no HTTP
export const load = async ({ locals }) => {
  const api = createApi({ locals });  // Uses locals.handleRoute
  return { data: await api.users.list({}) };
};

// +page.svelte - HTTP calls automatically
const api = createApi();  // Uses fetch internally
```

---

## Database Queries with Kysely

**Always use Kysely query builder, never raw SQL:**

```ts
// ✅ SELECT
const user = await ctx.db
  .selectFrom("users")
  .where("id", "=", id)
  .selectAll()
  .executeTakeFirst();

// ✅ INSERT
await ctx.db
  .insertInto("users")
  .values({ id, email, name })
  .execute();

// ✅ UPDATE
await ctx.db
  .updateTable("users")
  .set({ name: newName })
  .where("id", "=", id)
  .execute();

// ✅ DELETE
await ctx.db
  .deleteFrom("users")
  .where("id", "=", id)
  .execute();

// ✅ JOIN
const orders = await ctx.db
  .selectFrom("orders")
  .innerJoin("users", "users.id", "orders.user_id")
  .select(["orders.id", "orders.total", "users.name"])
  .execute();
```

---

## Commands

```sh
bun run dev              # Start development server
bun run build            # Build for production
bun test                 # Run tests
bun --bun tsc --noEmit   # Type check

# After adding plugins/routes/migrations:
bunx donkeylabs generate  # Regenerate types
```

---

## MCP Tools Available

| Tool | Description |
|------|-------------|
| `get_project_info` | Get project structure overview |
| `create_plugin` | Create a new plugin with correct structure |
| `add_migration` | Create a Kysely migration file |
| `add_service_method` | Add method to plugin service |
| `create_router` | Create a new route file |
| `add_route` | Add route to existing router |
| `generate_types` | Regenerate TypeScript types |
| `list_plugins` | List all plugins and methods |

---

## Detailed Documentation

**For advanced topics, read the corresponding file in `docs/`:**

| Topic | File | When to Read |
|-------|------|--------------|
| All handler types | `docs/handlers.md` | Creating stream, SSE, formData, HTML, or raw routes |
| Middleware | `docs/middleware.md` | Creating custom auth, rate limiting, CORS |
| Database & Migrations | `docs/database.md` | Complex Kysely queries, transactions, joins |
| Plugins | `docs/plugins.md` | Plugin lifecycle, dependencies, init hooks |
| Testing | `docs/testing.md` | Test harness, mocking, integration tests |
| Background Jobs | `docs/jobs.md` | Async job processing, retries |
| Cron Tasks | `docs/cron.md` | Scheduled tasks |
| SSE | `docs/sse.md` | Server-sent events, broadcasting |
| Workflows | `docs/workflows.md` | Step functions, parallel execution, state machines |
| Router | `docs/router.md` | Route definitions, prefixes, nesting |
| Errors | `docs/errors.md` | Custom error types, error handling |
| SvelteKit Adapter | `docs/sveltekit-adapter.md` | Hooks, SSR integration, API client |

---

## Key Reminders

1. **MCP First**: Always use MCP tools when available
2. **Kysely Only**: Never raw SQL in migrations or queries
3. **shadcn-svelte**: Only UI library for components
4. **No $effect**: Use `watch` from **runed** for reactive effects, `onMount` for lifecycle
5. **$derived for props**: Never `$state(data.x)` - use `$derived(data.x)` for reactive props
6. **Loading states**: Always track loading/error states for async operations
7. **Thin Routes**: Keep handlers thin, business logic in plugins
8. **ctx.errors**: Use `ctx.errors.NotFound()`, etc. for proper error responses
9. **Number migrations**: Always prefix with 001_, 002_, etc.
10. **Generate Types**: Run `bunx donkeylabs generate` after any plugin/route/migration changes
11. **SSR vs Browser**: Pass `{ locals }` in +page.server.ts, nothing in +page.svelte
12. **Never raw fetch**: ALWAYS use `createApi()` client - never `fetch()` or `new EventSource()`
13. **Right handler type**: Use `.typed()` for JSON, `.stream()` for files, `.sse()` for real-time, `.formData()` for uploads
14. **Auth via middleware**: Use `router.middleware.auth({ required: true })` for protected routes
15. **Test with harness**: Use `createTestHarness(plugin)` for isolated in-memory testing
