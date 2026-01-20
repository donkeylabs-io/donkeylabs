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
            const urlObj = new URL(url, "http://localhost");
            const pathname = urlObj.pathname;

            // Handle SSE endpoint
            if (req.method === "GET" && pathname === "/sse") {
              if (!serverReady || !appServer) return next();

              const channels = urlObj.searchParams.get("channels")?.split(",").filter(Boolean) || [];
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
              let sseClosed = false;

              req.on("close", () => {
                sseClosed = true;
                reader?.cancel().catch(() => {});
                appServer.getCore().sse.removeClient(client.id);
              });

              if (reader) {
                const pump = async () => {
                  try {
                    while (!sseClosed) {
                      const { done, value } = await reader.read();
                      if (done || sseClosed) break;
                      res.write(value);
                    }
                  } catch {
                    // Connection closed
                  }
                };
                pump();
              }

              return; // Don't call next()
            }

            // Handle API routes (GET or POST for route names like /routeName.action)
            if ((req.method === "GET" || req.method === "POST") && /^\/[a-zA-Z][a-zA-Z0-9_.]*$/.test(pathname)) {
              if (!serverReady || !appServer) return next();

              const routeName = pathname.slice(1);
              if (!appServer.hasRoute(routeName)) return next();

              // Build a proper Request object to pass to handleRequest
              const buildRequest = async (): Promise<Request> => {
                const fullUrl = `http://localhost${url}`;
                const headers = new Headers();
                for (const [key, value] of Object.entries(req.headers)) {
                  if (typeof value === "string") {
                    headers.set(key, value);
                  } else if (Array.isArray(value)) {
                    for (const v of value) headers.append(key, v);
                  }
                }

                if (req.method === "POST") {
                  // Collect body for POST
                  const chunks: Buffer[] = [];
                  for await (const chunk of req) {
                    chunks.push(chunk);
                  }
                  const body = Buffer.concat(chunks);
                  return new Request(fullUrl, {
                    method: "POST",
                    headers,
                    body,
                  });
                }

                return new Request(fullUrl, { method: "GET", headers });
              };

              try {
                const request = await buildRequest();
                const ip = req.socket?.remoteAddress || "127.0.0.1";

                // Use handleRequest which properly handles all handler types (typed, raw, stream, sse, html)
                const response = await appServer.handleRequest(
                  request,
                  routeName,
                  ip,
                  { corsHeaders: { "Access-Control-Allow-Origin": "*" } }
                );

                if (!response) {
                  return next();
                }

                // Stream the response back
                res.statusCode = response.status;
                for (const [key, value] of response.headers) {
                  res.setHeader(key, value);
                }

                // Flush headers immediately for streaming responses
                if (typeof res.flushHeaders === "function") {
                  res.flushHeaders();
                }

                // Handle body streaming (non-blocking for continuous streams like MJPEG)
                if (response.body) {
                  const reader = response.body.getReader();
                  let closed = false;

                  // Handle client disconnect
                  req.on("close", () => {
                    closed = true;
                    reader.cancel().catch(() => {});
                  });

                  // Pump without awaiting - allows continuous streams
                  const pump = async () => {
                    try {
                      while (!closed) {
                        const { done, value } = await reader.read();
                        if (done || closed) {
                          if (!closed) res.end();
                          break;
                        }
                        // Write and check if client is still connected
                        const canContinue = res.write(value);
                        if (!canContinue && !closed) {
                          // Backpressure - wait for drain
                          await new Promise<void>(resolve => res.once("drain", resolve));
                        }
                      }
                    } catch {
                      if (!closed) res.end();
                    }
                  };
                  pump(); // Don't await - let it run in background
                } else {
                  res.end();
                }
              } catch (err: any) {
                console.error("[donkeylabs-dev] Request error:", err);
                res.statusCode = err.status || 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message || "Internal error" }));
              }

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

          // Proxy middleware - handles GET and POST for API routes
          const proxyMiddleware = (req: any, res: any, next: any) => {
            const url = req.url || "/";
            const urlObj = new URL(url, "http://localhost");
            const pathname = urlObj.pathname;
            // API routes are GET or POST to paths like /routeName.action
            const isApiRoute = (req.method === "GET" || req.method === "POST") && /^\/[a-zA-Z][a-zA-Z0-9_.]*$/.test(pathname);

            if (!isApiRoute) return next();

            waitForBackend.then(() => {
              let proxyAborted = false;

              const proxyReq = http.request(
                {
                  hostname: "localhost",
                  port: backendPort,
                  path: url, // Include query string
                  method: req.method,
                  headers: { ...req.headers, host: `localhost:${backendPort}` },
                },
                (proxyRes) => {
                  if (proxyAborted) return;

                  res.setHeader("Access-Control-Allow-Origin", "*");
                  res.statusCode = proxyRes.statusCode || 200;
                  for (const [k, v] of Object.entries(proxyRes.headers)) {
                    if (v) res.setHeader(k, v);
                  }

                  // Flush headers for streaming responses
                  if (typeof res.flushHeaders === "function") {
                    res.flushHeaders();
                  }

                  // Stream response back (works for binary/streaming responses)
                  proxyRes.pipe(res);

                  // Clean up on proxy response end
                  proxyRes.on("end", () => {
                    if (!proxyAborted) res.end();
                  });
                }
              );

              // Handle client disconnect - abort proxy request
              req.on("close", () => {
                if (!proxyAborted) {
                  proxyAborted = true;
                  proxyReq.destroy();
                }
              });

              proxyReq.on("error", (err) => {
                if (proxyAborted) return; // Ignore errors after abort
                console.error(`[donkeylabs-dev] Proxy error:`, err.message);
                res.statusCode = 502;
                res.end(JSON.stringify({ error: "Backend unavailable" }));
              });

              // For POST, pipe the body; for GET, just end
              if (req.method === "POST") {
                req.pipe(proxyReq);
              } else {
                proxyReq.end();
              }
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
