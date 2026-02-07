# Project Structure

This guide explains the canonical structure, naming conventions, and patterns for this framework. Following these conventions ensures consistency and maintainability.

---

## Directory Layout

```
project-root/
├── core.ts              # Plugin system, PluginManager, type helpers
├── router.ts            # Route builder, handler registry
├── handlers.ts          # TypedHandler, RawHandler, createHandler
├── middleware.ts        # Middleware system, createMiddleware
├── server.ts            # AppServer, HTTP handling
├── harness.ts           # Test harness factory
├── index.ts             # Main entry point (or server.ts)
│
├── context.d.ts         # [GENERATED] Global context types
├── registry.d.ts        # [GENERATED] Plugin/handler registry
│
├── core/                # Core services
│   ├── index.ts         # Re-exports all services
│   ├── logger.ts        # Logger service
│   ├── cache.ts         # Cache service
│   ├── events.ts        # Events service
│   ├── cron.ts          # Cron service
│   ├── jobs.ts          # Jobs service
│   ├── sse.ts           # SSE service
│   └── rate-limiter.ts  # Rate limiter
│
├── plugins/             # Plugin modules
│   ├── auth/
│   │   ├── index.ts     # Plugin definition (REQUIRED)
│   │   ├── schema.ts    # Generated DB types
│   │   └── migrations/  # SQL migrations
│   │       ├── 001_create_users.ts
│   │       └── 002_add_roles.ts
│   ├── orders/
│   │   ├── index.ts
│   │   ├── schema.ts
│   │   └── migrations/
│   └── ...
│
├── scripts/             # CLI and generation scripts
│   ├── cli.ts           # Interactive CLI
│   ├── create-plugin.ts # Plugin scaffolding
│   ├── create-server.ts # Server scaffolding
│   ├── generate-registry.ts
│   ├── generate-types.ts
│   └── watch.ts
│
├── test/                # Test files
│   ├── core/            # Core service tests
│   ├── plugins/         # Plugin tests
│   └── integration.test.ts
│
├── docs/                # Documentation
│
├── package.json
├── tsconfig.json
└── CLAUDE.md            # Framework documentation
```

---

## File Naming Conventions

| Pattern | Example | Purpose |
|---------|---------|---------|
| `index.ts` | `plugins/auth/index.ts` | Plugin entry point |
| `schema.ts` | `plugins/auth/schema.ts` | Generated database types |
| `NNN_name.ts` | `001_create_users.ts` | Migrations (numbered) |
| `*.test.ts` | `auth.test.ts` | Test files |
| `*.d.ts` | `registry.d.ts` | Type declarations |

---

## Plugin Structure

Every plugin MUST follow this structure:

```
plugins/<name>/
├── index.ts          # Plugin definition (REQUIRED)
├── schema.ts         # Database types (if using DB)
└── migrations/       # Migrations (if using DB)
    ├── 001_initial.ts
    ├── 002_add_column.ts
    └── ...
```

### Plugin index.ts Template

```ts
// plugins/<name>/index.ts
import { createPlugin } from "../../core";
import type { DB } from "./schema";  // If using database

// Configuration type (if plugin is configurable)
interface MyPluginConfig {
  option1: string;
  option2?: number;
}

export const myPlugin = createPlugin
  .withSchema<DB>()           // Add if using database
  .withConfig<MyPluginConfig>() // Add if configurable
  .define({
    name: "myPlugin",
    dependencies: [],          // Other plugins this depends on
    handlers: {},              // Custom handlers
    middleware: {},            // Custom middleware

    // Main service factory
    service: async (ctx) => {
      // ctx.db - Database with your schema
      // ctx.deps - Services from dependencies
      // ctx.config - Your configuration

      return {
        // Service methods exposed via ctx.plugins.myPlugin
        myMethod: async () => { ... },
      };
    },
  });
```

---

## Routes Structure

Routes should be organized by domain:

```
routes/
├── index.ts          # Export all routers
├── users.ts          # createRouter("users")
├── orders.ts         # createRouter("orders")
└── admin.ts          # createRouter("admin")
```

### Route File Template

