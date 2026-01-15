# SvelteKit App Example

A complete example of using `@donkeylabs/adapter-sveltekit` to integrate @donkeylabs/server with SvelteKit.

## Features Demonstrated

- **SSR Direct Calls** - API calls in `+page.server.ts` use direct function calls (no HTTP)
- **Browser HTTP Calls** - API calls in `+page.svelte` use fetch
- **Unified API Client** - Same interface for both SSR and browser
- **SSE (Server-Sent Events)** - Real-time updates from server to browser
- **All Core Services** - Cache, Jobs, Cron, Rate Limiter, Events, SSE

## Project Structure

```
src/
├── server/
│   └── index.ts          # @donkeylabs/server setup (plugins, routes)
├── lib/
│   ├── api.ts            # Typed API client
│   └── components/ui/    # UI components (shadcn-svelte)
├── routes/
│   ├── +page.server.ts   # SSR data loading (direct calls)
│   └── +page.svelte      # Client-side UI
└── hooks.server.ts       # SvelteKit hooks
```

## Setup

```bash
# Install dependencies
bun install

# Development
bun run dev

# Build
bun run build

# Production
PORT=3000 bun build/server/entry.js
```

## Key Files

### svelte.config.js

```js
import adapter from '@donkeylabs/adapter-sveltekit';

export default {
  kit: {
    adapter: adapter({
      serverEntry: './src/server/index.ts',
    })
  }
};
```

### src/server/index.ts

Defines the @donkeylabs/server with plugins and routes.

### src/lib/api.ts

Typed API client extending `UnifiedApiClientBase`.

### src/hooks.server.ts

```ts
import { createHandle } from "@donkeylabs/adapter-sveltekit/hooks";
export const handle = createHandle();
```

### src/routes/+page.server.ts

```ts
import { createApi } from '$lib/api';

export const load = async ({ locals }) => {
  const api = createApi({ locals }); // Direct calls
  const data = await api.counter.get();
  return { count: data.count };
};
```

### src/routes/+page.svelte

```svelte
<script>
  import { createApi } from '$lib/api';
  const api = createApi(); // HTTP calls

  // SSE subscription
  api.sse.subscribe(['events'], (event, data) => {
    // Handle real-time updates
  });
</script>
```

## Documentation

See [docs/sveltekit-adapter.md](../../docs/sveltekit-adapter.md) for complete documentation.
