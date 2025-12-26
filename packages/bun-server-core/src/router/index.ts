import express, { type Request, type Response } from "express";
import geoip from "geoip-lite";

import type { RouterDefinition } from "@donkeylabs/core/src/interfaces/server/router";
import {
  APIErrors,
  API_VERSION_HEADER,
  type AnyRouteDefinition,
  type RouteDefinition,
  type RequestTypeForRoute,
  isVersionedRouteDefinition,
} from "@donkeylabs/core";
import { errorHandler } from "../middleware/errors";
import type { SimpleCache } from "../cache";
import { RateLimiter } from "../middleware/rate-limit";
import { getClientIP, isPrivateIP } from "../middleware";
import { runWithRequestContext, generateTraceId, type RequestContext, logger } from "@donkeylabs/audit-logs";

export type Context<RouterType = any> = {
  req: express.Request;
  res: express.Response;
  permissions: string[];
  router: RouterType;
  routeName: string;
  routeVersion?: string;
  rateLimiter: RateLimiter;
  // Request tracking
  traceId: string;
  // True if this request is part of a batch
  isBatchRequest: boolean;
  // Session info (set by auth middleware)
  userId?: number;
  employeeId?: number;
  username?: string;
  tokenIssuedAt?: Date;
};

type RouteHandler = (input: any, context: Context) => Promise<void>;

export class MagikRouter<
  T extends Record<string, string> = any,
  Routes extends Record<string, AnyRouteDefinition> = any,
