# Router & Routes

Fluent API for defining type-safe routes with handler selection and middleware chaining.

## Quick Start

```ts
import { createRouter } from "./router";
import { z } from "zod";

const router = createRouter("api")
  .route("hello").typed({
    input: z.object({ name: z.string() }),
    handle: async (input, ctx) => {
      return { message: `Hello, ${input.name}!` };
    }
  });
```

---

## API Reference

### createRouter

Create a new router with optional prefix:

```ts
const router = createRouter("api");      // Routes prefixed with "api."
const router = createRouter();            // No prefix
```

### Router Methods

| Method | Description |
|--------|-------------|
| `route(name)` | Start defining a route, returns RouteBuilder |
| `middleware` | Start middleware chain, returns MiddlewareBuilder |
| `getRoutes()` | Get all registered route definitions |

### RouteBuilder Methods

After calling `router.route("name")`, you get a RouteBuilder with handler methods:

| Method | Description |
|--------|-------------|
| `.typed(config)` | JSON-RPC style handler with Zod validation |
| `.raw(config)` | Full Request/Response control |
| `.stream(config)` | Validated input, Response output (binary/streaming) |
| `.sse(config)` | Server-Sent Events with channel subscription |
| `.formData(config)` | File uploads with validated fields |
| `.html(config)` | HTML responses for htmx/components |
| `.<custom>(config)` | Custom handlers from plugins |

### MiddlewareBuilder Methods

After calling `router.middleware`, chain middleware then define routes:

```ts
router.middleware
  .auth({ required: true })
  .rateLimit({ limit: 100, window: "1m" })
  .route("protected").typed({ ... });
```

---

## Route Naming

Routes are named as `prefix.name`:

```ts
const router = createRouter("users");

router.route("list");    // Route name: "users.list"
router.route("get");     // Route name: "users.get"
router.route("create");  // Route name: "users.create"
```

**HTTP Requests:**
```sh
POST /users.list    # Calls users.list handler
POST /users.get     # Calls users.get handler
```

---

## Handler Types

### Typed Handler (Default)

JSON-RPC style with automatic validation:

```ts
router.route("greet").typed({
  // Optional: Zod schema for input validation
  input: z.object({
    name: z.string(),
    age: z.number().optional(),
  }),

  // Optional: Zod schema for output validation
  output: z.object({
    message: z.string(),
  }),

  // Required: Handler function
  handle: async (input, ctx) => {
    return { message: `Hello, ${input.name}!` };
  },
});
```

**Behavior:**
- POST only (returns 405 for other methods)
- Parses JSON body automatically
- Validates input against schema (returns 400 on failure)
- Validates output against schema
- Returns JSON response

### Raw Handler

Full control over Request/Response:

```ts
router.route("proxy").raw({
  handle: async (req, ctx) => {
    return fetch("https://api.example.com", {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
  },
});
```

**Use cases:**
- Proxying requests
- WebSocket upgrades
- Custom protocols

### Stream Handler

Validated input with binary/streaming Response:

```ts
router.route("files.download").stream({
  input: z.object({ fileId: z.string() }),
  handle: async (input, ctx) => {
    const file = await ctx.plugins.storage.get(input.fileId);
    return new Response(file.stream, {
      headers: { "Content-Type": file.mimeType },
    });
  },
});
```

**Use cases:**
- File downloads with parameters
- Video/audio streaming
- Binary data with metadata

### SSE Handler

Server-Sent Events with automatic channel subscription and typed events:

```ts
router.route("events.subscribe").sse({
  input: z.object({ userId: z.string() }),
  // Optional: Define event schemas for type-safe generated clients
  events: {
    notification: z.object({ message: z.string(), id: z.string() }),
    announcement: z.object({ title: z.string(), urgent: z.boolean() }),
  },
  handle: (input, ctx) => {
    // Return channels to subscribe to
    return [`user:${input.userId}`, "global"];
  },
});
```

**Server-side broadcasting:**
```ts
ctx.core.sse.broadcast("user:123", "notification", { message: "Hello!", id: "1" });
```

**Generated client usage:**
```ts
const connection = api.events.subscribe({ userId: "123" });

// Typed event handlers - no JSON.parse needed
connection.on("notification", (data) => {
  // data: { message: string; id: string }
  console.log(data.message);
});

// Returns unsubscribe function
const unsub = connection.on("announcement", (data) => {
  if (data.urgent) showAlert(data.title);
});
unsub(); // Unsubscribe from this handler

connection.close(); // Close the entire connection
```

**Use cases:**
- Real-time notifications
- Live updates
- Event streaming

### FormData Handler

File uploads with validated fields:

```ts
router.route("files.upload").formData({
  input: z.object({ folder: z.string() }),
  output: z.object({ ids: z.array(z.string()) }),
  files: { maxSize: 10 * 1024 * 1024, accept: ["image/*"] },
  handle: async ({ fields, files }, ctx) => {
    const ids = await Promise.all(
      files.map(f => ctx.plugins.storage.save(f, fields.folder))
    );
    return { ids };
  },
});
```

**Use cases:**
- File uploads
- Form submissions with attachments
- Multi-file uploads