```ts
// routes/users.ts
import { createRouter } from "../router";
import { z } from "zod";

export const usersRouter = createRouter("users")
  .route("list").typed({
    input: z.object({ page: z.number().default(1) }),
    handle: async (input, ctx) => {
      return ctx.plugins.users.list(input.page);
    },
  })

  .route("get").typed({
    input: z.object({ id: z.number() }),
    handle: async (input, ctx) => {
      return ctx.plugins.users.getById(input.id);
    },
  })

  .middleware.auth({ required: true })
  .route("create").typed({
    input: z.object({ email: z.string().email(), name: z.string() }),
    handle: async (input, ctx) => {
      return ctx.plugins.users.create(input);
    },
  });
```

---

## Do's and Don'ts

### DO: Use the Plugin System

```ts
// GOOD: Business logic in plugin service
// plugins/orders/index.ts
service: async (ctx) => ({
  async create(data: OrderData) {
    const order = await ctx.db.insertInto("orders").values(data).execute();
    await ctx.core.events.emit("order.created", order);
    return order;
  },
})

// Route handler just calls service
router.route("create").typed({
  handle: async (input, ctx) => ctx.plugins.orders.create(input),
});
```

```ts
// BAD: Business logic in route handler
router.route("create").typed({
  handle: async (input, ctx) => {
    // 50 lines of business logic here...
    const order = await ctx.db.insertInto("orders")...
    // validation...
    // event emission...
    // etc...
  },
});
```

### DO: Use Core Services

```ts
// GOOD: Use built-in services
ctx.core.logger.info("Order created", { orderId: order.id });
ctx.core.cache.set(`order:${id}`, order, 60000);
ctx.core.events.emit("order.created", order);
ctx.core.jobs.enqueue("sendOrderEmail", { orderId: order.id });
```

```ts
// BAD: Roll your own
console.log("Order created:", order.id);  // No structured logging
const cache = new Map();  // No TTL, no persistence
```

### DO: Use Type-Safe Patterns

```ts
// GOOD: Zod schemas for validation
router.route("create").typed({
  input: z.object({
    email: z.string().email(),
    age: z.number().int().positive(),
  }),
  handle: async (input, ctx) => {
    // input is fully typed
  },
});
```

```ts
// BAD: Manual validation
router.route("create").typed({
  handle: async (input: any, ctx) => {
    if (!input.email || !input.email.includes("@")) {
      throw new Error("Invalid email");
    }
    // More manual checks...
  },
});
```

### DO: Use Middleware for Cross-Cutting Concerns

```ts
// GOOD: Middleware
router.middleware
  .auth({ required: true })
  .rateLimit({ limit: 100, window: "1m" })
  .route("protected").typed({ ... });
```

```ts
// BAD: Duplicated in every handler
router.route("protected1").typed({
  handle: async (input, ctx) => {
    if (!ctx.user) throw new Error("Unauthorized");
    // rate limit check...
  },
});
router.route("protected2").typed({
  handle: async (input, ctx) => {
    if (!ctx.user) throw new Error("Unauthorized");  // Duplicated!
    // rate limit check...
  },
});
```

### DO: Follow Naming Conventions

```ts
// GOOD: Consistent naming
export const authPlugin = createPlugin.define({ name: "auth", ... });
export const usersRouter = createRouter("users");

// Plugin service methods: verb + noun
service: (ctx) => ({
  createUser: async (data) => { ... },
  getUserById: async (id) => { ... },
  updateUser: async (id, data) => { ... },
  deleteUser: async (id) => { ... },
})
```

```ts
// BAD: Inconsistent naming
export const AUTH = createPlugin.define({ name: "Authentication", ... });
export const router = createRouter("Users");

service: (ctx) => ({
  create: async (data) => { ... },  // Unclear what's being created
  get: async (id) => { ... },        // Unclear what's being retrieved
})
```

### DON'T: Create Unnecessary Files (But DO Split When Needed)

The right structure depends on plugin size. Don't create files you don't need, but don't cram everything into one file either.

