# Code Organization Guide

Rules for structuring Donkeylabs plugins and routes as they grow. Follow these rules exactly — they prevent the most common structural problems.

---

## 1. File Size Rules

| Threshold | Action |
|-----------|--------|
| Any file > 200 lines | Split it |
| Plugin `index.ts` > 300 lines | Extract service, types, helpers |
| Route handler > 50 lines | Move business logic to plugin service |
| Single function > 40 lines | Break into smaller functions |

**The 300-line rule for `index.ts`**: A plugin's `index.ts` should contain only the plugin definition and wiring. If it's over 300 lines, you have business logic that belongs in a separate `service.ts`.

---

## 2. Plugin File Structure

### Small plugin (< 200 lines total) — single file is fine

```
plugins/notifications/
├── index.ts          # Everything here
├── schema.ts         # If using database
└── migrations/
```

### Medium plugin (200–500 lines) — extract the service

```
plugins/orders/
├── index.ts          # Plugin definition + wiring only
├── service.ts        # Service class with business logic
├── schema.ts
└── migrations/
```

### Large plugin (500+ lines) — full split

```
plugins/auth/
├── index.ts          # Plugin definition + wiring only (< 100 lines)
├── types.ts          # Interfaces, type aliases, enums
├── service.ts        # Service class with business logic
├── helpers.ts        # Pure utility functions
├── constants.ts      # Configuration constants, magic strings
├── schema.ts
└── migrations/
```

### What goes where

| File | Contains | Does NOT contain |
|------|----------|-----------------|
| `index.ts` | `createPlugin.define()`, imports, wiring | Business logic, type definitions, helpers |
| `service.ts` | Service class, all business methods | Plugin definition, Zod schemas |
| `types.ts` | Interfaces, type aliases, enums | Implementation code |
| `helpers.ts` | Pure functions (no `ctx` dependency) | Stateful logic, database calls |
| `constants.ts` | String literals, config defaults, enums | Functions, classes |

---

## 3. Service Class Pattern

For any plugin with more than 2-3 trivial methods, use a service class.

### BAD: Inline object literal with all logic in `index.ts`

```ts
// plugins/orders/index.ts — 800 lines, untestable, unreadable
export const ordersPlugin = createPlugin.withSchema<DB>().define({
  name: "orders",
  service: async (ctx) => ({
    async create(data: OrderInput) {
      // 40 lines of validation...
      // 30 lines of database calls...
      // 20 lines of event emission...
    },
    async fulfill(orderId: string) {
      // 60 more lines...
    },
    async refund(orderId: string, reason: string) {
      // 50 more lines...
    },
    // ... 10 more methods
  }),
});
```

### GOOD: Service class in separate file

```ts
// plugins/orders/service.ts
import type { PluginContext } from "../../core";
import type { DB } from "./schema";

export class OrdersService {
  constructor(private ctx: PluginContext<DB>) {}

  async create(data: OrderInput) {
    const validated = this.validateOrder(data);
    const order = await this.ctx.db
      .insertInto("orders")
      .values(validated)
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.ctx.core.events.emit("order.created", { orderId: order.id });
    return order;
  }

  async fulfill(orderId: string) {
    // Clear, focused method
  }

  async refund(orderId: string, reason: string) {
    // Clear, focused method
  }

  private validateOrder(data: OrderInput) {
    // Private helper — testable via public methods
  }
}
```

```ts
// plugins/orders/index.ts — thin wiring, ~30 lines
import { createPlugin } from "../../core";
import type { DB } from "./schema";
import { OrdersService } from "./service";

export const ordersPlugin = createPlugin.withSchema<DB>().define({
  name: "orders",
  service: async (ctx) => {
    const svc = new OrdersService(ctx);
    return {
      create: svc.create.bind(svc),
      fulfill: svc.fulfill.bind(svc),
      refund: svc.refund.bind(svc),
    };
  },
});
```

### Why classes?

- **Testable**: Instantiate with a mock `ctx`, test methods in isolation
- **Readable**: Each method is focused, private helpers stay private
- **Navigable**: IDE jump-to-definition works, not lost in a 500-line object literal
- **Maintainable**: Adding a method doesn't balloon a single file

---

## 4. Generated Types — NEVER Use `as any`

After running `donkeylabs generate`, the framework produces fully-typed declarations. Use them.

### Rule: zero `as any` casts for framework types

If you find yourself writing `as any`, you either:
1. Haven't run `donkeylabs generate` yet, or
2. Are importing the wrong type

### Available generated types

| Type | Source | Usage |
|------|--------|-------|
| `AppContext` | Inferred from your server instance | Route handlers, middleware |
| `PluginRegistry` | Generated from registered plugins | `ctx.plugins.<name>` is fully typed |
| `ServiceRegistry` | Generated from `defineService()` calls | `ctx.services.<name>` is fully typed |
| Route types | Generated from router schemas | Import input/output types |

### BAD: Casting to `any`

```ts
// Route handler with no type safety
router.route("create").typed({
  input: z.object({ email: z.string() }),
  handle: async (input: any, ctx: any) => {
    const users = (ctx as any).plugins.users;
    const result = await users.create(input);
    return result as any;
  },
});
```

### GOOD: Using inferred types

```ts
// Types flow automatically — no casts needed
router.route("create").typed({
  input: z.object({ email: z.string() }),
  handle: async (input, ctx) => {
    // ctx.plugins.users is fully typed after `donkeylabs generate`
    return ctx.plugins.users.create(input);
  },
});
```

### BAD: Typing `ctx` manually

