import express from "express";
import type { Transaction } from "kysely";
import type { Kysely } from "kysely";
import { routeLogger, requestTimeout } from "./middleware";
import type { MagikRouter } from "./router";
import path from "path";
import cors from "cors";
import { logger, generateTraceId, runWithRequestContext, type RequestContext } from "@donkeylabs/audit-logs";
import { errorHandler } from "./middleware/errors";
import type { SimpleCache } from "./cache";
import {
  type BatchRequestPayload,
  type BatchResponsePayload,
  type BatchResultItem,
  batchRequestSchema,
  BATCH_ENDPOINT,
  BATCH_MAX_SIZE,
} from "@donkeylabs/core/src/client/batch";
import { API_VERSION_HEADER } from "@donkeylabs/core/src/interfaces/server/route";

export type DBOrTransaction<DB> = Transaction<DB> | Kysely<DB>;

export interface ServerOptions {
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeout?: number;
  /** Disable trust proxy (recommended when not behind a proxy) */
  disableTrustProxy?: boolean;
}

export type RegisteredRouter<Dependencies> = {
  router: MagikRouter;
  factory: (dependencies: Dependencies) => MagikRouter;
};

export class Server<Dependencies> {
  private app: express.Express;

  dependencies: Dependencies;
  private server: ReturnType<typeof this.app.listen> | null = null;
  private registeredRouters: Map<string, RegisteredRouter<Dependencies>> = new Map();
  private serverPort: number = 8000;

  constructor(
    dependencies: Dependencies,
    allowedOrigins: string[] = [],
    options: ServerOptions = {},
  ) {
    this.dependencies = dependencies;
    this.app = express();

    // Only enable trust proxy if explicitly needed (behind load balancer/proxy)
    // Disabled by default for direct hosting (e.g., Vultr)
    if (!options.disableTrustProxy) {
      this.app.enable("trust proxy");
    }

    const rawBodySaver = (req: express.Request, _res: express.Response, buf: Buffer) => {
      if (buf && buf.length > 0) {
        req.rawBody = Buffer.from(buf);
      }
    };

    // Request timeout middleware (default: 30 seconds)
    this.app.use(
      requestTimeout({
        timeout: options.requestTimeout ?? 30000,
        onTimeout: (req) => {
          logger.server.error(`Request timeout: ${req.method} ${req.path}`);
        },
      }),
    );

    this.app.use(routeLogger);
    // Limit payload size to 1MB to prevent DOS attacks
    this.app.use(express.json({ verify: rawBodySaver, limit: "1mb" }));
    this.app.use(express.urlencoded({ extended: true, verify: rawBodySaver, limit: "1mb" }));
    this.app.use(
      cors({
        origin: allowedOrigins,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        allowedHeaders: ["Content-Type", "Authorization", "Access-Control-Allow-Origin"],
        credentials: true,
        maxAge: 86400,
      }),
    );
    const publicPath = path.join(__dirname, "public");
    this.app.use(express.static(publicPath));
    logger.server.debug("Static files path:", publicPath);
  }

  registerRouter(routerFactory: (dependencies: Dependencies) => MagikRouter) {
    const router = routerFactory(this.dependencies);
    const routerDef = router.getRouter();
    const routerName = routerDef.routeName;

    // Store the router for batch endpoint access
    this.registeredRouters.set(routerName, { router, factory: routerFactory });

    this.app.use(router.getApp());
  }

