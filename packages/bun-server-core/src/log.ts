/**
 * Logger for bun-server-core
 *
 * Uses AsyncLocalStorage to automatically inherit request context (traceId, userId, etc.)
 * when used within a request handler - no explicit context passing needed.
 *
 * All loggers automatically use the global audit service when set via
 * Logger.setGlobalAuditService() in your API initialization.
 *
 * @example
 * ```ts
 * import { LOG } from "bun-server-core";
 *
 * // Tagged logging - trace ID is automatically included
 * LOG.tag("Order").info("Order created", { orderId: 123 });
 * LOG.tag("Auth").warn("Login failed", { userId: 456 });
 * LOG.tag("Security").security("unauthorized_access", { ip: "1.2.3.4" });
 * ```
 */
import { Logger, logger } from "@donkeylabs/audit-logs";

export const LOG = new Logger("bun-server-core");

// Re-export pre-configured loggers and Logger class for convenience
export { logger, Logger };
