# Handlers

Request handlers define how routes process HTTP requests. Built-in handlers cover common cases, and you can create custom handlers for specialized needs.

## Quick Start

```ts
import { createHandler } from "./handlers";
import type { ServerContext } from "./router";

// Define handler function signature
type MyFn = (data: MyInput, ctx: ServerContext) => Promise<MyOutput>;

// Create custom handler
export const MyHandler = createHandler<MyFn>(async (req, def, handle, ctx) => {
  const data = await req.json();
  const result = await handle(data, ctx);
  return Response.json(result);
});
```

---

## Built-in Handlers

| Handler | Input | Output | HTTP Methods | Use Case |
|---------|-------|--------|--------------|----------|
| `typed` | Zod-validated JSON | Zod-validated JSON | POST | Standard API endpoints |
| `raw` | Full Request | Full Response | Any | Proxies, WebSockets, custom protocols |
| `stream` | Zod-validated (query/JSON) | Response (binary/stream) | GET, POST | File downloads, video/image serving |
| `sse` | Zod-validated (query/JSON) | SSE connection | GET, POST | Real-time notifications |
| `formData` | Zod-validated fields + files | Zod-validated JSON | POST | File uploads |
| `html` | Zod-validated (query/JSON) | HTML string | GET, POST | htmx, server components |

### TypedHandler (Default)

JSON-RPC style handler with automatic validation:

```ts
router.route("greet").typed({
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  handle: async (input, ctx) => {
    return { message: `Hello, ${input.name}!` };
  },
});
```

**Behavior:**
- Accepts POST requests only (405 for others)
- Parses JSON body
- Validates input with Zod schema (if provided)
- Calls your handler with parsed input
- Validates output with Zod schema (if provided)
- Returns JSON response

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 405 | Non-POST request |
| 400 | Invalid JSON body |
| 400 | Input validation failed |
| 500 | Handler threw error |

### RawHandler

Full control over Request and Response:

```ts
router.route("proxy").raw({
  handle: async (req, ctx) => {
    // Full access to request
    const response = await fetch("https://api.example.com" + new URL(req.url).pathname, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    return response;
  },
});
```

**Use cases:**
- Proxying requests
- WebSocket upgrades
- Custom protocols
- Non-standard HTTP methods

---

### StreamHandler

Validated input with custom Response output. Best for binary data and streaming:

```ts
router.route("files.download").stream({
  input: z.object({
    fileId: z.string(),
    format: z.enum(["mp4", "webm"])
  }),
  handle: async (input, ctx) => {
    const file = await ctx.plugins.storage.getFile(input.fileId);

    return new Response(file.stream, {
      headers: {
        "Content-Type": `video/${input.format}`,
        "Content-Disposition": `attachment; filename="${input.fileId}.${input.format}"`,
      },
    });
  },
});
```

**Behavior:**
- Accepts GET (query params) or POST (JSON body)
- Parses and validates input with Zod
- Returns Response directly (no output validation)

**Use cases:**
- File downloads with parameters
- Video/audio streaming
- Binary data with metadata
- Custom content-types
- Image serving (`<img src="...">`)
- Video embedding (`<video src="...">`)

**Generated Client:**

The generated client provides three methods for stream routes:

```ts
// 1. fetch() - POST request with JSON body (programmatic use)
const response = await api.files.download.fetch({ fileId: "abc", format: "mp4" });
const blob = await response.blob();

// 2. url() - GET URL for browser src attributes
const url = api.files.download.url({ fileId: "abc", format: "mp4" });
// Returns: "/api.files.download?fileId=abc&format=mp4"

// 3. get() - GET request with query params
const response = await api.files.download.get({ fileId: "abc", format: "mp4" });
```

**HTML/Svelte Usage:**

```svelte
<script>
  import { createApi } from '$lib/api';
  const api = createApi();
</script>

<!-- Video element with stream URL -->
<video src={api.videos.stream.url({ id: "video-123" })} controls />

<!-- Image with dynamic src -->
<img src={api.images.thumbnail.url({ id: "img-456", size: "medium" })} />

<!-- Download link -->
<a href={api.files.download.url({ fileId: "doc-789" })} download>
  Download File
</a>
```

---

### SSEHandler

Server-Sent Events with validated input, automatic channel subscription, and **typed events**:

```ts
router.route("notifications.subscribe").sse({
  input: z.object({
    userId: z.string(),
    channels: z.array(z.string()).optional(),
  }),
  // Define event schemas for type-safe generated clients
  events: {
    notification: z.object({ message: z.string(), id: z.string() }),
    announcement: z.object({ title: z.string(), urgent: z.boolean() }),
  },
  handle: (input, ctx) => {
    // Return channel names to subscribe to
    const channels = [`user:${input.userId}`, "global"];
    if (input.channels) {
      channels.push(...input.channels);
    }
    return channels;
  },
});
```