  /**
   * Register the /api/batch endpoint for batching multiple requests.
   * This endpoint makes internal HTTP calls to existing routes, so all routes
   * work automatically without any additional registration.
   *
   * @param routeMap A map of "router.route" -> { path, method } for route lookup
   * @param options Optional configuration for the batch endpoint
   */
  registerBatchEndpoint(
    routeMap: Map<string, { path: string; method: string }>,
    options: { requireAuth?: boolean } = {},
  ) {
    this.app.post(BATCH_ENDPOINT, async (req: express.Request, res: express.Response) => {
      // Security: Prevent nested batch requests (DoS amplification attack)
      if (req.headers["x-batch-request"] === "true") {
        res.status(400).json({
          type: "VALIDATION_ERROR",
          message: "Nested batch requests are not allowed",
        });
        return;
      }

      // Security: Optionally require authentication for batch requests
      // This helps prevent DoS attacks since unauthenticated users can't batch
      if (options.requireAuth && !req.headers.authorization) {
        res.status(401).json({
          type: "UNAUTHORIZED",
          message: "Batch requests require authentication",
        });
        return;
      }

      const startTime = performance.now();
      // Use the trace ID from audit middleware if available, otherwise generate one
      // This ensures sub-requests share the same trace as the main batch request
      const auditTraceId = (req as any).auditContext?.traceId;
      const traceId = auditTraceId || generateTraceId();

      // Debug logging for batch trace ID
      console.log(`[Batch] Starting batch request | auditTraceId=${auditTraceId || "none"} | using traceId=${traceId}`);

      const requestContext: RequestContext = {
        traceId,
        method: "POST",
        path: BATCH_ENDPOINT,
        startTime: Date.now(),
      };

      await runWithRequestContext(requestContext, async () => {
        try {
          // Parse and validate batch request
          const parseResult = batchRequestSchema.safeParse(req.body);
          if (!parseResult.success) {
            res.status(400).json({
              type: "VALIDATION_ERROR",
              message: "Invalid batch request",
              details: parseResult.error.issues,
            });
            return;
          }

          const payload: BatchRequestPayload = parseResult.data;

          if (payload.requests.length > BATCH_MAX_SIZE) {
            res.status(400).json({
              type: "VALIDATION_ERROR",
              message: `Batch size exceeds maximum of ${BATCH_MAX_SIZE}`,
            });
            return;
          }

          // Get auth header to pass through to internal requests
          const authHeader = req.headers.authorization;
          const traceShort = traceId.slice(0, 20);
          const mode = payload.failFast ? "parallel" : "batch";

          // Visual batch start marker
          console.log(
            `\n┌─────────────────────────────────────────────────────────┐\n` +
            `│ 📦 BATCH ${mode.toUpperCase()} [${traceShort}] - ${payload.requests.length} requests\n` +
            `├─────────────────────────────────────────────────────────┤`
          );

          // Execute all requests in parallel using internal HTTP calls
          const results: BatchResultItem[] = await Promise.all(
            payload.requests.map(async (batchReq) => {
              const reqStartTime = performance.now();
              const routeKey = `${batchReq.router}.${batchReq.route}`;

              try {
                // Look up route info
                const routeInfo = routeMap.get(routeKey);
                if (!routeInfo) {
                  return {
                    id: batchReq.id,
                    ok: false as const,
                    error: {
                      type: "NOT_FOUND",
                      message: `Route ${routeKey} not found`,
                    },
                    ms: performance.now() - reqStartTime,
                  };
                }

                // Make internal HTTP request to the actual route
                // Use 127.0.0.1 instead of localhost for better container compatibility
                const internalUrl = `http://127.0.0.1:${this.serverPort}${routeInfo.path}`;

                const headers: Record<string, string> = {
                  "content-type": "application/json",
                  "x-batch-request": "true",
                  "x-batch-trace-id": traceId,
                };
                if (batchReq.version) {
                  headers[API_VERSION_HEADER] = batchReq.version;
                }

                // Pass through auth header
                if (authHeader) {
                  headers["Authorization"] = authHeader;
                }

                const internalResponse = await fetch(internalUrl, {
                  method: routeInfo.method.toUpperCase(),
                  headers,
                  body: routeInfo.method !== "get" ? JSON.stringify(batchReq.params) : undefined,
                });

                const responseData = await internalResponse.json();

                if (!internalResponse.ok) {
                  return {
                    id: batchReq.id,
                    ok: false as const,
                    error: responseData,
                    ms: performance.now() - reqStartTime,
                  };
                }

                return {
                  id: batchReq.id,
                  ok: true as const,
                  data: responseData,
                  cached: false,
                  ms: performance.now() - reqStartTime,
                };
              } catch (error) {
                const apiError =
                  error instanceof Error
                    ? {
                        type: (error as any).type || "INTERNAL_SERVER_ERROR",
                        message: error.message,
                        details: (error as any).details,
                      }
                    : {
                        type: "INTERNAL_SERVER_ERROR",
                        message: String(error),
                      };

                return {
                  id: batchReq.id,
                  ok: false as const,
                  error: apiError,
                  ms: performance.now() - reqStartTime,
                };
              }
            }),
          );

          const totalMs = performance.now() - startTime;
          const response: BatchResponsePayload = {
            traceId,  // Use server trace ID so client can correlate with audit logs
            totalMs,
            results,
          };

          const successCount = results.filter((r) => r.ok).length;
          const errorCount = results.filter((r) => !r.ok).length;
          const statusEmoji = errorCount > 0 ? "⚠️" : "✅";

          // Visual batch end marker
          console.log(
            `├─────────────────────────────────────────────────────────┤\n` +
            `│ ${statusEmoji} COMPLETE: ${successCount} ok, ${errorCount} errors - ${totalMs.toFixed(1)}ms total\n` +
            `└─────────────────────────────────────────────────────────┘\n`
          );

          res.json(response);
        } catch (error) {
          logger.server.tag("Batch").event("error", "batch.error", {
            error: error instanceof Error ? error.message : String(error),
          });
          errorHandler(error, res, req);
        }
      });
    });
  }

  /**
   * Add Express middleware to the server
   */
  use(middleware: express.RequestHandler) {
    this.app.use(middleware);
  }

  async shutdown() {
    if (this.server) {
      await new Promise((resolve) => {
        this.server?.close(() => {
          resolve(undefined);
        });
      });
    }
  }

  listen(port: number) {
    this.serverPort = port;
    logger.server.info(`[${Bun.env.STAGE}] running on port ${port}`);
    this.server = this.app.listen({ port });
  }
}