### HTML Handler

HTML responses for htmx and server components:

```ts
router.route("components.card").html({
  input: z.object({ userId: z.string() }),
  handle: async (input, ctx) => {
    const user = await ctx.plugins.users.get(input.userId);
    return `<div class="card">${user.name}</div>`;
  },
});
```

**Use cases:**
- htmx partials
- Server-rendered components
- Email templates

### Custom Handlers

Plugins can register custom handlers:

```ts
// Plugin registers "echo" handler
router.route("test").echo({
  handle: async (body, ctx) => {
    return { echo: body };
  },
});
```

See [Handlers Documentation](handlers.md) for creating custom handlers.

---

## Server Context

Every handler receives `ServerContext`:

```ts
router.route("example").typed({
  handle: async (input, ctx) => {
    // Database (Kysely)
    const users = await ctx.db.selectFrom("users").selectAll().execute();

    // Plugin services
    const data = await ctx.plugins.myPlugin.getData();

    // Core services
    ctx.core.logger.info("Processing request", { input });
    const cached = await ctx.core.cache.get("key");

    // Request info
    console.log(ctx.ip);         // Client IP
    console.log(ctx.requestId);  // Unique request ID
    console.log(ctx.user);       // Set by auth middleware

    return { users };
  },
});
```

---

## Middleware

Apply middleware before routes:

### Single Middleware

```ts
router.middleware
  .auth({ required: true })
  .route("protected").typed({
    handle: async (input, ctx) => {
      // ctx.user is guaranteed by auth middleware
      return { userId: ctx.user.id };
    },
  });
```

### Chained Middleware

```ts
router.middleware
  .cors({ origin: "*" })
  .auth({ required: true })
  .rateLimit({ limit: 100, window: "1m" })
  .route("api").typed({
    handle: async (input, ctx) => {
      // All middleware applied
    },
  });
```

### Middleware for Multiple Routes

```ts
const protectedRoutes = router.middleware
  .auth({ required: true })
  .rateLimit({ limit: 1000, window: "1h" });

protectedRoutes.route("profile").typed({ ... });
protectedRoutes.route("settings").typed({ ... });
protectedRoutes.route("orders").typed({ ... });
```

---

## Input Validation

Use Zod schemas for automatic validation:

```ts
import { z } from "zod";

const CreateUserInput = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  age: z.number().int().positive().optional(),
  role: z.enum(["user", "admin"]).default("user"),
});

router.route("createUser").typed({
  input: CreateUserInput,
  handle: async (input, ctx) => {
    // input is typed and validated
    // input.email: string
    // input.name: string
    // input.age: number | undefined
    // input.role: "user" | "admin"

    const user = await ctx.db.insertInto("users")
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow();

    return user;
  },
});
```

**Validation Errors:**

```json
{
  "error": "Validation Failed",
  "details": [
    {
      "path": ["email"],
      "message": "Invalid email"
    }
  ]
}
```

---

## Output Validation

Validate and type your responses:

```ts
const UserResponse = z.object({
  id: z.number(),
  email: z.string(),
  createdAt: z.string(),
});

router.route("getUser").typed({
  input: z.object({ id: z.number() }),
  output: UserResponse,
  handle: async (input, ctx) => {
    const user = await ctx.db.selectFrom("users")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirstOrThrow();

    // Return type is validated against UserResponse
    return user;
  },
});
```

---

## Type Generation

When using `donkeylabs generate` to create a typed API client, **you must provide explicit `output` schemas if your route returns data**.

### Output Schema Rules

- **No `output` schema** → Generated type is `void` (handler should return nothing)
- **With `output` schema** → Generated type matches the schema

This enforces explicitness: if you want to return data, you must declare what you're returning.

**Without `output` schema (returns void):**
```ts
// Handler should NOT return anything
router.route("delete").typed({
  input: z.object({ id: z.string() }),
  handle: async (input, ctx) => {
    await ctx.plugins.recordings.delete(input.id);
    // No return - this is correct for void output
  },
});
```

**With `output` schema (returns data):**
```ts
// ✅ Generated type will be: Output = Expand<{ recordings: Recording[]; total: number; }>
router.route("list").typed({
  input: z.object({ page: z.number() }),
  output: z.object({
    recordings: z.array(RecordingSchema),
    total: z.number(),
  }),
  handle: async (input, ctx) => {
    return ctx.plugins.recordings.list(input);
  },
});
```

### Best Practice: Always Define Output Schemas

For proper type safety in generated clients:

1. **Define Zod schemas for outputs**:
```ts
// schemas.ts
export const RecordingSchema = z.object({
  id: z.string(),
  name: z.string(),
  duration: z.number(),
  createdAt: z.string(),
});

export const RecordingListOutput = z.object({
  recordings: z.array(RecordingSchema),
  total: z.number(),
  page: z.number(),
});
```

2. **Use them in routes**:
```ts
import { RecordingListOutput } from "./schemas";

router.route("list").typed({
  input: z.object({ page: z.number().default(1) }),
  output: RecordingListOutput,
  handle: async (input, ctx) => {
    return ctx.plugins.recordings.list(input);
  },
});
```