**Behavior:**
- Accepts GET (query params) or POST (JSON body)
- Validates input with Zod schema
- Creates SSE connection via `ctx.core.sse`
- Subscribes client to returned channels
- Supports `Last-Event-ID` header for reconnection
- `events` schema enables typed event handlers in generated client

**Broadcasting Events (Server-side):**
```ts
// In your service or handler
ctx.core.sse.broadcast("user:123", "notification", {
  message: "New message received",
  id: "notif-123"
});

// Broadcast to all connected clients
ctx.core.sse.broadcastAll("announcement", {
  title: "Server maintenance in 5 minutes",
  urgent: true
});
```

**Generated Client (Typed):**
```ts
// Connect to SSE endpoint - returns typed SSEConnection
const connection = api.notifications.subscribe({ userId: "123" });

// Type-safe event handlers - data is fully typed, no JSON.parse needed!
const unsubNotif = connection.on("notification", (data) => {
  // data: { message: string; id: string }
  console.log("Notification:", data.message);
});

const unsubAnnounce = connection.on("announcement", (data) => {
  // data: { title: string; urgent: boolean }
  if (data.urgent) showAlert(data.title);
});

// Unsubscribe from specific handlers
unsubNotif();

// Handle connection events
connection.onError((e) => console.error("SSE connection error"));
connection.onOpen(() => console.log("Connected"));

// Check connection state
connection.connected;   // boolean
connection.readyState;  // 0=CONNECTING, 1=OPEN, 2=CLOSED

// Close entire connection
connection.close();
```

**Svelte 5 Example:**
```svelte
<script lang="ts">
  import { createApi } from '$lib/api';
  import type { SSEConnection } from '@donkeylabs/adapter-sveltekit/client';

  const api = createApi();
  let notifications = $state<{ message: string; id: string }[]>([]);
  let connection: SSEConnection | null = null;

  function connect(userId: string) {
    connection = api.notifications.subscribe({ userId });

    // Typed event handler - no JSON.parse needed!
    connection.on("notification", (data) => {
      notifications = [...notifications, data]; // data is already typed
    });
  }

  function disconnect() {
    connection?.close();
    connection = null;
  }

  // Cleanup on unmount
  $effect(() => {
    return () => connection?.close();
  });
</script>
```

---

### FormDataHandler

File uploads with validated form fields and file constraints:

```ts
router.route("files.upload").formData({
  input: z.object({
    folder: z.string(),
    description: z.string().optional(),
  }),
  output: z.object({
    ids: z.array(z.string()),
    count: z.number(),
  }),
  files: {
    maxSize: 10 * 1024 * 1024,  // 10MB
    accept: ["image/*", "application/pdf"],
  },
  handle: async ({ fields, files }, ctx) => {
    const ids: string[] = [];

    for (const file of files) {
      const id = await ctx.plugins.storage.save(file, fields.folder);
      ids.push(id);
    }

    return { ids, count: files.length };
  },
});
```

**Behavior:**
- Accepts POST requests only
- Requires `multipart/form-data` content type
- Separates form fields from files
- Validates fields with Zod schema
- Validates output with Zod schema (if provided)
- Enforces file constraints before calling handler

**File Constraints:**
```ts
files: {
  maxSize?: number;      // Max file size in bytes
  accept?: string[];     // MIME types (supports wildcards like "image/*")
}
```

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 405 | Non-POST request |
| 400 | Not multipart/form-data |
| 400 | Field validation failed |
| 400 | File exceeds maxSize |
| 400 | File type not in accept list |

**Generated Client:**
```ts
const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
const files = Array.from(fileInput.files || []);

const result = await api.files.upload(
  { folder: "uploads", description: "My photos" },
  files
);
console.log(`Uploaded ${result.count} files:`, result.ids);
```

---

### HTMLHandler

Returns HTML responses. Perfect for htmx, partial renders, and server components:

```ts
router.route("components.userCard").html({
  input: z.object({ userId: z.string() }),
  handle: async (input, ctx) => {
    const user = await ctx.plugins.users.get(input.userId);

    return `
      <div class="card" id="user-${user.id}">
        <img src="${user.avatar}" alt="${user.name}" />
        <h3>${user.name}</h3>
        <p>${user.bio}</p>
      </div>
    `;
  },
});
```

**Behavior:**
- Accepts GET (query params) or POST (JSON/form-urlencoded)
- Validates input with Zod schema
- Returns `text/html` content type
- Can return string (wrapped in Response) or custom Response
- Returns HTML-formatted errors

**Use Cases:**
- htmx partials
- Server-side rendered components
- Email templates
- PDF generation (return Response with different content-type)

**Returning Custom Response:**
```ts
router.route("pages.redirect").html({
  input: z.object({ to: z.string() }),
  handle: (input) => {
    return new Response(null, {
      status: 302,
      headers: { Location: input.to },
    });
  },
});
```

