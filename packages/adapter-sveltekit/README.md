# @donkeylabs/adapter-sveltekit

SvelteKit adapter for `@donkeylabs/server`. Enables seamless integration between SvelteKit and your backend API with:

- **Single Bun process** serves both SvelteKit pages and API routes
- **Direct service calls during SSR** (no HTTP overhead)
- **Unified API client** works identically in SSR and browser

## Installation

```bash
bun add @donkeylabs/adapter-sveltekit
```

## Quick Start

### 1. Configure the Adapter

```ts
// svelte.config.js
import adapter from "@donkeylabs/adapter-sveltekit";

export default {
  kit: {
    adapter: adapter({
      serverEntry: "./src/server/index.ts",
    }),
  },
};
```

### 2. Add Vite Plugin for Development

```ts
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { donkeylabsDev } from "@donkeylabs/adapter-sveltekit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    donkeylabsDev({ serverEntry: "./src/server/index.ts" }),
    sveltekit(),
  ],
});
```

### 3. Set Up Server Hooks

```ts
// src/hooks.server.ts
import { createHandle } from "@donkeylabs/adapter-sveltekit/hooks";

export const handle = createHandle();
```

### 4. Generate API Client

```ts
// donkeylabs.config.ts
import { defineConfig } from "@donkeylabs/server";
import { SvelteKitClientGenerator } from "@donkeylabs/adapter-sveltekit/generator";

export default defineConfig({
  plugins: ["./src/server/plugins/**/index.ts"],
  client: {
    output: "./src/lib/api.ts",
    generator: SvelteKitClientGenerator,
  },
});
```

### 5. Use the API Client

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { ApiClient } from "$lib/api";

  const api = new ApiClient();

  async function greet() {
    const result = await api.greet({ name: "World" });
    console.log(result.message);
  }
</script>
```

In SSR (`+page.server.ts`), pass `locals` for direct service calls:

```ts
// src/routes/+page.server.ts
import { ApiClient } from "$lib/api";

export async function load({ locals, fetch }) {
  const api = new ApiClient({ locals, fetch });
  const data = await api.getData({}); // Direct call, no HTTP!
  return { data };
}
```

## Development Modes

### Recommended: In-Process Mode

Run with `bun --bun` for single-process development:

```bash
bun --bun run dev
```

- Single port (5173)
- Direct service calls during SSR
- Hot reload for both frontend and backend

### Fallback: Subprocess Mode

Run without `--bun` flag:

```bash
bun run dev
```

- Two processes (Vite on 5173, backend on 3001)
- API requests proxied to backend
- Use when in-process mode has compatibility issues

## Production Build

```bash
bun run build
bun build/server/entry.js
```

## Package Exports

| Export | Description |
|--------|-------------|
| `@donkeylabs/adapter-sveltekit` | Main adapter function |
| `@donkeylabs/adapter-sveltekit/client` | Unified API client base |
| `@donkeylabs/adapter-sveltekit/hooks` | SvelteKit hooks helpers |
| `@donkeylabs/adapter-sveltekit/generator` | Client code generator |
| `@donkeylabs/adapter-sveltekit/vite` | Vite dev plugin |

## Type Definitions

Add to your `app.d.ts`:

```ts
// src/app.d.ts
import type { DonkeylabsLocals } from "@donkeylabs/adapter-sveltekit/hooks";

declare global {
  namespace App {
    interface Locals extends DonkeylabsLocals {}
  }
}

export {};
```

## SSE (Server-Sent Events)

Subscribe to real-time events in the browser:

```ts
const api = new ApiClient();

const unsubscribe = api.sse.subscribe(
  ["notifications", "updates"],
  (event, data) => {
    console.log("Event:", event, data);
  }
);

// Later: unsubscribe();
```

## License

MIT
