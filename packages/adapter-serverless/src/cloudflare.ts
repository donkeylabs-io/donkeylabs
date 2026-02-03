// packages/adapter-serverless/src/cloudflare.ts
/**
 * Cloudflare Workers Adapter
 * 
 * Usage:
 * ```typescript
 * // wrangler.toml
 * name = "my-app"
 * main = "dist/index.js"
 * compatibility_date = "2024-01-01"
 * 
 * [vars]
 * DATABASE_URL = "postgresql://..."
 * 
 * // src/index.ts
 * import { createCloudflareHandler } from "@donkeylabs/adapter-serverless/cloudflare";
 * import { createServer } from "./server";
 * 
 * export default createCloudflareHandler(createServer);
 * ```
 */

import { AppServer } from "@donkeylabs/server";

export interface CloudflareEnv {
  DATABASE_URL: string;
  JWT_SECRET?: string;
  [key: string]: string | undefined;
}

let serverInstance: AppServer | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Create a handler for Cloudflare Workers
 * 
 * Cloudflare Workers are stateless and use the Fetch API
 * They don't have Node.js APIs, so we need to be careful
 */
export function createCloudflareHandler(
  serverFactory: (env: CloudflareEnv) => AppServer | Promise<AppServer>
): {
  fetch: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;
} {
  return {
    async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
      // Initialize on first request
      if (!serverInstance && !initPromise) {
        initPromise = initializeServer(serverFactory, env);
      }
      
      if (initPromise) {
        await initPromise;
      }
      
      if (!serverInstance) {
        return new Response(JSON.stringify({ error: "Server initialization failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      try {
        // Extract route from URL
        const url = new URL(request.url);
        const routeName = extractRouteName(url);
        
        // Get client IP from CF headers
        const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
        
        // Handle the request
        const response = await serverInstance.handleRequest(
          request,
          routeName,
          clientIP
        );
        
        if (!response) {
          return new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        
        return response;
      } catch (error) {
        console.error("Request handler error:", error);
        return new Response(
          JSON.stringify({ 
            error: "Internal server error",
            message: env.NODE_ENV === "development" ? String(error) : undefined,
          }), 
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    },
  };
}

async function initializeServer(
  serverFactory: (env: CloudflareEnv) => AppServer | Promise<AppServer>,
  env: CloudflareEnv
): Promise<void> {
  try {
    serverInstance = await serverFactory(env);
    await serverInstance.initialize();
    console.log("Server initialized (Cloudflare Workers mode)");
  } catch (error) {
    console.error("Server initialization failed:", error);
    throw error;
  } finally {
    initPromise = null;
  }
}

function extractRouteName(url: URL): string {
  const path = url.pathname;
  
  if (path === "/" || path === "/api") {
    return "health.check";
  }
  
  // Convert /api/users.list -> api.users.list
  const route = path
    .replace(/^\/api\//, "")
    .replace(/\//g, ".");
  
  return route || "health.check";
}

/**
 * Durable Objects adapter for stateful WebSocket connections
 * Use this if you need WebSockets or stateful sessions
 */
export class DonkeylabsDurableObject {
  private server: AppServer | null = null;
  private env: CloudflareEnv;
  
  constructor(state: DurableObjectState, env: CloudflareEnv) {
    this.env = env;
  }
  
  async fetch(request: Request): Promise<Response> {
    if (!this.server) {
      // Initialize server with this DO's state
      // This allows for stateful sessions
    }
    
    return new Response("Durable Object handler");
  }
}
