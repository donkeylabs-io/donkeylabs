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
router.route("upload").raw({
  handle: async (req, ctx) => {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;

    // Process file...

    return Response.json({ success: true });
  },
});
```

**Use cases:**
- File uploads/downloads
- Streaming responses
- Server-Sent Events
- Custom content types
- WebSocket upgrades
- Non-JSON APIs

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