**Generated Client:**
```ts
const html = await api.components.userCard({ userId: "123" });
document.getElementById("container").innerHTML = html;
```

**htmx Example:**
```html
<div hx-get="/api/components.userCard?userId=123"
     hx-trigger="load"
     hx-swap="innerHTML">
  Loading...
</div>
```

---

## API Reference

### HandlerRuntime Interface

All handlers implement this interface:

```ts
interface HandlerRuntime<Fn extends Function = Function> {
  execute(
    req: Request,
    def: RouteDefinition,
    userHandle: Fn,
    ctx: ServerContext
  ): Promise<Response>;

  readonly __signature: Fn;  // Required for type inference
}
```

### createHandler Factory

Create custom handlers without manual phantom types:

```ts
function createHandler<Fn extends Function>(
  execute: (
    req: Request,
    def: RouteDefinition,
    handle: Fn,
    ctx: ServerContext
  ) => Promise<Response>
): HandlerRuntime<Fn>;
```

---

## Creating Custom Handlers

### Step 1: Define Function Signature

```ts
// The signature your handler users will implement
type EchoFn = (body: any, ctx: ServerContext) => Promise<{ echo: any }>;
```

### Step 2: Create Handler

```ts
import { createHandler } from "./handlers";

export const EchoHandler = createHandler<EchoFn>(async (req, def, handle, ctx) => {
  // 1. Process the request
  const body = await req.json();

  // 2. Call the user's handler
  const result = await handle(body, ctx);

  // 3. Return the response
  return Response.json(result);
});
```

### Step 3: Register in Plugin

```ts
import { createPlugin } from "./core";
import { EchoHandler } from "./handlers/echo";

export const echoPlugin = createPlugin.define({
  name: "echo",
  handlers: {
    echo: EchoHandler,  // Key becomes method name
  },
  service: async () => ({}),
});
```

### Step 4: Regenerate Registry

```sh
bun run gen:registry
```

### Step 5: Use in Routes

```ts
// Now available as .echo() method
router.route("test").echo({
  handle: async (body, ctx) => {
    return { echo: body };
  },
});
```

---

## Custom Handler Examples

### XML Handler

Accept and return XML:

```ts
import { createHandler } from "./handlers";
import { parseXML, buildXML } from "./utils/xml";

type XMLFn = (data: object, ctx: ServerContext) => Promise<object>;

export const XMLHandler = createHandler<XMLFn>(async (req, def, handle, ctx) => {
  // Parse XML body
  const xmlText = await req.text();
  const data = parseXML(xmlText);

  // Call user handler
  const result = await handle(data, ctx);

  // Return XML response
  return new Response(buildXML(result), {
    headers: { "Content-Type": "application/xml" },
  });
});
```

### Form Handler

Process form submissions:

```ts
type FormFn = (fields: Record<string, string>, ctx: ServerContext) => Promise<any>;

export const FormHandler = createHandler<FormFn>(async (req, def, handle, ctx) => {
  const formData = await req.formData();
  const fields: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
    }
  }

  const result = await handle(fields, ctx);
  return Response.json(result);
});
```

### GraphQL-Style Handler

Single endpoint with operation selection:

```ts
type GraphQLFn = (
  query: string,
  variables: Record<string, any>,
  ctx: ServerContext
) => Promise<{ data?: any; errors?: any[] }>;

export const GraphQLHandler = createHandler<GraphQLFn>(async (req, def, handle, ctx) => {
  const body = await req.json();
  const { query, variables = {} } = body;

  if (!query) {
    return Response.json({ errors: [{ message: "Query required" }] }, { status: 400 });
  }

  const result = await handle(query, variables, ctx);
  return Response.json(result);
});
```

### Streaming Handler

Support streaming responses:

```ts
type StreamFn = (
  input: any,
  ctx: ServerContext
) => AsyncGenerator<string, void, unknown>;

export const StreamHandler = createHandler<StreamFn>(async (req, def, handle, ctx) => {
  const input = await req.json();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      for await (const chunk of handle(input, ctx)) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});
```

Usage:

```ts
router.route("stream").stream({
  handle: async function* (input, ctx) {
    for (let i = 0; i < 10; i++) {
      yield `Chunk ${i}\n`;
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});
```

### Batch Handler

Process multiple operations in one request:

```ts
type BatchFn = (
  operations: { id: string; method: string; params: any }[],
  ctx: ServerContext
) => Promise<{ id: string; result?: any; error?: string }[]>;

export const BatchHandler = createHandler<BatchFn>(async (req, def, handle, ctx) => {
  const body = await req.json();

  if (!Array.isArray(body)) {
    return Response.json({ error: "Expected array" }, { status: 400 });
  }

  const results = await handle(body, ctx);
  return Response.json(results);
});
```

