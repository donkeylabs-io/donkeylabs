/**
 * Vite plugin for @donkeylabs/adapter-sveltekit dev server integration
 *
 * Supports two modes:
 * - `bun --bun run dev`: Single-process mode (in-process, one port)
 * - `bun run dev`: Subprocess mode (two processes, proxy)
 */

import type { Plugin, ViteDevServer } from "vite";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import http from "node:http";

export interface DevPluginOptions {
  /**
   * Path to your @donkeylabs/server entry file.
   * This file should export a configured AppServer instance.
   *
   * @default "./src/server/index.ts"
   */
  serverEntry?: string;

  /**
   * Port for the backend server (subprocess mode only).
   * @default 3001
   */
  backendPort?: number;
}

// Check if running with Bun runtime (bun --bun)
const isBunRuntime = typeof globalThis.Bun !== "undefined";

// Use globalThis to share server reference across module instances
// This is needed because SvelteKit SSR loads a separate module instance
declare global {
  var __donkeylabs_dev_server__: any;
}

/**
 * Get the global app server instance for SSR direct calls.
 * This allows hooks to access the server without HTTP.
 */
export function getDevServer(): any {
  return globalThis.__donkeylabs_dev_server__;
}

function setDevServer(server: any) {
  globalThis.__donkeylabs_dev_server__ = server;
}

/**
 * Vite plugin that integrates @donkeylabs/server with the dev server.
 *
 * - With `bun --bun run dev`: Runs in-process (single port, recommended)
 * - With `bun run dev`: Spawns subprocess (two ports, fallback)
 *
 * @example
 * // vite.config.ts
 * import { donkeylabsDev } from "@donkeylabs/adapter-sveltekit/vite";
 *
 * export default defineConfig({
 *   plugins: [
 *     donkeylabsDev({ serverEntry: "./src/server/index.ts" }),
 *     sveltekit()
 *   ]
 * });
 */
