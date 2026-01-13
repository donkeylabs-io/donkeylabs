# Plugins

Plugins are the core building blocks of this framework. Each plugin encapsulates database schema, business logic, custom handlers, and middleware into a self-contained module.

## Table of Contents

- [Creating a Plugin](#creating-a-plugin)
- [Plugin with Database Schema](#plugin-with-database-schema)
- [Plugin with Configuration](#plugin-with-configuration)
- [Plugin Dependencies](#plugin-dependencies)
- [Custom Handlers](#custom-handlers)
- [Custom Middleware](#custom-middleware)
- [Plugin Context](#plugin-context)
- [Type Inference](#type-inference)
- [Plugin Lifecycle](#plugin-lifecycle)

---

## Creating a Plugin

The simplest plugin exports a service that becomes available to all route handlers:

```ts
// plugins/greeter/index.ts
import { createPlugin } from "../../core";

export const greeterPlugin = createPlugin.define({
  name: "greeter",
  service: async (ctx) => {
    // Return the service object
    return {
      sayHello: (name: string) => `Hello, ${name}!`,
      sayGoodbye: (name: string) => `Goodbye, ${name}!`,
    };
  },
});
```

**Usage in routes:**

```ts
router.route("greet").typed({
  input: z.object({ name: z.string() }),
  handle: async (input, ctx) => {
    // Access via ctx.plugins.<pluginName>
    return { message: ctx.plugins.greeter.sayHello(input.name) };
  },
});
```

---

## Plugin with Database Schema

Plugins can define their own database tables. The framework automatically merges all plugin schemas for full type safety.

### Step 1: Create Migration

```ts
// plugins/users/migrations/001_create_users.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<any>) {
  await db.schema
    .createTable("users")
    .ifNotExists()
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("email", "text", (c) => c.notNull().unique())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.defaultTo("CURRENT_TIMESTAMP"))
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.dropTable("users").execute();
}
```

### Step 2: Generate Schema Types

```sh
bun scripts/generate-types.ts users
```

This creates `plugins/users/schema.ts` with Kysely types.

### Step 3: Define Plugin with Schema

```ts
// plugins/users/index.ts
import { createPlugin } from "../../core";
import type { DB as UsersSchema } from "./schema";

export const usersPlugin = createPlugin
  .withSchema<UsersSchema>()  // Enable typed database access
  .define({
    name: "users",
    service: async (ctx) => {
      return {
        async create(email: string, name: string) {
          // ctx.db is fully typed with UsersSchema!
          const result = await ctx.db
            .insertInto("users")
            .values({ email, name })
            .returning(["id", "email", "name"])
            .executeTakeFirstOrThrow();
          return result;
        },

        async findByEmail(email: string) {
          return ctx.db
            .selectFrom("users")
            .selectAll()
            .where("email", "=", email)
            .executeTakeFirst();
        },

        async list() {
          return ctx.db.selectFrom("users").selectAll().execute();
        },
      };
    },
  });
```

---

## Plugin with Configuration

Plugins can accept configuration at registration time using the factory pattern:

```ts
// plugins/email/index.ts
import { createPlugin } from "../../core";

export interface EmailConfig {
  apiKey: string;
  fromAddress: string;
  sandbox?: boolean;
}

export const emailPlugin = createPlugin
  .withConfig<EmailConfig>()  // Declare config type
  .define({
    name: "email",
    service: async (ctx) => {
      // Access config via ctx.config
      const { apiKey, fromAddress, sandbox } = ctx.config;

      return {
        async send(to: string, subject: string, body: string) {
          if (sandbox) {
            console.log(`[Sandbox] Would send to ${to}: ${subject}`);
            return { id: "sandbox-" + Date.now() };
          }

          // Real implementation using apiKey
          const response = await fetch("https://api.email.com/send", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ from: fromAddress, to, subject, body }),
          });

          return response.json();
        },

        getConfig() {
          return { fromAddress, sandbox };
        },
      };
    },
  });
```

**Registering with config:**

```ts
// The plugin becomes a factory function when using withConfig
server.registerPlugin(
  emailPlugin({
    apiKey: process.env.EMAIL_API_KEY!,
    fromAddress: "noreply@example.com",
    sandbox: process.env.NODE_ENV !== "production",
  })
);
```

---

## Plugin Dependencies

Plugins can depend on other plugins. Dependencies are resolved automatically in topological order.

```ts
// plugins/notifications/index.ts
import { createPlugin } from "../../core";

export const notificationsPlugin = createPlugin.define({
  name: "notifications",
  dependencies: ["users", "email"] as const,  // Declare dependencies
  service: async (ctx) => {
    // Access dependency services via ctx.deps
    const { users, email } = ctx.deps;

    return {
      async notifyUser(userId: number, message: string) {
        // Use the users plugin service
        const user = await users.findById(userId);
        if (!user) throw new Error("User not found");

        // Use the email plugin service
        await email.send(user.email, "Notification", message);

        // Log using core services
        ctx.core.logger.info("Notification sent", { userId, message });
      },
    };
  },
});
```

### Dependency Rules

1. **Dependencies must be registered first** - The framework validates this at startup
2. **No circular dependencies** - TypeScript will show an error at compile time
3. **No self-dependencies** - Compile-time error if plugin depends on itself

```ts
// This will cause a TypeScript error:
createPlugin.define({
  name: "foo",
  dependencies: ["foo"] as const,  // Error: Plugin 'foo' cannot depend on itself
  // ...
});
```

---

## Custom Handlers

Plugins can define custom request handlers for specialized processing:

```ts
// plugins/api/index.ts
import { createPlugin } from "../../core";
import { createHandler } from "../../handlers";
import type { ServerContext } from "../../router";

// Define handler signature
type XMLHandler = (xmlBody: string, ctx: ServerContext) => Promise<string>;

// Create handler implementation
const XMLRequestHandler = createHandler<XMLHandler>(
  async (req, def, handle, ctx) => {
    const body = await req.text();

    // Validate XML content type
    if (!req.headers.get("content-type")?.includes("xml")) {
      return new Response("Content-Type must be application/xml", { status: 400 });
    }

    const result = await handle(body, ctx);

    return new Response(result, {
      headers: { "Content-Type": "application/xml" },
    });
  }
);

export const apiPlugin = createPlugin.define({
  name: "api",
  handlers: {
    xml: XMLRequestHandler,  // Register handler
  },
  service: async () => ({}),
});
```

**After adding handlers, regenerate registry:**

```sh
bun run gen:registry
```

**Using custom handler in routes:**

```ts
router.route("process").xml({
  handle: async (xmlBody, ctx) => {
    // Process XML and return XML response
    return `<response><status>ok</status></response>`;
  },
});
```

---

## Custom Middleware

Plugins can provide middleware that can be applied to routes:

```ts
// plugins/auth/index.ts
import { createPlugin } from "../../core";
import { createMiddleware } from "../../middleware";

export interface AuthRequiredConfig {
  roles?: string[];
}

const AuthRequiredMiddleware = createMiddleware<AuthRequiredConfig>(
  async (req, ctx, next, config) => {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Verify token and set user
    const user = await verifyToken(token);
    ctx.user = user;

    // Check roles if specified
    if (config?.roles && !config.roles.some((r) => user.roles.includes(r))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    return next();
  }
);

export const authPlugin = createPlugin.define({
  name: "auth",
  middleware: {
    authRequired: AuthRequiredMiddleware,
  },
  service: async (ctx) => ({
    // Auth service methods...
  }),
});
```

**Using middleware in routes:**

```ts
// After running bun run gen:registry, middleware methods appear on router.middleware

router.middleware
  .authRequired({ roles: ["admin"] })
  .route("admin-only")
  .typed({
    handle: async (input, ctx) => {
      // ctx.user is guaranteed to be set and have admin role
      return { user: ctx.user };
    },
  });
```

---

## Plugin Context

The `PluginContext` passed to the service function provides:

```ts
interface PluginContext<Deps, Schema, Config> {
  // Core services (always available)
  core: {
    db: Kysely<any>;
    config: Record<string, any>;
    logger: Logger;
    cache: Cache;
    events: Events;
    cron: Cron;
    jobs: Jobs;
    sse: SSE;
    rateLimiter: RateLimiter;
  };

  // Typed database (if using withSchema)
  db: Kysely<Schema>;

  // Dependency services (based on dependencies array)
  deps: Deps;

  // Plugin configuration (if using withConfig)
  config: Config;
}
```

**Example using all context features:**

```ts
export const analyticsPlugin = createPlugin
  .withSchema<AnalyticsSchema>()
  .withConfig<{ trackingId: string }>()
  .define({
    name: "analytics",
    dependencies: ["users"] as const,
    service: async (ctx) => {
      // Schedule daily report
      ctx.core.cron.schedule("0 0 * * *", async () => {
        ctx.core.logger.info("Running daily analytics");
        // ...
      });

      // Listen for events
      ctx.core.events.on("user.created", async (data) => {
        await ctx.db.insertInto("events").values({
          type: "user_created",
          data: JSON.stringify(data),
        }).execute();
      });

      return {
        track(event: string, data: any) {
          ctx.core.events.emit(`analytics.${event}`, {
            trackingId: ctx.config.trackingId,
            ...data,
          });
        },
      };
    },
  });
```

---

## Type Inference

The framework provides helpers to extract types from plugins:

```ts
import {
  InferService,
  InferSchema,
  InferHandlers,
  InferMiddleware,
  InferDependencies,
  InferConfig,
} from "./core";

import { usersPlugin } from "./plugins/users";

// Extract types
type UsersService = InferService<typeof usersPlugin>;
type UsersSchema = InferSchema<typeof usersPlugin>;
type UsersDeps = InferDependencies<typeof usersPlugin>;

// Use in your code
function processUser(service: UsersService) {
  return service.findByEmail("test@example.com");
}
```

---

## Plugin Lifecycle

1. **Registration** - `server.registerPlugin(plugin)` adds plugin to manager
2. **Validation** - At startup, dependencies are validated
3. **Migration** - `await manager.migrate()` runs all plugin migrations in order
4. **Initialization** - `await manager.init()` calls each plugin's `service()` function
5. **Runtime** - Services available via `ctx.plugins` in route handlers

```
Registration → Validation → Migration → Initialization → Runtime
     ↓             ↓            ↓             ↓            ↓
  register()   check deps   run SQL      service()   ctx.plugins
```

---

## Best Practices

### 1. Keep Plugins Focused
Each plugin should have a single responsibility:
- `users` - User management
- `auth` - Authentication
- `email` - Email sending
- `analytics` - Event tracking

### 2. Use Dependencies for Composition
Instead of importing other plugins directly, declare them as dependencies:

```ts
// Good - explicit dependency
dependencies: ["users"] as const,
service: (ctx) => {
  ctx.deps.users.findById(1);
}

// Bad - direct import (bypasses dependency resolution)
import { usersPlugin } from "../users";
```

### 3. Leverage Core Services
Use built-in core services instead of reinventing:

```ts
// Good - use built-in cache
const user = await ctx.core.cache.getOrSet(`user:${id}`, () => fetchUser(id));

// Bad - manual caching
const cached = userCache.get(id);
if (!cached) { ... }
```

### 4. Type Everything
Use `withSchema()` and `withConfig()` for full type safety:

```ts
// Fully typed plugin
createPlugin
  .withSchema<MySchema>()
  .withConfig<MyConfig>()
  .define({ ... });
```