```
// Small plugin (< 200 lines) — single file is fine
plugins/notifications/
├── index.ts          // Everything here
├── schema.ts
└── migrations/

// Medium plugin (200-500 lines) — extract service
plugins/orders/
├── index.ts          // Plugin definition + wiring only
├── service.ts        // Service class with business logic
├── schema.ts
└── migrations/

// Large plugin (500+ lines) — full split
plugins/auth/
├── index.ts          // Plugin definition + wiring (< 100 lines)
├── types.ts          // Interfaces, type aliases
├── service.ts        // Service class with business logic
├── helpers.ts        // Pure utility functions
├── constants.ts      // Configuration constants
├── schema.ts
└── migrations/
```

**Avoid** deeply nested subdirectories (`types/`, `services/`, `utils/`). Flat files at the plugin root are enough:

```ts
// BAD: Nested subdirectories with barrel exports
plugins/auth/types/index.ts
plugins/auth/types/user.ts
plugins/auth/services/index.ts
plugins/auth/services/auth.service.ts

// GOOD: Flat files at plugin root
plugins/auth/types.ts
plugins/auth/service.ts
```

See [Code Organization Guide](./code-organization.md) for detailed rules on when and how to split.

### DON'T: Edit Generated Files

```ts
// BAD: Editing generated files
// registry.d.ts - THIS IS GENERATED, DO NOT EDIT

// GOOD: Regenerate instead
bun run gen:registry
```

### DON'T: Import Internals Directly

```ts
// BAD: Importing internal implementation
import { someInternalFunction } from "./plugins/auth/internal";

// GOOD: Use plugin service
ctx.plugins.auth.publicMethod();
```

---

## Migration Patterns

### Creating Tables

```ts
// plugins/<name>/migrations/001_create_orders.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("orders")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("userId", "integer", (col) => col.notNull())
    .addColumn("total", "real", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("createdAt", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("orders_user_idx")
    .on("orders")
    .column("userId")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("orders").execute();
}
```

### Adding Columns

```ts
// plugins/<name>/migrations/002_add_shipping.ts
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("orders")
    .addColumn("shippingAddress", "text")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("orders")
    .dropColumn("shippingAddress")
    .execute();
}
```

---

## Testing Patterns

### Plugin Unit Tests

```ts
// test/plugins/auth.test.ts
import { createTestHarness } from "../../harness";
import { authPlugin } from "../../plugins/auth";

describe("Auth Plugin", () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;

  beforeEach(async () => {
    harness = await createTestHarness(authPlugin);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("creates user", async () => {
    const service = harness.manager.getServices().auth;
    const user = await service.createUser({ email: "test@test.com" });
    expect(user.email).toBe("test@test.com");
  });
});
```

### Integration Tests

```ts
// test/integration.test.ts
import { createTestHarness } from "../harness";
import { authPlugin } from "../plugins/auth";
import { ordersPlugin } from "../plugins/orders";

describe("Integration", () => {
  test("orders plugin uses auth", async () => {
    const { manager } = await createTestHarness(ordersPlugin, [authPlugin]);

    const auth = manager.getServices().auth;
    const orders = manager.getServices().orders;

    const user = await auth.createUser({ email: "test@test.com" });
    const order = await orders.create({ userId: user.id, total: 100 });

    expect(order.userId).toBe(user.id);
  });
});
```

---

## Checklist for New Features

When adding a new feature:

- [ ] Create plugin in `plugins/<name>/index.ts`
- [ ] Add database schema if needed (`migrations/`)
- [ ] Export plugin from index
- [ ] Run `bun run gen:registry`
- [ ] Add routes in `routes/<name>.ts`
- [ ] Register router in server
- [ ] Add tests in `test/`
- [ ] Run `bun test` to verify
- [ ] Run `bun --bun tsc --noEmit` to type check

---

## Common Mistakes to Avoid

1. **Putting business logic in route handlers** - Use plugin services
2. **Not using Zod validation** - Always validate input
3. **Editing generated files** - Regenerate instead
4. **Wrong file granularity** - Split at 200 lines, see [Code Organization Guide](./code-organization.md)
5. **Not running gen:registry** - Do this after any plugin change
6. **Manual auth/rate limit checks** - Use middleware
7. **Console.log for logging** - Use `ctx.core.logger`
8. **Rolling your own cache** - Use `ctx.core.cache`
9. **Duplicating code across routes** - Extract to plugin service
10. **Forgetting to emit events** - Use `ctx.core.events` for side effects
