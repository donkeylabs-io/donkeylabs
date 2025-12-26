// Server SDK exports for @pitsa/audit-logs/server

export { AuditLogSystem } from "./system";
export { AuditLogService } from "./service";
export { WebSocketHub, type ConnectionData, type WebSocketHubOptions } from "./hub";
export { Redactor, defaultRedactor } from "./redactor";
export {
  createAuditMiddleware,
  createRequestLogger,
  setAuditContext,
  type AuditRequest,
} from "./middleware";
export type { AuditLogDB, LogEntryRow, NewLogEntry } from "./db";

// Re-export shared types for convenience
export * from "../shared/types";

// Export Logger for unified logging (excluding LogLevel which is already exported from shared/types)
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
	auditMetrics,
} from "../logger";
