# SvelteKit Adapter

`@donkeylabs/adapter-sveltekit` integrates @donkeylabs/server with SvelteKit, running both in a single Bun process.

## Features

- **Single Process** - One Bun.serve() handles SvelteKit pages and API routes
- **SSR Direct Calls** - No HTTP overhead during server-side rendering
- **Unified API Client** - Same interface in SSR and browser
- **SSE Support** - Real-time server-sent events in the browser
- **Type Safety** - Full TypeScript support throughout

---

## Installation

```bash
bun add @donkeylabs/adapter-sveltekit @donkeylabs/server
```

---

## Quick Setup

### 1. Configure the Adapter

```js
// svelte.config.js
import adapter from '@donkeylabs/adapter-sveltekit';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      serverEntry: './src/server/index.ts',
    })
  }
};
```

### 2. Create the Server Entry

```ts
// src/server/index.ts
import { AppServer, createPlugin, createRouter } from "@donkeylabs/server";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { z } from "zod";

// Database setup
const db = new Kysely<{}>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

// Create a plugin
const myPlugin = createPlugin.define({
  name: "myPlugin",
  service: async (ctx) => ({
    getData: () => ({ message: "Hello from plugin!" }),
  }),
});

// Create routes
const api = createRouter("api");

api.route("data.get").typed({
  handle: async (_input, ctx) => ctx.plugins.myPlugin.getData(),
});

// Create and export the server
export const server = new AppServer({
  db,
  port: 0, // Port managed by adapter
});

server.registerPlugin(myPlugin);
server.use(api);
```

### 3. Set Up Hooks

```ts
// src/hooks.server.ts
import { createHandle } from "@donkeylabs/adapter-sveltekit/hooks";

export const handle = createHandle();
```

### 4. Create the API Client

```ts
// src/lib/api.ts
import { UnifiedApiClientBase } from "@donkeylabs/adapter-sveltekit/client";

interface DataResponse {
  message: string;
}

export class ApiClient extends UnifiedApiClientBase {
  data = {
    get: () => this.request<{}, DataResponse>("api.data.get", {}),
  };
}

export function createApi(options?: { locals?: any }) {
  return new ApiClient(options);
}
```

---

## Usage

### SSR (Server-Side Rendering)

In `+page.server.ts`, pass `locals` to get direct service calls without HTTP:

```ts
// src/routes/+page.server.ts
import type { PageServerLoad } from './$types';
import { createApi } from '$lib/api';

export const load: PageServerLoad = async ({ locals }) => {
  // Pass locals for direct calls (no HTTP!)
  const api = createApi({ locals });

  const data = await api.data.get();

  return {
    message: data.message,
  };
};
```

### Browser

In `+page.svelte`, create the client without locals:

```svelte
<script lang="ts">
  import { createApi } from '$lib/api';

  let { data } = $props();

  // Browser client - uses HTTP calls
  const api = createApi();

  async function refresh() {
    const result = await api.data.get();
    data.message = result.message;
  }
</script>

<h1>{data.message}</h1>
<button onclick={refresh}>Refresh</button>
```

---

## SSE (Server-Sent Events)

The unified client includes SSE support for real-time updates.

### Server Setup

Broadcast events from your plugin:

```ts
// In plugin init or service method
ctx.core.sse.broadcast("notifications", "new-message", {
  id: Date.now(),
  text: "Hello!",
});
```

### Client Subscription

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { createApi } from '$lib/api';

  const api = createApi();
  let messages = $state<Array<{ id: number; text: string }>>([]);

  onMount(() => {
    if (!browser) return;

    // Subscribe to SSE channel
    const unsubscribe = api.sse.subscribe(
      ['notifications'],
      (eventType, eventData) => {
        if (eventType === 'new-message') {
          messages = [eventData, ...messages];
        }
      }
    );

    return unsubscribe;
  });
</script>

