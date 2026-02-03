/**
 * SvelteKit hooks helper for @donkeylabs/adapter-sveltekit
 */

import type { Handle, RequestEvent } from "@sveltejs/kit";

// Try to import dev server reference (only available in dev mode)
let getDevServer: (() => any) | undefined;
try {
  // Dynamic import to avoid bundling vite.ts in production
  const viteModule = await import("../vite.js");
  getDevServer = viteModule.getDevServer;
} catch {
  // Not in dev mode or vite not available
}

/**
 * Safely get client IP address with fallback.
 * SvelteKit's getClientAddress() throws when running with Bun or without proper proxy headers.
 */
function safeGetClientAddress(event: RequestEvent): string {
  try {
    return safeGetClientAddress(event);
  } catch {
    // Fallback when address cannot be determined (e.g., Bun runtime, SSR without client)
    return "127.0.0.1";
  }
}

export interface DonkeylabsPlatform {
  donkeylabs?: {
    services: Record<string, any>;
    core: {
      logger: any;
      cache: any;
      events: any;
      cron: any;
      jobs: any;
      sse: any;
      rateLimiter: any;
      db: any;
    };
    /** Direct route handler for SSR (no HTTP!) */
    handleRoute: (routeName: string, input: any) => Promise<any>;
  };
}

export interface DonkeylabsLocals {
  plugins: Record<string, any>;
  core: {
    logger: any;
    cache: any;
    events: any;
    sse: any;
  };
  db: any;
  ip: string;
  /** Direct route handler for SSR API calls */
  handleRoute?: (routeName: string, input: any) => Promise<any>;
}

/**
 * Create a SvelteKit handle function that populates event.locals
 * with @donkeylabs/server context.
 *
 * @example
 * // src/hooks.server.ts
 * import { createHandle } from "@donkeylabs/adapter-sveltekit/hooks";
 * export const handle = createHandle();
 */
export function createHandle(): Handle {
  return async ({ event, resolve }) => {
    const platform = event.platform as DonkeylabsPlatform | undefined;

    if (platform?.donkeylabs) {
      // Production mode: use platform.donkeylabs from adapter
      const { services, core, handleRoute } = platform.donkeylabs;

      // Populate locals with server context
      (event.locals as DonkeylabsLocals).plugins = services;
      (event.locals as DonkeylabsLocals).core = {
        logger: core.logger,
        cache: core.cache,
        events: core.events,
        sse: core.sse,
      };
      (event.locals as DonkeylabsLocals).db = core.db;
      (event.locals as DonkeylabsLocals).ip = safeGetClientAddress(event);
      // Expose the direct route handler for SSR API calls
      (event.locals as DonkeylabsLocals).handleRoute = handleRoute;
    } else if (getDevServer) {
      // Dev mode: use global dev server from vite plugin
      const devServer = getDevServer();
      if (devServer) {
        const core = devServer.getCore();
        const plugins = devServer.getServices();

        (event.locals as DonkeylabsLocals).plugins = plugins;
        (event.locals as DonkeylabsLocals).core = {
          logger: core.logger,
          cache: core.cache,
          events: core.events,
          sse: core.sse,
        };
        (event.locals as DonkeylabsLocals).db = core.db;
        (event.locals as DonkeylabsLocals).ip = safeGetClientAddress(event);
        // Direct route handler for SSR
        (event.locals as DonkeylabsLocals).handleRoute = async (routeName: string, input: any) => {
          return devServer.callRoute(routeName, input, safeGetClientAddress(event));
        };
      }
    }

    return resolve(event);
  };
}

/**
 * Sequence multiple handle functions together.
 *
 * @example
 * import { sequence, createHandle } from "@donkeylabs/adapter-sveltekit/hooks";
 * export const handle = sequence(createHandle(), myOtherHandle);
 */
export function sequence(...handlers: Handle[]): Handle {
  return async ({ event, resolve }) => {
    let resolveChain = resolve;

    for (let i = handlers.length - 1; i >= 0; i--) {
      const handler = handlers[i];
      const next = resolveChain;
      resolveChain = (event) => handler({ event, resolve: next });
    }

    return resolveChain(event);
  };
}
