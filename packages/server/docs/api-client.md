# API Client

Code-generated, fully-typed API client for consuming routes with TypeScript. Supports typed requests, SSE events, and automatic authentication handling.

## Quick Start

```ts
// Generate client from your server routes
// bun run gen:client server.ts

// Import and use
import { createApiClient } from "./client";

const api = createApiClient({ baseUrl: "http://localhost:3000" });

// Typed route calls
const user = await api.users.get({ id: 1 });
console.log(user.name); // Fully typed!

// SSE events with typed handlers
api.connect();
api.on("notifications.new", (data) => {
  console.log(data.message); // Typed!
});
```

---

## Generation

### CLI Command

```sh
# Generate from specific server files
bun scripts/generate-client.ts server.ts

# Generate from multiple files
bun scripts/generate-client.ts server.ts api.ts

# Custom output location
bun scripts/generate-client.ts --output ./src/api server.ts

# Using npm script
bun run gen:client server.ts
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--output <path>` | `./client` | Output directory for generated files |
| `--name <name>` | `index.ts` | Generated client filename |
| `--help` | - | Show usage information |

### Generated Files

```
client/
├── base.ts      # Runtime (ApiClientBase, errors, types)
└── index.ts     # Generated client with typed routes/events
```

---

## Client Configuration

```ts
interface ApiClientConfig {
  /** Base URL of the API server */
  baseUrl: string;

  /** Default headers for all requests */
  headers?: Record<string, string>;

  /** Credentials mode (default: "include" for cookies) */
  credentials?: "include" | "same-origin" | "omit";

  /** Custom fetch implementation (for Node.js or testing) */
  fetch?: typeof fetch;
}

const api = createApiClient({
  baseUrl: "http://localhost:3000",
  headers: {
    "X-Client-Version": "1.0.0",
  },
  credentials: "include",
});
```

---

## Route Calls

### Typed Routes

Generated from `.route().typed()` definitions:

```ts
// Server-side definition
router.route("users.get").typed({
  input: z.object({ id: z.number() }),
  output: z.object({ id: z.number(), name: z.string(), email: z.string() }),
  handle: async (input, ctx) => { ... },
});

// Generated client method
const user = await api.users.get({ id: 1 });
// user: { id: number; name: string; email: string }
```

### Route Namespaces

Routes are grouped by prefix:

```ts
// Server: createRouter("users")
api.users.get({ id: 1 });
api.users.create({ name: "Alice" });
api.users.update({ id: 1, name: "Bob" });

// Server: createRouter("orders")
api.orders.list({ page: 1 });
api.orders.create({ items: [...] });
```

### Request Options

```ts
// Abort signal
const controller = new AbortController();
const user = await api.users.get({ id: 1 }, {
  signal: controller.signal,
});

// Custom headers per request
const order = await api.orders.create({ items: [...] }, {
  headers: { "X-Idempotency-Key": "unique-key" },
});
```

### Raw Routes

For full Request/Response control:

```ts
// Server-side
router.route("proxy").raw({
  handle: async (req, ctx) => fetch("https://api.example.com"),
});

// Client-side (returns raw Response)
const response = await api.proxy();
const data = await response.json();
```

### Stream Routes

Validated input with binary/streaming Response:

```ts
// Server-side
router.route("files.download").stream({
  input: z.object({ fileId: z.string(), quality: z.enum(["low", "high"]) }),
  handle: async (input, ctx) => {
    const file = await ctx.plugins.storage.get(input.fileId);
    return new Response(file.stream, {
      headers: { "Content-Type": file.mimeType },
    });
  },
});

// Client-side (typed input, returns Response)
const response = await api.files.download({ fileId: "abc", quality: "high" });
const blob = await response.blob();

// For video/audio streaming
const videoUrl = URL.createObjectURL(await response.blob());
```

### SSE Routes

Server-Sent Events with automatic channel subscription and **typed event handlers**:

```ts
// Server-side - define events schema for type-safe client
router.route("notifications.subscribe").sse({
  input: z.object({ userId: z.string() }),
  events: {
    notification: z.object({ message: z.string(), id: z.string() }),
    announcement: z.object({ title: z.string(), urgent: z.boolean() }),
  },
  handle: (input, ctx) => [`user:${input.userId}`, "global"],
});

// Client-side (returns typed SSEConnection)
const connection = api.notifications.subscribe({ userId: "123" });

// Type-safe event handlers - data is fully typed!
const unsubNotif = connection.on("notification", (data) => {
  // data: { message: string; id: string }
  console.log("New notification:", data.message);
});

const unsubAnnounce = connection.on("announcement", (data) => {
  // data: { title: string; urgent: boolean }
  if (data.urgent) showAlert(data.title);
});

// Unsubscribe from specific handlers
unsubNotif();

// Handle connection events
connection.onError((e) => console.error("Connection lost"));
connection.onOpen(() => console.log("Connected"));

// Check connection state
console.log(connection.connected); // boolean
console.log(connection.readyState); // EventSource.OPEN, CONNECTING, CLOSED

// Close entire connection
connection.close();
```

