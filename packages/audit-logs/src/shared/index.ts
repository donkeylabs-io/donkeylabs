// Shared types and constants for audit-logs package

export * from "./types";

// Export Logger for unified logging
// Users can import from '@pitsa/audit-logs' or '@pitsa/audit-logs/server'
export {
  Logger,
  TaggedLogger,
  type LoggerLevel,
  type LoggerOptions,
  type IAuditLogService,
  type AuditableLogLevel,
  type AuditLogEntry,
  type RequestContext,
  getRequestContext,
  runWithRequestContext,
  generateTraceId,
  logger,
} from "../logger";