export function donkeylabsDev(options: DevPluginOptions = {}): Plugin {
  const { serverEntry = "./src/server/index.ts", backendPort = 3001 } = options;

  // State for subprocess mode
  let backendProcess: ChildProcess | null = null;
  let backendReady = false;

  // State for in-process mode
  let appServer: any = null;
  let serverReady = false;

  return {
    name: "donkeylabs-dev",
    enforce: "pre",

    async configureServer(server: ViteDevServer) {
      const serverEntryResolved = resolve(process.cwd(), serverEntry);

      if (isBunRuntime) {
        // ========== IN-PROCESS MODE (bun --bun run dev) ==========
        // Import and initialize server directly - no subprocess, no proxy
        console.log("[donkeylabs-dev] Starting in-process mode (Bun runtime detected)");

        try {
          const serverModule = await import(/* @vite-ignore */ serverEntryResolved);
          appServer = serverModule.server || serverModule.default;

          if (!appServer) {
            throw new Error("No server export found in " + serverEntry);
          }

          // Initialize without starting HTTP server
          await appServer.initialize();
          serverReady = true;
          // Set global reference for SSR direct calls (uses globalThis for cross-module sharing)
          setDevServer(appServer);
          console.log("[donkeylabs-dev] Server initialized (in-process mode)");
        } catch (err) {
          console.error("[donkeylabs-dev] Failed to initialize server:", err);
          throw err;
        }

        // Return middleware setup function
        return () => {
          // In-process request handler
          const inProcessMiddleware = async (req: any, res: any, next: any) => {
            const url = req.url || "/";

            // Handle SSE
            if (req.method === "GET" && url.startsWith("/sse")) {
              if (!serverReady || !appServer) return next();

              const fullUrl = new URL(url, "http://localhost");
              const channels = fullUrl.searchParams.get("channels")?.split(",").filter(Boolean) || [];
              const lastEventId = req.headers["last-event-id"] || undefined;

              const { client, response } = appServer.getCore().sse.addClient({ lastEventId });

              for (const channel of channels) {
                appServer.getCore().sse.subscribe(client.id, channel);
              }

              // Set SSE headers
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
              });

              // Stream SSE data
              const reader = response.body?.getReader();
              if (reader) {
                const pump = async () => {
                  try {
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      res.write(value);
                    }
                  } catch {
                    // Connection closed
                  }
                };
                pump();
              }

              req.on("close", () => {
                appServer.getCore().sse.removeClient(client.id);
              });

              return; // Don't call next()
            }

            // Handle API routes (POST only)
            if (req.method === "POST" && /^\/[a-zA-Z][a-zA-Z0-9_.]*$/.test(url)) {
              if (!serverReady || !appServer) return next();

              const routeName = url.slice(1);
              if (!appServer.hasRoute(routeName)) return next();

              // Collect body
              let body = "";
              req.on("data", (chunk: any) => (body += chunk));
              req.on("end", async () => {
                try {
                  const input = body ? JSON.parse(body) : {};
                  const ip = req.socket?.remoteAddress || "127.0.0.1";

                  const result = await appServer.callRoute(routeName, input, ip);

                  res.setHeader("Content-Type", "application/json");
                  res.setHeader("Access-Control-Allow-Origin", "*");
                  res.end(JSON.stringify(result));
                } catch (err: any) {
                  res.statusCode = err.status || 500;
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ error: err.message || "Internal error" }));
                }
              });

              return; // Don't call next()
            }

            next();
          };

          // CORS preflight
          const corsMiddleware = (req: any, res: any, next: any) => {
            if (req.method === "OPTIONS") {
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
              res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
              res.statusCode = 204;
              res.end();
              return;
            }
            next();
          };

          // Add to front of middleware stack
          const stack = (server.middlewares as any).stack;
          if (stack && Array.isArray(stack)) {
            stack.unshift({ route: "", handle: corsMiddleware });
            stack.unshift({ route: "", handle: inProcessMiddleware });
          } else {
            server.middlewares.use(inProcessMiddleware);
            server.middlewares.use(corsMiddleware);
          }
        };
      } else {
        // ========== SUBPROCESS MODE (bun run dev) ==========
        // Spawn backend as separate process and proxy requests
        console.log(`[donkeylabs-dev] Starting subprocess mode (backend on port ${backendPort})`);

        const bootstrapCode = `
          const serverModule = await import("${serverEntryResolved}");
          const server = serverModule.server || serverModule.default;

          if (!server) {
            console.error("[donkeylabs-backend] No server export found");
            process.exit(1);
          }

          server.port = ${backendPort};
          await server.start();
          console.log("[donkeylabs-backend] Server ready on port ${backendPort}");
        `;

        backendProcess = spawn("bun", ["--eval", bootstrapCode], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, NODE_ENV: "development" },
        });

        backendProcess.stdout?.on("data", (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) {
            console.log(msg);
            if (msg.includes("Server ready") || msg.includes("Server running")) {
              backendReady = true;
            }
          }
        });

        backendProcess.stderr?.on("data", (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) console.error(msg);
        });

        backendProcess.on("error", (err) => {
          console.error("[donkeylabs-dev] Failed to start backend:", err);
        });

        backendProcess.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            console.error(`[donkeylabs-dev] Backend exited with code ${code}`);
          }
          backendProcess = null;
          backendReady = false;
        });

        server.httpServer?.on("close", () => {
          if (backendProcess) {
            backendProcess.kill();
            backendProcess = null;
          }
        });

        // Return middleware setup function
        return () => {
          const waitForBackend = new Promise<void>((resolve) => {
            const check = () => (backendReady ? resolve() : setTimeout(check, 100));
            setTimeout(check, 500);
            setTimeout(() => {
              if (!backendReady) {
                console.warn("[donkeylabs-dev] Backend startup timeout");
                resolve();
              }
            }, 10000);
          });

          // Proxy middleware
          const proxyMiddleware = (req: any, res: any, next: any) => {
            const url = req.url || "/";
            const isApiRoute = req.method === "POST" && /^\/[a-zA-Z][a-zA-Z0-9_.]*$/.test(url);

            if (!isApiRoute) return next();

            waitForBackend.then(() => {
              const proxyReq = http.request(
                {
                  hostname: "localhost",
                  port: backendPort,
                  path: url,
                  method: req.method,
                  headers: { ...req.headers, host: `localhost:${backendPort}` },
                },
                (proxyRes) => {
                  res.setHeader("Access-Control-Allow-Origin", "*");
                  res.statusCode = proxyRes.statusCode || 200;
                  for (const [k, v] of Object.entries(proxyRes.headers)) {
                    if (v) res.setHeader(k, v);
                  }
                  proxyRes.pipe(res);
                }
              );

              proxyReq.on("error", (err) => {
                console.error(`[donkeylabs-dev] Proxy error:`, err.message);
                res.statusCode = 502;
                res.end(JSON.stringify({ error: "Backend unavailable" }));
              });

              req.pipe(proxyReq);
            });
          };

          const corsMiddleware = (req: any, res: any, next: any) => {
            if (req.method === "OPTIONS") {
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
              res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
              res.statusCode = 204;
              res.end();
              return;
            }
            next();
          };

          const stack = (server.middlewares as any).stack;
          if (stack && Array.isArray(stack)) {
            stack.unshift({ route: "", handle: corsMiddleware });
            stack.unshift({ route: "", handle: proxyMiddleware });
          } else {
            server.middlewares.use(proxyMiddleware);
            server.middlewares.use(corsMiddleware);
          }
        };
      }
    },

    async closeBundle() {
      if (backendProcess) {
        backendProcess.kill();
        backendProcess = null;
      }
      if (appServer) {
        await appServer.shutdown?.();
        appServer = null;
        setDevServer(null);
      }
    },
  };
}

export default donkeylabsDev;