**Svelte 5 example:**
```svelte
<script lang="ts">
  import { createApi } from '$lib/api';
  import type { SSEConnection } from '@donkeylabs/adapter-sveltekit/client';

  const api = createApi();
  let messages = $state<{ message: string; id: string }[]>([]);
  let connection: SSEConnection | null = null;

  function connect() {
    connection = api.notifications.subscribe({ userId: "123" });

    // Typed event handler - no JSON.parse needed!
    connection.on("notification", (data) => {
      messages = [...messages, data]; // data is already typed
    });
  }

  // Cleanup on unmount
  $effect(() => () => connection?.close());
</script>

<button onclick={connect}>Connect</button>
{#each messages as msg}<p>{msg.message}</p>{/each}
```

### FormData Routes

File uploads with validated fields:

```ts
// Server-side
router.route("files.upload").formData({
  input: z.object({ folder: z.string(), tags: z.array(z.string()).optional() }),
  output: z.object({ ids: z.array(z.string()), count: z.number() }),
  files: { maxSize: 10 * 1024 * 1024, accept: ["image/*", "application/pdf"] },
  handle: async ({ fields, files }, ctx) => {
    const ids = await Promise.all(files.map(f => saveFile(f, fields.folder)));
    return { ids, count: files.length };
  },
});

// Client-side (fields + files array)
const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
const files = Array.from(fileInput.files || []);

const result = await api.files.upload(
  { folder: "photos", tags: ["vacation", "2024"] },
  files
);
console.log(`Uploaded ${result.count} files:`, result.ids);
```

**Svelte 5 example:**
```svelte
<script lang="ts">
  import { createApi } from '$lib/api';

  const api = createApi();
  let uploading = $state(false);
  let result = $state<{ ids: string[]; count: number } | null>(null);

  async function handleUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length) return;

    uploading = true;
    try {
      result = await api.files.upload({ folder: "uploads" }, files);
    } finally {
      uploading = false;
    }
  }
</script>

<input type="file" multiple onchange={handleUpload} disabled={uploading} />
{#if result}<p>Uploaded {result.count} files</p>{/if}
```

### HTML Routes

HTML responses for htmx and server components:

```ts
// Server-side
router.route("components.userCard").html({
  input: z.object({ userId: z.string() }),
  handle: async (input, ctx) => {
    const user = await ctx.plugins.users.get(input.userId);
    return `<div class="card">${user.name}</div>`;
  },
});

// Client-side (returns HTML string)
const html = await api.components.userCard({ userId: "123" });
document.getElementById("container")!.innerHTML = html;
```

**htmx usage (no client needed):**
```html
<!-- htmx calls the route directly -->
<div hx-get="/api/components.userCard?userId=123"
     hx-trigger="load"
     hx-swap="innerHTML">
  Loading...
</div>

<!-- With click trigger -->
<button hx-get="/api/components.userCard?userId=456"
        hx-target="#card-container">
  Load User
</button>
```

---

## Error Handling

```ts
import { ApiError, ValidationError } from "./client";

try {
  const user = await api.users.create({ email: "invalid" });
} catch (error) {
  if (error instanceof ValidationError) {
    // Zod validation failed (400)
    console.log("Validation errors:", error.details);
    // [{ path: ["email"], message: "Invalid email" }]
  } else if (error instanceof ApiError) {
    // HTTP error
    console.log("Status:", error.status);
    console.log("Body:", error.body);
  }
}
```

### Error Types

| Error | Status | Description |
|-------|--------|-------------|
| `ValidationError` | 400 | Zod schema validation failed |
| `ApiError` | Any | Generic HTTP error with status/body |

---

## SSE Events

### Connection

```ts
// Connect to SSE endpoint
api.connect();
// Or with options
api.connect({
  endpoint: "/events",     // Default: "/sse"
  channels: ["orders"],    // Subscribe to specific channels
  autoReconnect: true,     // Auto-reconnect on disconnect (default)
  reconnectDelay: 3000,    // Reconnect delay in ms (default: 3000)
  onConnect: () => console.log("Connected"),
  onDisconnect: () => console.log("Disconnected"),
  onError: (e) => console.error("SSE error", e),
});

// Check connection status
console.log(api.connected); // boolean

// Disconnect
api.disconnect();
```

### Typed Event Handlers

Events are typed from plugin `events` definitions:

```ts
// Plugin definition
export const notificationsPlugin = createPlugin.define({
  name: "notifications",
  events: {
    new: z.object({
      id: z.number(),
      message: z.string(),
      type: z.enum(["info", "warning", "error"]),
    }),
    unreadCount: z.object({ count: z.number() }),
  },
  // ...
});

// Client-side (generated types)
api.on("notifications.new", (data) => {
  // data: { id: number; message: string; type: "info" | "warning" | "error" }
  showToast(data.message, data.type);
});

api.on("notifications.unreadCount", (data) => {
  // data: { count: number }
  updateBadge(data.count);
});
```

### Event Subscription