> {
  private app: express.Router;
  private router: RouterDefinition<T, Routes>;
  private cache: SimpleCache;
  private registeredRoutes: Set<string> = new Set();
  private unversionedHandlers: Map<string, RouteHandler> = new Map();
  private versionedHandlers: Map<string, Map<string, RouteHandler>> = new Map();

  constructor(router: RouterDefinition<T, Routes>, cache: SimpleCache) {
    this.app = express.Router();
    this.router = router;
    this.cache = cache;
  }

  getApp(): express.Router {
    return this.app;
  }

  getRouter(): RouterDefinition<T, Routes> {
    return this.router;
  }

  routePermissions(permissions: string[]): string[] {
    // Use lowercase to match how permissions are stored by syncPermissions
    const routeNameLower = this.router.routeName.toLowerCase();
    return permissions.map((permission) => `${routeNameLower}:${permission}`);
  }

  // async handler<K extends keyof Routes>(
  //   routeName: K,
  //   implementation: (input: Routes[K]["RequestType"]) => Promise<Routes[K]["ResponseType"]>,
  // ) {
  //   const routeDef = this.router.routes[routeName];
  //   if (!routeDef) {
  //     throw new Error(`Route ${String(routeName)} not implemented`);
  //   }
  //   this.app[routeDef.method](routeDef.path, async (req, res) => {
  //     try {
  //       const input = routeDef.parseBody(req.body);
  //       const output = await implementation(input);
  //       res.json(output);
  //     } catch (error) {
  //       errorHandler(error, res);
  //     }
  //   });
  // }

  handle<K extends keyof Routes>(
    routeName: K,
    implementation: (input: RequestTypeForRoute<Routes[K]>, context: Context) => Promise<void>,
  ): void;
  handle<K extends keyof Routes, V extends string>(
    routeName: K,
    version: V,
    implementation: (input: RequestTypeForRoute<Routes[K], V>, context: Context) => Promise<void>,
  ): void;
  handle<K extends keyof Routes>(
    routeName: K,
    versionOrImplementation: string | RouteHandler,
    maybeImplementation?: RouteHandler,
  ): void {
    const routeSpec = this.router.routes[routeName];
    if (!routeSpec) {
      throw new Error(`Route ${String(routeName)} not implemented`);
    }

    const routeKey = String(routeName);
    const isVersioned = isVersionedRouteDefinition(routeSpec);
    const implementation =
      typeof versionOrImplementation === "string" ? maybeImplementation : (versionOrImplementation as RouteHandler);
    const requestedVersion = typeof versionOrImplementation === "string" ? versionOrImplementation : undefined;

    if (!implementation) {
      throw new Error(`Route ${routeKey} missing implementation`);
    }

    if (isVersioned) {
      const version = requestedVersion ?? String(routeSpec.defaultVersion);
      if (!routeSpec.versions[version]) {
        throw new Error(`Route ${routeKey} does not support version ${version}`);
      }
      const handlers = this.versionedHandlers.get(routeKey) ?? new Map();
      handlers.set(version, implementation);
      this.versionedHandlers.set(routeKey, handlers);
    } else {
      if (requestedVersion) {
        throw new Error(`Route ${routeKey} is not versioned`);
      }
      this.unversionedHandlers.set(routeKey, implementation);
    }

    if (this.registeredRoutes.has(routeKey)) {
      return;
    }

    const registrationRoute = this.getRegistrationRouteDefinition(routeSpec, routeKey);
    this.registeredRoutes.add(routeKey);

    this.app[registrationRoute.method](registrationRoute.path, async (req: Request, res: Response) => {
      // Reuse trace ID from batch request header, audit middleware, or generate new one
      // This ensures all requests in a batch share the same trace ID for unified logging
      const batchTraceId = req.headers["x-batch-trace-id"] as string | undefined;
      const existingTraceId = (req as any).auditContext?.traceId;
      const traceId = batchTraceId || existingTraceId || generateTraceId();
      const isBatchRequest = req.headers["x-batch-request"] === "true";

      // Create request context for logging - all logs during this request
      // will be associated with this trace ID
      const clientIP = getClientIP(req);
      const geo = !isPrivateIP(clientIP) ? geoip.lookup(clientIP) : null;

      const requestContext: RequestContext = {
        traceId,
        method: req.method,
        path: req.path,
        startTime: Date.now(),
        // Mark batch sub-requests so Logger audit callback can skip them
        isBatchSubRequest: isBatchRequest,
        // Capture client IP and user agent for audit logs
        ipAddress: clientIP,
        userAgent: req.headers["user-agent"],
        // Geo location from IP
        geoCountry: geo?.country,
        geoCity: geo?.city,
        geoRegion: geo?.region,
      };

      // Run the entire request handling within the request context
      // This ensures all Logger calls include the trace ID
      await runWithRequestContext(requestContext, async () => {
        logger.http.event("info", "request.start", { method: req.method, path: req.path });

        try {
          const { routeDef, handler, version } = this.resolveRequestHandler(routeSpec, routeKey, req);
          const context: Context = {
            req,
            res,
            permissions: this.routePermissions(routeDef.permissions),
            router: this,
            routeName: routeKey,
            routeVersion: version,
            rateLimiter: new RateLimiter(this.cache, routeDef.rateLimit),
            traceId,
            isBatchRequest,
          };
          const input = routeDef.parseBody(req.body) ?? {};
          await handler(input, context);

          const duration = Date.now() - requestContext.startTime;
          const statusCode = res.statusCode || 200;
          // Use eventAsync to ensure the log is written before the request context ends
          // This prevents race conditions where subsequent queries might not see this log
          await logger.http.eventAsync("info", "request.complete", {
            method: req.method,
            path: req.path,
            statusCode,
            durationMs: duration,
          });
        } catch (error) {
          const duration = Date.now() - requestContext.startTime;
          // Use eventAsync to ensure error log is written before context ends
          await logger.http.eventAsync("error", "request.error", {
            method: req.method,
            path: req.path,
            durationMs: duration,
            error: error instanceof Error ? error.message : String(error),
          });
          errorHandler(error, res, req);
        }
      });
    });
  }

  private getRequestVersion(req: Request): string | undefined {
    const header = req.headers[API_VERSION_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    const trimmed = typeof value === "string" ? value.trim() : undefined;
    return trimmed || undefined;
  }

  private getRegistrationRouteDefinition(
    routeSpec: AnyRouteDefinition,
    routeKey: string,
  ): RouteDefinition<any, any> {
    if (!isVersionedRouteDefinition(routeSpec)) {
      return routeSpec;
    }

    const defaultDef = routeSpec.versions[routeSpec.defaultVersion];
    for (const [version, def] of Object.entries(routeSpec.versions)) {
      if (def.path !== defaultDef.path || def.method !== defaultDef.method) {
        throw new Error(
          `Route ${routeKey} has mismatched path or method for version ${version}`,
        );
      }
    }
    return defaultDef;
  }

  private resolveRequestHandler(
    routeSpec: AnyRouteDefinition,
    routeKey: string,
    req: Request,
  ): { routeDef: RouteDefinition<any, any>; handler: RouteHandler; version?: string } {
    if (!isVersionedRouteDefinition(routeSpec)) {
      const handler = this.unversionedHandlers.get(routeKey);
      if (!handler) {
        throw new Error(`Route ${routeKey} not implemented`);
      }
      return { routeDef: routeSpec, handler };
    }

    const requestedVersion = this.getRequestVersion(req);
    const resolvedVersion = requestedVersion ?? String(routeSpec.defaultVersion);
    const routeDef = routeSpec.versions[resolvedVersion];

    if (!routeDef) {
      throw APIErrors.apiVersionDeprecated({
        route: routeKey,
        requestedVersion,
        availableVersions: Object.keys(routeSpec.versions),
      });
    }

    const handler = this.versionedHandlers.get(routeKey)?.get(resolvedVersion);
    if (!handler) {
      throw APIErrors.apiVersionDeprecated({
        route: routeKey,
        requestedVersion: resolvedVersion,
      });
    }

    return { routeDef, handler, version: resolvedVersion };
  }

  // // Expose method to check rate limit for use in handlers
  // async applyRateLimit<K extends keyof Routes>(
  //   routeName: K,
  //   req: Request,
  //   res: Response,
  //   username?: string,
  // ): Promise<boolean> {
  //   const routeDef = this.router.routes[routeName];
  //   if (!routeDef.rateLimit) {
  //     return true; // No rate limit configured, allow request
  //   }

  //   return this.checkRateLimit(routeDef, routeName as string, req, res, username);
  // }

  // private async checkRateLimit(
  //   routeDef: Routes[keyof Routes],
  //   routeName: string,
  //   req: Request,
  //   res: Response,
  //   username?: string,
  // ): Promise<boolean> {
  //   const config = routeDef.rateLimit!;
  //   const routeId = `${this.router.routeName}:${routeName}`;

  //   // Get or create rate limiter for this route
  //   if (!this.rateLimiterCache.has(routeId)) {
  //     const windowMs = parseTimeWindow(config.window || "1m");
  //     const keyGenerator = this.createKeyGenerator(config.keyStrategy || "ip", username);

  //     const rateLimiter = new CacheBasedRateLimit(this.cache, {
  //       windowMs,
  //       maxAttempts: config.maxAttempts || 400,
  //       keyGenerator,
  //       skipIf: config.skipAuthenticated
  //         ? (req) => {
  //             // Skip rate limiting if user is authenticated
  //             return !!req.headers.authorization;
  //           }
  //         : undefined,
  //     });

  //     this.rateLimiterCache.set(routeId, rateLimiter);
  //   }

  //   const rateLimiter = this.rateLimiterCache.get(routeId)!;
  //   const result = await rateLimiter.checkLimit(req);

  //   // Set standard rate limit headers
  //   res.set({
  //     "X-RateLimit-Limit": (config.maxAttempts || 400).toString(),
  //     "X-RateLimit-Remaining": result.remaining.toString(),
  //     "X-RateLimit-Reset": new Date(result.resetTime).toISOString(),
  //     "X-RateLimit-Window": config.window || "1m",
  //   });

  //   if (!result.allowed) {
  //     const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);

  //     console.log(
  //       CHALK.yellow(
  //         `[RATE_LIMIT] ${req.method} ${req.path} - Route: ${routeId} - Blocked - Attempts: ${result.count}/${config.maxAttempts || 400}`,
  //       ),
  //     );

  //     // Use the APIErrors format that frontend expects
  //     const rateLimitError = {
  //       type: "RATE_LIMIT_EXCEEDED",
  //       message: config.errorMessage || "Demasiados intentos. Inténtalo de nuevo más tarde.",
  //       details: {
  //         retryAfter: Math.max(1, retryAfter),
  //         route: routeId,
  //         attempts: result.count,
  //         limit: config.maxAttempts || 400,
  //         window: config.window || "1m",
  //         userIP: req.ip || "unknown",
  //         userAgent: req.headers["user-agent"] || "unknown",
  //       },
  //     };

  //     res.status(429).json(rateLimitError);
  //     return false;
  //   }

  //   // Log successful rate limit check (for monitoring)
  //   if (result.count > (config.maxAttempts || 400) * 0.8) {
  //     console.log(
  //       CHALK.cyan(
  //         `[RATE_LIMIT] ${req.method} ${req.path} - Route: ${routeId} - Warning: ${result.count}/${config.maxAttempts || 400} attempts`,
  //       ),
  //     );
  //   }

  //   return true;
  // }

  // protected handle<K extends keyof Routes>(
  //   route: K,
  //   impl: Routes[K]["RequestType"] extends Record<string, never>
  //     ? (context: Context) => Promise<Routes[K]["ResponseType"]>
  //     : (input: Routes[K]["RequestType"], context: Context) => Promise<Routes[K]["ResponseType"]>
  // ) {
  //   return (input: Routes[K]["RequestType"], context: Context) => {
  //     const result = Routes[K]["RequestType"] extends Record<string, never>
  //       ? (impl as (context: Context) => Promise<Routes[K]["ResponseType"]>)(context)
  //       : (impl as (input: Routes[K]["RequestType"], context: Context) => Promise<Routes[K]["ResponseType"]>)(
  //           input,
  //           context,
  //         );

  //     return result.then((response) => {
  //       context.res.json(response);
  //     });
  //   };
  // }

  // async post<K extends keyof Routes>(
  //   middleware: (
  // async post<K extends keyof Routes>(
  //   middleware: (
  //     request: MagikMiddleware<Routes[K]["RequestType"], Routes[K]["ResponseType"]>,
  //   ) => Promise<any[]>,
  // ) {
  //   const routeDef = this.router.routes[routeName];
  // }

  // async fullMiddleware<K extends keyof Routes>(
  //   middleware: (
  //     request: MagikMiddleware<Routes[K]["RequestType"], Routes[K]["ResponseType"]>,
  //   ) => Promise<any[]>,
  // ) {
  //   const routeDef = this.router.routes[routeName];
  // }

  //   async authHandler<K extends keyof Routes>(
  //     routeName: K,
  //     implementation: (
  //       request: Routes[K]["RequestType"],
  //       session: TokenPayload,
  //       cache: SimpleCache,
  //     ) => Promise<Routes[K]["ResponseType"]>,
  //   ): Promise<void> {
  //     const routeDef = this.router.routes[routeName];
  //     if (!routeDef) {
  //       throw new Error(`Route ${String(routeName)} not implemented`);
  //     }

  //     this.app[routeDef.method](routeDef.path, async (req, res) => {
  //       try {
  //         const token = req.headers.authorization?.split(" ")[1];
  //         const session = AuthModel.verifyToken(token ?? "");
  //         await Permissions.activeUser(session, this.db);
  //         Permissions.verify(this.routePermissions(routeDef.permissions), session);

  //         let result = routeDef.parseBody(req.body);
  //         let response = await implementation(result, session, this.cache);
  //         res.json(response);
  //       } catch (error) {
  //         errorHandler(error, res);
  //       }
  //     });
  //   }

  //   async publicHandler<K extends keyof Routes>(
  //     routeName: K,
  //     implementation: (
  //       request: Routes[K]["RequestType"],
  //       cache: SimpleCache,
  //     ) => Promise<Routes[K]["ResponseType"]>,
  //   ): Promise<void> {
  //     // console.log("publicHandler", routeName);
  //     const routeDef = this.router.routes[routeName];
  //     if (!routeDef) {
  //       throw new Error(`Route ${String(routeName)} not implemented`);
  //     }

  //     this.app[routeDef.method](routeDef.path, async (req, res) => {
  //       try {
  //         let result = routeDef.parseBody(req.body);
  //         let response = await implementation(result, this.cache);
  //         res.json(response);
  //       } catch (error) {
  //         errorHandler(error, res);
  //       }
  //     });
  //   }
}

export type MagikMiddleware<Input, Output> = {
  req: express.Request;
  res: express.Response;
  parseInput: (input: string) => Input;
  parseResponse: (response: Output) => string;
};
