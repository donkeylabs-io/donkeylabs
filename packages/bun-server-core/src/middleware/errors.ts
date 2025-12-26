import { ApiError, getHttpStatus } from "@donkeylabs/core/src/errors";

import type { ApiErrorResponse } from "@donkeylabs/core/src/errors";

import { ErrorType } from "@donkeylabs/core/src/errors";
import type { Response, Request } from "express";
import { logger } from "@donkeylabs/audit-logs";

/**
 * Error context for audit logging
 */
export interface ErrorAuditContext {
  userId?: number;
  employeeId?: number;
  username?: string;
}

/**
 * Error details for audit logging
 */
export interface ErrorDetails {
  errorName: string;
  errorMessage: string;
  errorStack?: string;
  errorType?: string;
  errorDetails?: unknown;
  [key: string]: unknown;
}

/**
 * Callback for audit logging errors
 */
export type ErrorAuditCallback = (params: {
  level: "warn" | "error";
  event: string;
  method: string;
  path: string;
  statusCode: number;
  context: ErrorAuditContext;
  details: ErrorDetails;
}) => void;

// Global error audit callback - can be set by the application
let errorAuditCallback: ErrorAuditCallback | null = null;

/**
 * Set a global callback for error audit logging
 */
export function setErrorAuditCallback(callback: ErrorAuditCallback | null): void {
  errorAuditCallback = callback;
}

/**
 * Extract error details for audit logging
 */
function extractErrorDetails(err: Error | any): ErrorDetails {
  const details: ErrorDetails = {
    errorName: err instanceof Error ? err.name : "UnknownError",
    errorMessage: err instanceof Error ? err.message : String(err),
  };

  if (err instanceof Error) {
    details.errorStack = err.stack;
  }

  if (err instanceof ApiError) {
    details.errorType = err.type;
    details.errorDetails = err.details;
  }

  // Capture any additional properties on the error
  if (typeof err === "object" && err !== null) {
    for (const key of Object.keys(err)) {
      if (!["name", "message", "stack", "type", "details"].includes(key)) {
        try {
          details[`error_${key}`] = err[key];
        } catch {
          // Skip non-serializable properties
        }
      }
    }
  }

  return details;
}

export function errorHandler(err: Error | any, res: Response, request?: Request) {
  // Extract audit context from request if available
  const auditContext: ErrorAuditContext = (request as any)?.auditContext ?? {};

  if (err instanceof ApiError) {
    err.log();

    // Log known errors to audit callback if set
    if (errorAuditCallback && request) {
      errorAuditCallback({
        level: "warn",
        event: `error.${err.type}`,
        method: request.method,
        path: request.path,
        statusCode: getHttpStatus(err.type),
        context: auditContext,
        details: extractErrorDetails(err),
      });
    }

    return res.status(getHttpStatus(err.type)).json(err.toResponse());
  } else {
    if (request) {
      logger.server.error(`${request.method} ${request.url}`, err);
    } else {
      logger.server.error(err);
    }
  }

  // Handle unexpected errors
  // Only include stack traces in development to prevent exposing internal details
  const isDev = Bun.env.STAGE === "dev" || Bun.env.NODE_ENV === "development";
  const serverError: ApiErrorResponse = {
    type: ErrorType.INTERNAL_SERVER_ERROR,
    message: "Algo salió mal",
    ...(isDev ? { stack: (err as Error).stack } : {}),
  };

  // Log unexpected errors with full trace to audit callback if set
  if (errorAuditCallback && request) {
    errorAuditCallback({
      level: "error",
      event: "error.internal_server_error",
      method: request.method,
      path: request.path,
      statusCode: 500,
      context: auditContext,
      details: extractErrorDetails(err),
    });
  }

  res.status(500).json(serverError);
}