3. **Run type generation**:
```bash
donkeylabs generate
```

The generated client will have properly typed methods:
```ts
// Generated API client
api.recordings.list({ page: 1 })  // Returns Promise<{ recordings: Recording[]; total: number; page: number; }>
```

### Debugging Missing Types

If your generated client shows `Output = Expand<void>` but your handler returns data:

1. Add an explicit `output` Zod schema that matches your return type
2. Run `donkeylabs generate` to regenerate the client
3. Check the warning logs - routes without output schemas are listed

---

## Real-World Examples

### CRUD Operations

```ts
const router = createRouter("users");

// List users
router.route("list").typed({
  input: z.object({
    page: z.number().default(1),
    limit: z.number().default(20),
  }),
  handle: async (input, ctx) => {
    const offset = (input.page - 1) * input.limit;

    const users = await ctx.db.selectFrom("users")
      .selectAll()
      .limit(input.limit)
      .offset(offset)
      .execute();

    return { users, page: input.page };
  },
});

// Get single user
router.route("get").typed({
  input: z.object({ id: z.number() }),
  handle: async (input, ctx) => {
    const user = await ctx.db.selectFrom("users")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirstOrThrow();

    return user;
  },
});

// Create user
router.middleware
  .auth({ required: true, role: "admin" })
  .route("create").typed({
    input: z.object({
      email: z.string().email(),
      name: z.string(),
    }),
    handle: async (input, ctx) => {
      const user = await ctx.db.insertInto("users")
        .values(input)
        .returningAll()
        .executeTakeFirstOrThrow();

      await ctx.core.events.emit("user.created", user);

      return user;
    },
  });

// Update user
router.middleware
  .auth({ required: true })
  .route("update").typed({
    input: z.object({
      id: z.number(),
      name: z.string().optional(),
      email: z.string().email().optional(),
    }),
    handle: async (input, ctx) => {
      const { id, ...updates } = input;

      const user = await ctx.db.updateTable("users")
        .set(updates)
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();

      return user;
    },
  });

// Delete user
router.middleware
  .auth({ required: true, role: "admin" })
  .route("delete").typed({
    input: z.object({ id: z.number() }),
    handle: async (input, ctx) => {
      await ctx.db.deleteFrom("users")
        .where("id", "=", input.id)
        .execute();

      return { success: true };
    },
  });
```

### File Upload (Raw Handler)

```ts
router.route("upload").raw({
  handle: async (req, ctx) => {
    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    const path = `uploads/${Date.now()}-${file.name}`;

    await Bun.write(path, buffer);

    return Response.json({
      path,
      size: file.size,
      type: file.type,
    });
  },
});
```

### SSE Endpoint (Raw Handler)

```ts
router.route("events").raw({
  handle: async (req, ctx) => {
    const { client, response } = ctx.core.sse.addClient();
    ctx.core.sse.subscribe(client.id, `user:${ctx.user.id}`);
    return response;
  },
});
```

### Streaming Response

```ts
router.route("stream").raw({
  handle: async (req, ctx) => {
    const stream = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < 10; i++) {
          controller.enqueue(`data: ${i}\n\n`);
          await new Promise((r) => setTimeout(r, 100));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
});
```

---

## Route Registration

Register routes with the server:

```ts
import { AppServer } from "./server";
import { userRouter } from "./routes/users";
import { orderRouter } from "./routes/orders";

const server = new AppServer({ db, port: 3000 });

// Register single router
server.use(userRouter);

// Register multiple routers
server.use(userRouter);
server.use(orderRouter);

await server.start();
```

---

## Best Practices

### 1. Organize by Domain

```
routes/
├── users.ts      # createRouter("users")
├── orders.ts     # createRouter("orders")
├── products.ts   # createRouter("products")
└── index.ts      # Export all routers
```

### 2. Use Descriptive Route Names

```ts
// Good - clear action
router.route("list");
router.route("get");
router.route("create");
router.route("update");
router.route("delete");

// Bad - ambiguous
router.route("data");
router.route("do");
router.route("handle");
```

### 3. Validate All Input

```ts
// Good - always validate
router.route("create").typed({
  input: z.object({ email: z.string().email() }),
  handle: async (input, ctx) => { ... },
});

// Bad - trusting client input
router.route("create").typed({
  handle: async (input, ctx) => {
    // input is untyped `any`
  },
});
```

### 4. Use Middleware for Cross-Cutting Concerns

```ts
// Good - middleware for auth
router.middleware
  .auth({ required: true })
  .route("protected").typed({ ... });

// Bad - auth check in every handler
router.route("protected").typed({
  handle: async (input, ctx) => {
    if (!ctx.user) throw new Error("Unauthorized");
    // ...
  },
});
```

### 5. Keep Handlers Focused

```ts
// Good - focused handler, delegates to service
router.route("create").typed({
  handle: async (input, ctx) => {
    return ctx.plugins.users.create(input);
  },
});

// Bad - business logic in handler
router.route("create").typed({
  handle: async (input, ctx) => {
    // 100 lines of business logic...
  },
});
```
