import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuditLogService } from "./service";
import type { MiddlewareOptions, LogLevel } from "../shared/types";
import { generateTraceId, auditMetrics } from "../logger";

/**
 * Audit context stored on the request
 */
export interface AuditContext {
  userId?: number;
  companyId?: number;
  employeeId?: number;
  username?: string;
  traceId?: string;
}

/**
 * Extended request type with audit logging context
 */
export interface AuditRequest extends Request {
  auditContext?: AuditContext;
}

/**
 * Determine log level based on status code
 */
function getLogLevel(statusCode: number): LogLevel {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warn";
  return "info";
}

/**
 * Extract IP address from request, handling proxies
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return ips.trim();
  }
  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Create Express middleware for automatic request logging
 */
export function createAuditMiddleware(
  service: AuditLogService,
  options: MiddlewareOptions = {}
): RequestHandler {
  const {
    excludePaths = [],
    excludeMethods = ["OPTIONS"],
    extractContext,
  } = options;

  return (req: AuditRequest, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const method = req.method;
    const path = req.path;

    // Check exclusions
    if (excludeMethods.includes(method)) {
      return next();
    }
    if (excludePaths.some((p) => path.startsWith(p) || path === p)) {
      return next();
    }

    // Check if this is a batch sub-request (internal HTTP call from /api/batch)
    const isBatchSubRequest = req.headers["x-batch-request"] === "true";
    const batchTraceId = req.headers["x-batch-trace-id"] as string | undefined;

    // Use batch trace ID if provided, otherwise generate a new one
    // This ensures all sub-requests of a batch share the same trace ID
    const traceId = batchTraceId || generateTraceId();

    // Store trace ID in request for access in route handlers
    req.auditContext = {
      ...req.auditContext,
      traceId,
    };

    // Set trace ID header for response
    res.setHeader("X-Trace-Id", traceId);

    // Capture response
    const originalEnd = res.end.bind(res);
    let responseEnded = false;

    res.end = function (chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) {
      if (responseEnded) {
        // Avoid double-logging
        return originalEnd(chunk as string, encoding as BufferEncoding, callback);
      }
      responseEnded = true;

      const durationMs = Date.now() - startTime;
      const statusCode = res.statusCode;
      const level = getLogLevel(statusCode);

      // Extract context (from auth middleware or custom extractor)
      let context = req.auditContext ?? {};
      if (extractContext) {
        try {
          const extracted = extractContext(req);
          context = { ...context, ...extracted };
        } catch {
          // Ignore extraction errors
        }
      }

      // Log asynchronously to not block response
      setImmediate(() => {
        service.log({
          level,
          event: `api.${method}.${path}`,
          userId: context.userId,
          companyId: context.companyId,
          employeeId: context.employeeId,
          username: context.username,
          ipAddress: getClientIp(req),
          userAgent: req.headers["user-agent"],
          method,
          path,
          statusCode,
          durationMs,
          traceId,
          metadata: {
            query: Object.keys(req.query).length > 0 ? req.query : undefined,
            // Mark batch sub-requests so they can be identified in the trace
            isBatchSubRequest: isBatchSubRequest || undefined,
          },
        }).catch((err) => {
          // Log to console but don't crash - audit failures shouldn't break the app
          const errorMsg = err instanceof Error ? err.message : String(err);
          auditMetrics.recordFailure(errorMsg);
          console.error("[AuditLogs] Failed to persist log entry:", errorMsg);
        });
      });

      return originalEnd(chunk as string, encoding as BufferEncoding, callback);
    } as typeof res.end;

    next();
  };
}

/**
 * Options for logging with the request logger
 */
interface LogOptions {
  /** Structured metadata (JSON) */
  metadata?: Record<string, unknown>;
  /** Human-readable message */
  message?: string;
  /** Log level (default: "info") */
  level?: LogLevel;
}

/**
 * Create a manual logging helper that uses request context
 */
export function createRequestLogger(service: AuditLogService) {
  return {
    /**
     * Log an event with request context
     * @param req - The request object
     * @param event - Event name (e.g., "employee.search")
     * @param options - Log options (message, metadata, level)
     */
    log: (
      req: AuditRequest,
      event: string,
      options?: LogOptions | Record<string, unknown>,
      level?: LogLevel
    ) => {
      const context = req.auditContext ?? {};

      // Support both old API (metadata, level) and new API (options object)
      let metadata: Record<string, unknown> | undefined;
      let message: string | undefined;
      let logLevel: LogLevel = "info";

      if (options) {
        if ("message" in options && typeof options.message === "string") {
          // New API: options object with message
          metadata = (options as LogOptions).metadata;
          message = (options as LogOptions).message;
          logLevel = (options as LogOptions).level ?? "info";
        } else {
          // Old API: metadata object directly
          metadata = options as Record<string, unknown>;
          logLevel = level ?? "info";
        }
      }

      return service.log({
        level: logLevel,
        event,
        userId: context.userId,
        companyId: context.companyId,
        employeeId: context.employeeId,
        username: context.username,
        ipAddress: getClientIp(req),
        userAgent: req.headers["user-agent"],
        traceId: context.traceId,
        metadata,
        message,
      });
    },

    /**
     * Log security-related events
     */
    security: (
      req: AuditRequest,
      event: string,
      options?: { metadata?: Record<string, unknown>; message?: string } | Record<string, unknown>
    ) => {
      const context = req.auditContext ?? {};

      let metadata: Record<string, unknown> | undefined;
      let message: string | undefined;

      if (options) {
        if ("message" in options && typeof options.message === "string") {
          metadata = options.metadata as Record<string, unknown>;
          message = options.message;
        } else {
          metadata = options as Record<string, unknown>;
        }
      }

      return service.log({
        level: "security",
        event: `security.${event}`,
        userId: context.userId,
        companyId: context.companyId,
        employeeId: context.employeeId,
        username: context.username,
        ipAddress: getClientIp(req),
        userAgent: req.headers["user-agent"],
        traceId: context.traceId,
        metadata,
        message,
      });
    },

    /**
     * Log authentication events
     */
    auth: (
      req: AuditRequest,
      action: "login" | "logout" | "failed" | "token_refresh",
      options?: { metadata?: Record<string, unknown>; message?: string } | Record<string, unknown>
    ) => {
      const context = req.auditContext ?? {};

      let metadata: Record<string, unknown> | undefined;
      let message: string | undefined;

      if (options) {
        if ("message" in options && typeof options.message === "string") {
          metadata = options.metadata as Record<string, unknown>;
          message = options.message;
        } else {
          metadata = options as Record<string, unknown>;
        }
      }

      return service.log({
        level: action === "failed" ? "security" : "info",
        event: `auth.${action}`,
        userId: context.userId,
        companyId: context.companyId,
        employeeId: context.employeeId,
        username: context.username,
        ipAddress: getClientIp(req),
        userAgent: req.headers["user-agent"],
        traceId: context.traceId,
        metadata,
        message,
      });
    },
  };
}

/**
 * Middleware to set audit context from authenticated session
 */
export function setAuditContext(
  userId?: number,
  companyId?: number,
  employeeId?: number,
  username?: string
): RequestHandler {
  return (req: AuditRequest, _res: Response, next: NextFunction) => {
    req.auditContext = {
      ...req.auditContext,
      userId,
      companyId,
      employeeId,
      username,
    };
    next();
  };
}