<ul>
  {#each messages as msg}
    <li>{msg.text}</li>
  {/each}
</ul>
```

---

## How It Works

### Request Flow

```
Request → Bun.serve()
    │
    ├─ POST /api.route.name → AppServer.handleRequest() → Response
    │
    ├─ GET /sse?channels=... → SSE stream
    │
    └─ GET /page → SvelteKit.respond()
                      │
                      └─ hooks.server.ts handle()
                            │
                            └─ locals.handleRoute = direct caller
                                  │
                                  └─ +page.server.ts load()
                                        │
                                        └─ api.route() → DIRECT (no HTTP)
```

### SSR vs Browser

| Environment | API Client | Transport |
|-------------|------------|-----------|
| `+page.server.ts` | `createApi({ locals })` | Direct function call |
| `+page.svelte` | `createApi()` | HTTP POST |
| SSE subscription | `api.sse.subscribe()` | EventSource (browser only) |

---

## Adapter Options

```ts
adapter({
  // Required: Path to your @donkeylabs/server setup
  serverEntry: './src/server/index.ts',

  // Optional: Output directory (default: "build")
  out: 'build',

  // Optional: Precompress static assets (default: true)
  precompress: true,

  // Optional: Environment variable prefix (default: "")
  envPrefix: '',
})
```

---

## Building and Running

```bash
# Development
bun run dev

# Build
bun run build

# Production
PORT=3000 bun build/server/entry.js
```

---

## Accessing Server Context

The hooks provide access to server internals through `locals`:

```ts
// In +page.server.ts
export const load: PageServerLoad = async ({ locals }) => {
  // Direct route handler (for API client)
  locals.handleRoute("api.route.name", input);

  // Plugin services (direct access)
  locals.plugins.myPlugin.getData();

  // Core services
  locals.core.logger.info("Hello");
  locals.core.cache.get("key");

  // Database
  locals.db.selectFrom("users").execute();

  // Client IP
  locals.ip;
};
```

---

## TypeScript Setup

Add path aliases in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "$lib/*": ["./src/lib/*"]
    }
  }
}
```

---

## Common Patterns

### Typed API Client

Create a fully typed client that mirrors your routes:

```ts
// src/lib/api.ts
import { UnifiedApiClientBase } from "@donkeylabs/adapter-sveltekit/client";

// Define response types
interface User { id: string; name: string; }
interface UsersResponse { users: User[]; }

export class ApiClient extends UnifiedApiClientBase {
  users = {
    list: () =>
      this.request<{}, UsersResponse>("api.users.list", {}),
    get: (input: { id: string }) =>
      this.request<typeof input, User>("api.users.get", input),
    create: (input: { name: string }) =>
      this.request<typeof input, User>("api.users.create", input),
  };
}

export function createApi(options?: { locals?: any }) {
  return new ApiClient(options);
}
```

### Error Handling

```ts
// +page.server.ts
export const load: PageServerLoad = async ({ locals }) => {
  const api = createApi({ locals });

  try {
    const data = await api.users.get({ id: "123" });
    return { user: data };
  } catch (error) {
    // Handle API errors
    return { user: null, error: "User not found" };
  }
};
```

### Real-Time Updates with SSE

```ts
// Server: Broadcast on data changes
api.route("users.create").typed({
  input: z.object({ name: z.string() }),
  handle: async (input, ctx) => {
    const user = await createUser(input);

    // Broadcast to connected clients
    ctx.core.sse.broadcast("users", "user-created", user);

    return user;
  },
});

// Client: Listen for updates
api.sse.subscribe(["users"], (event, data) => {
  if (event === "user-created") {
    users = [...users, data];
  }
});
```

---

## Troubleshooting

### SSR calls returning errors

Ensure you pass `locals` to the API client:
```ts
const api = createApi({ locals }); // ✓ Correct
const api = createApi(); // ✗ Will use HTTP, may fail during SSR
```

### SSE events not appearing

1. Check the channel name matches between broadcast and subscribe
2. SSE only works in browser - returns no-op in SSR
3. Named events require `addEventListener` - the client handles this automatically

### Build errors

Ensure your `serverEntry` path is correct and exports `server`:
```ts
// Must export as named 'server' or default
export const server = new AppServer({ ... });
```