```ts
// Subscribe to event (returns unsubscribe function)
const unsubscribe = api.on("orders.statusChanged", (data) => {
  console.log("Order status:", data.status);
});

// Later: unsubscribe
unsubscribe();

// One-time subscription
api.once("orders.statusChanged", (data) => {
  console.log("First status change:", data.status);
});

// Remove all handlers for event
api.off("orders.statusChanged");
```

---

## Authentication

### HTTP-Only Cookies (Recommended)

The client uses `credentials: "include"` by default, which automatically sends and receives HTTP-only cookies:

```ts
// Login sets HTTP-only cookie automatically
await api.auth.login({ username: "alice", password: "secret" });

// Subsequent requests include cookie automatically
const user = await api.users.me(); // Authenticated!

// Logout clears cookie
await api.auth.logout();
```

### Custom Auth Headers

```ts
const api = createApiClient({
  baseUrl: "http://localhost:3000",
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

// Or update per-request
await api.users.get({ id: 1 }, {
  headers: { Authorization: `Bearer ${newToken}` },
});
```

---

## Plugin Client Configuration

Plugins can configure client behavior:

```ts
// plugins/auth/index.ts
export const authPlugin = createPlugin.define({
  name: "auth",
  client: {
    credentials: "include", // Ensures cookies are sent
  },
  // ...
});
```

The generator merges all plugin client configs to determine defaults.

---

## Browser & Node.js

### Browser

Works out of the box with native `fetch` and `EventSource`:

```ts
import { createApiClient } from "./client";
const api = createApiClient({ baseUrl: "http://localhost:3000" });
```

### Node.js / Bun

Native fetch is available in Bun and Node.js 18+:

```ts
import { createApiClient } from "./client";

const api = createApiClient({
  baseUrl: "http://localhost:3000",
});
```

For SSE in Node.js, use `eventsource` polyfill:

```ts
import EventSource from "eventsource";
globalThis.EventSource = EventSource;

// Then use normally
api.connect();
```

---

## Complete Example

```ts
import { createApiClient, ApiError, ValidationError } from "./client";

// Create client
const api = createApiClient({ baseUrl: "http://localhost:3000" });

async function main() {
  try {
    // Login
    await api.auth.login({ username: "alice", password: "secret" });

    // Connect to SSE
    api.connect({
      onConnect: () => console.log("SSE connected"),
    });

    // Listen for events
    api.on("notifications.new", (data) => {
      console.log(`New notification: ${data.message}`);
    });

    // Make typed API calls
    const user = await api.users.get({ id: 1 });
    console.log(`Hello, ${user.name}!`);

    // Create order
    const order = await api.orders.create({
      items: [
        { productId: 1, quantity: 2 },
        { productId: 3, quantity: 1 },
      ],
    });
    console.log(`Order created: ${order.id}`);

  } catch (error) {
    if (error instanceof ValidationError) {
      console.error("Validation failed:", error.details);
    } else if (error instanceof ApiError) {
      console.error(`API error ${error.status}:`, error.body);
    } else {
      throw error;
    }
  }
}

// Cleanup on exit
process.on("SIGINT", () => {
  api.disconnect();
  process.exit();
});

main();
```

---

## Type Generation

### How It Works

The generator scans your code for:

1. **Routes**: Extracts `createRouter()` calls and `.route().typed()` definitions
2. **Events**: Scans `plugins/*/index.ts` for `events: { ... }` definitions
3. **Client Config**: Reads `client: { ... }` from plugins

Zod schemas are converted to TypeScript types:

| Zod Schema | Generated Type |
|------------|----------------|
| `z.string()` | `string` |
| `z.number()` | `number` |
| `z.boolean()` | `boolean` |
| `z.object({ a: z.string() })` | `{ a: string }` |
| `z.array(z.number())` | `number[]` |
| `z.enum(["a", "b"])` | `"a" \| "b"` |
| `z.optional()` | `T \| undefined` |
| `z.nullable()` | `T \| null` |

### Regenerating

Run the generator when you:

- Add new routes
- Modify route input/output schemas
- Add plugin events
- Change plugin client config

```sh
bun run gen:client server.ts
```

---

## Best Practices

### 1. Regenerate After Schema Changes

```sh
# After modifying routes or events
bun run gen:client server.ts
```

### 2. Handle Errors Gracefully

```ts
async function fetchUser(id: number) {
  try {
    return await api.users.get({ id });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
```

### 3. Use Abort Controllers for Cancellation

```ts
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

try {
  await api.reports.generate({ type: "annual" }, {
    signal: controller.signal,
  });
} catch (error) {
  if (error.name === "AbortError") {
    console.log("Request cancelled");
  }
}
```

### 4. Reconnect SSE on Auth Changes

```ts
// After login, reconnect to get authenticated events
await api.auth.login({ ... });
api.disconnect();
api.connect();

// After logout
await api.auth.logout();
api.disconnect();
```

### 5. Clean Up SSE on Unmount

```ts
// React example
useEffect(() => {
  api.connect();
  const unsub = api.on("updates", setData);

  return () => {
    unsub();
    api.disconnect();
  };
}, []);
```
