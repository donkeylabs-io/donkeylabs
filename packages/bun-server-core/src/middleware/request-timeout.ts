/**
 * Request Timeout Middleware
 *
 * Ensures requests don't hang indefinitely by enforcing a maximum execution time.
 * When timeout is reached, responds with 504 Gateway Timeout.
 */

import type { Request, Response, NextFunction } from "express";
import { logger } from "@donkeylabs/audit-logs";

export interface RequestTimeoutOptions {
  /** Timeout in milliseconds (default: 30000 - 30 seconds) */
  timeout: number;
  /** Custom error message */
  message?: string;
  /** Callback when timeout occurs */
  onTimeout?: (req: Request, res: Response) => void;
}

const DEFAULT_OPTIONS: RequestTimeoutOptions = {
  timeout: 30000,
  message: "La solicitud tardó demasiado tiempo. Por favor, intenta de nuevo.",
};

/**
 * Create request timeout middleware
 */
export function requestTimeout(options: Partial<RequestTimeoutOptions> = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  return (req: Request, res: Response, next: NextFunction) => {
    // Skip if response already sent
    if (res.headersSent) {
      return next();
    }

    let timeoutTriggered = false;

    const timeoutId = setTimeout(() => {
      if (!res.headersSent) {
        timeoutTriggered = true;

        logger.server.tag("Timeout").warn(`${req.method} ${req.path} timed out after ${config.timeout}ms`);

        // Call custom handler if provided
        if (config.onTimeout) {
          config.onTimeout(req, res);
        }

        // Send timeout response
        res.status(504).json({
          type: "GATEWAY_TIMEOUT",
          message: config.message,
          details: {
            path: req.path,
            method: req.method,
            timeout: config.timeout,
          },
        });
      }
    }, config.timeout);

    // Helper to clear timeout - called once on any completion
    const cleanup = () => clearTimeout(timeoutId);

    // Use once() to auto-remove listeners after first call, preventing memory leaks
    res.once("finish", cleanup);
    res.once("close", cleanup);
    res.once("error", cleanup);

    // Track timeout state on request for handlers to check
    (req as any).isTimedOut = () => timeoutTriggered;

    next();
  };
}

/**
 * Route-specific timeout decorator
 * Use for routes that need different timeout than global
 */
export function withTimeout(timeoutMs: number) {
  return requestTimeout({ timeout: timeoutMs });
}

/**
 * Check if request has timed out (useful in async handlers)
 */
export function isRequestTimedOut(req: Request): boolean {
  return typeof (req as any).isTimedOut === "function" && (req as any).isTimedOut();
}