```ts
// Don't hand-write context types
service: async (ctx: { db: any; core: any; deps: any }) => {
```

### GOOD: Let the framework infer

```ts
// ctx is fully typed by createPlugin's generics
service: async (ctx) => {
  ctx.db;      // Typed as Kysely<DB> (from withSchema<DB>())
  ctx.core;    // Typed as CoreServices
  ctx.deps;    // Typed based on dependencies array
  ctx.config;  // Typed as your config interface (from withConfig<T>())
}
```

### Getting your app's context type

```ts
// In your server setup file
import { AppServer } from "@donkeylabs/server";

const server = new AppServer({ ... });

// Export the context type for use across your app
export type AppContext = typeof server extends AppServer<infer C> ? C : never;
```

---

## 5. Route Type Imports — Don't Duplicate Zod Schemas

When route schemas are defined in a router, don't recreate them elsewhere. Import the inferred types instead.

### BAD: Duplicating schemas

```ts
// routes/users.ts
export const usersRouter = createRouter("users")
  .route("create").typed({
    input: z.object({ email: z.string(), name: z.string() }),
    handle: async (input, ctx) => ctx.plugins.users.create(input),
  });

// plugins/users/index.ts — duplicated schema!
const CreateUserInput = z.object({ email: z.string(), name: z.string() });
```

Now you have two sources of truth. When one changes, the other doesn't.

### GOOD: Single source of truth

Define schemas in one place (the router or a shared schemas file), then import the inferred types:

```ts
// routes/users/users.schemas.ts — single source of truth
import { z } from "zod";

export const createUserInput = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

export type CreateUserInput = z.infer<typeof createUserInput>;
```

```ts
// routes/users/index.ts
import { createUserInput } from "./users.schemas";

export const usersRouter = createRouter("users")
  .route("create").typed({
    input: createUserInput,
    handle: async (input, ctx) => ctx.plugins.users.create(input),
  });
```

```ts
// plugins/users/service.ts — imports the TYPE, not the schema
import type { CreateUserInput } from "../../routes/users/users.schemas";

export class UsersService {
  async create(data: CreateUserInput) {
    // ...
  }
}
```

### Where to define schemas

| Scenario | Location |
|----------|----------|
| Used by one route only | Inline in the router file |
| Used by route + plugin service | `routes/<name>/<name>.schemas.ts` |
| Used across multiple features | Shared `schemas/` directory |

---

## 6. Anti-Pattern Gallery

### Anti-pattern: Monolithic plugin file

**Symptom**: A single `index.ts` with 1000+ lines containing types, helpers, constants, and all service methods.

```ts
// BAD: plugins/billing/index.ts — 1200 lines
interface Invoice { ... }
interface PaymentMethod { ... }
interface Subscription { ... }
const TAX_RATES = { ... };
const CURRENCY_FORMATS = { ... };
function calculateTax(...) { ... }
function formatCurrency(...) { ... }
export const billingPlugin = createPlugin.define({
  name: "billing",
  service: async (ctx) => ({
    // 800 lines of methods...
  }),
});
```

**Fix**: Split into `types.ts`, `constants.ts`, `helpers.ts`, `service.ts`, and a thin `index.ts`.

---

### Anti-pattern: `as any` to silence type errors

**Symptom**: TypeScript errors "fixed" by casting instead of using correct types.

```ts
// BAD
const user = await (ctx as any).plugins.users.getById(id);
return { data: result } as any;
```

**Fix**: Run `donkeylabs generate` to update types. If types are still wrong, check that your plugin is registered in the server and the service return type is correct.

---

### Anti-pattern: Business logic in route handlers

**Symptom**: Route handlers with 30+ lines of logic instead of delegating to plugin services.

```ts
// BAD
router.route("create").typed({
  input: createOrderInput,
  handle: async (input, ctx) => {
    // 50 lines of validation, DB calls, event emission...
  },
});
```

**Fix**: Move logic to plugin service. Route handler should be a one-liner:

```ts
// GOOD
handle: async (input, ctx) => ctx.plugins.orders.create(input),
```

---

### Anti-pattern: Duplicated Zod schemas

**Symptom**: The same shape defined in both the router and the plugin.

**Fix**: Define once in a `.schemas.ts` file, import the schema in the router and the inferred type in the service. See [Section 5](#5-route-type-imports--dont-duplicate-zod-schemas).

---

### Anti-pattern: No dependency injection

**Symptom**: Service functions that import and call other services directly instead of receiving them through `ctx`.

```ts
// BAD: Hard-coded dependency
import { db } from "../../database";

export function createOrder(data: OrderInput) {
  return db.insertInto("orders").values(data).execute();
}
```

**Fix**: Use the plugin context:

```ts
// GOOD: Injected via ctx
export class OrdersService {
  constructor(private ctx: PluginContext<DB>) {}

  async createOrder(data: OrderInput) {
    return this.ctx.db.insertInto("orders").values(data).execute();
  }
}
```

---

## Quick Reference

```
Is your plugin file > 200 lines?
├─ No  → Single file is fine
└─ Yes → Is it > 500 lines?
    ├─ No  → Extract service.ts
    └─ Yes → Full split: types.ts, service.ts, helpers.ts, constants.ts

Is your route handler > 3 lines?
├─ No  → Fine as-is
└─ Yes → Move logic to plugin service

Are you writing `as any`?
├─ No  → Good
└─ Yes → Run `donkeylabs generate`, use inferred types

Are you copying a Zod schema to a second file?
├─ No  → Good
└─ Yes → Create a shared .schemas.ts, import from there
```