---

## Handler Configuration

Custom handlers can access route configuration:

```ts
// Route definition includes custom config
router.route("cached").typed({
  input: z.object({ id: z.string() }),
  cache: { ttl: 60000 },  // Custom config
  handle: async (input, ctx) => { ... },
});
```

Access in handler:

```ts
export const CachedHandler = createHandler<CachedFn>(async (req, def, handle, ctx) => {
  const cacheConfig = (def as any).cache;

  if (cacheConfig) {
    const cached = await ctx.core.cache.get(cacheKey);
    if (cached) return Response.json(cached);
  }

  const result = await handle(input, ctx);

  if (cacheConfig) {
    await ctx.core.cache.set(cacheKey, result, cacheConfig.ttl);
  }

  return Response.json(result);
});
```

---

## Error Handling

### In Custom Handlers

```ts
export const SafeHandler = createHandler<SafeFn>(async (req, def, handle, ctx) => {
  try {
    const body = await req.json();
    const result = await handle(body, ctx);
    return Response.json(result);
  } catch (error: any) {
    ctx.core.logger.error("Handler error", { error: error.message });

    if (error.name === "ValidationError") {
      return Response.json({ error: error.message }, { status: 400 });
    }

    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
});
```

### Zod Validation Errors

TypedHandler returns structured validation errors:

```json
{
  "error": "Validation Failed",
  "details": [
    {
      "path": ["email"],
      "message": "Invalid email",
      "code": "invalid_string"
    },
    {
      "path": ["age"],
      "message": "Expected number, received string",
      "code": "invalid_type"
    }
  ]
}
```

---

## Handler Resolution

The server resolves handlers at runtime:

1. Route specifies handler name (e.g., `"typed"`, `"raw"`, `"echo"`)
2. Server looks up handler in merged registry (built-in + plugin handlers)
3. Handler's `execute()` method is called with request, definition, user handle, and context

```ts
// In server.ts (simplified)
const handler = handlers[route.handler];
const response = await handler.execute(req, route, route.handle, ctx);
```

---

## TypeScript Integration

### Handler Type Inference

The `__signature` phantom type enables autocomplete:

```ts
// When you type: router.route("test").echo({
//   handle: ...  <-- TypeScript knows this should be EchoFn
// });

interface HandlerRuntime<Fn extends Function> {
  readonly __signature: Fn;  // This enables inference
}
```

### Generating Registry

After adding handlers to a plugin, regenerate types:

```sh
bun run gen:registry
```

This generates `registry.d.ts` which augments `IRouteBuilder`:

```ts
declare module "./router" {
  interface IRouteBuilder<TRouter> {
    echo(config: { handle: EchoFn }): TRouter;
    // ... other handlers
  }
}
```

---

## Best Practices

### 1. Keep Handlers Focused

```ts
// Good - single responsibility
export const JSONHandler = createHandler<JSONFn>(async (req, def, handle, ctx) => {
  const body = await req.json();
  const result = await handle(body, ctx);
  return Response.json(result);
});

// Bad - too many concerns
export const EverythingHandler = createHandler<Fn>(async (req, def, handle, ctx) => {
  // Auth check
  // Rate limiting
  // Caching
  // Logging
  // Validation
  // Error handling
  // ...
});
```

Use middleware for cross-cutting concerns.

### 2. Validate Input Early

```ts
export const SafeHandler = createHandler<SafeFn>(async (req, def, handle, ctx) => {
  // Validate before calling user handler
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await handle(body, ctx);
  return Response.json(result);
});
```

### 3. Use Proper Error Responses

```ts
// Good - proper HTTP status codes
return Response.json({ error: "Not found" }, { status: 404 });
return Response.json({ error: "Validation failed" }, { status: 400 });
return Response.json({ error: "Unauthorized" }, { status: 401 });

// Bad - always 200 with error in body
return Response.json({ success: false, error: "Not found" });
```

### 4. Document Handler Contracts

```ts
/**
 * FormHandler - Processes multipart form submissions
 *
 * Request: multipart/form-data with fields
 * Response: JSON
 *
 * Handler signature:
 *   (fields: Record<string, string>, files: File[], ctx) => Promise<any>
 */
export const FormHandler = createHandler<FormFn>(...);
```

### 5. Test Handlers Independently

```ts
import { EchoHandler } from "./handlers/echo";

test("EchoHandler echoes body", async () => {
  const req = new Request("http://test", {
    method: "POST",
    body: JSON.stringify({ hello: "world" }),
  });

  const mockHandle = async (body: any) => ({ echo: body });
  const ctx = createMockContext();

  const response = await EchoHandler.execute(req, {}, mockHandle, ctx);
  const json = await response.json();

  expect(json).toEqual({ echo: { hello: "world" } });
});
```
