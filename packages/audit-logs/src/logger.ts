import { Chalk } from "chalk";
import { AsyncLocalStorage } from "async_hooks";
import type { LogEntryInput, LogLevel } from "./shared/types";

// Re-export for convenience (users can import from logger)
export type { LogLevel };

// Extended log levels for Logger (includes "silent" which is not persisted)
export type LoggerLevel = LogLevel | "silent";

const LOG_LEVELS: Record<LoggerLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	security: 4,
	silent: 5,
};

const CHALK = new Chalk({ level: 3 });

// ============================================================================
// Audit Metrics - Track failures for monitoring
// ============================================================================

/**
 * Simple metrics for tracking audit log failures
 * Can be exported for external monitoring systems
 */
export const auditMetrics = {
  /** Total number of audit log persistence failures */
  failureCount: 0,
  /** Timestamp of the last failure */
  lastFailureAt: null as number | null,
  /** Last error message */
  lastError: null as string | null,

  /** Record a failure */
  recordFailure(error: string): void {
    this.failureCount++;
    this.lastFailureAt = Date.now();
    this.lastError = error;
  },

  /** Reset metrics (useful for testing) */
  reset(): void {
    this.failureCount = 0;
    this.lastFailureAt = null;
    this.lastError = null;
  },

  /** Get current metrics snapshot */
  getSnapshot(): { failureCount: number; lastFailureAt: number | null; lastError: string | null } {
    return {
      failureCount: this.failureCount,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
    };
  },
};

// Level formatting with background colors (like HTTP status codes)
const formatLevel = (level: LoggerLevel): string => {
	switch (level) {
		case "debug":
			return CHALK.bgGray.white.bold(" DEBUG ");
		case "info":
			return CHALK.bgBlue.white.bold(" INFO  ");
		case "warn":
			return CHALK.bgYellow.black.bold(" WARN  ");
		case "error":
			return CHALK.bgRed.white.bold(" ERROR ");
		case "security":
			return CHALK.bgMagenta.white.bold(" SECURITY ");
		default:
			return CHALK.bgGray.white.bold(` ${level.toUpperCase()} `);
	}
};

// Prefix colors per category
const PREFIX_COLORS: Record<string, (s: string) => string> = {
	Server: CHALK.magenta,
	DB: CHALK.cyan,
	Cache: CHALK.blue,
	Auth: CHALK.yellow,
	HTTP: CHALK.green,
	Cron: CHALK.gray,
	Twilio: CHALK.red,
	ExtAPI: CHALK.blue,
	User: CHALK.yellow,
	Call: CHALK.green,
};

// ============================================================================
// Request Context (AsyncLocalStorage)
// ============================================================================

/**
 * Request context stored in AsyncLocalStorage
 * Available to all code running within a request
 */
export interface RequestContext {
	traceId: string;
	userId?: number;
	employeeId?: number;
	username?: string;
	companyId?: number;
	method?: string;
	path?: string;
	startTime: number;
	/** True if this is a batch sub-request (internal HTTP call from /api/batch) */
	isBatchSubRequest?: boolean;
	/** Client IP address */
	ipAddress?: string;
	/** User agent string */
	userAgent?: string;
	/** Geo location - country code (e.g., "US", "MX") */
	geoCountry?: string;
	/** Geo location - city name */
	geoCity?: string;
	/** Geo location - region/state */
	geoRegion?: string;
}

// AsyncLocalStorage for request-scoped context
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context (if any)
 */
export function getRequestContext(): RequestContext | undefined {
	return requestContextStorage.getStore();
}

/**
 * Run a function with request context
 * All logs within this function will be associated with the trace
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
	return requestContextStorage.run(context, fn);
}

/**
 * Generate a trace ID
 */
export function generateTraceId(): string {
	return `trace_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}

// ============================================================================
// Audit Service Interface
// ============================================================================

/**
 * Log levels that can be sent to audit
 * (excludes "debug" and "silent" which are not persisted)
 */
export type AuditableLogLevel = "info" | "warn" | "error" | "security";

/**
 * Audit log entry for persistence
 */
export interface AuditLogEntry {
	level: AuditableLogLevel;
	event: string;
	message: string;
	traceId?: string;
	userId?: number;
	employeeId?: number;
	username?: string;
	companyId?: number;
	method?: string;
	path?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Interface for audit log persistence
 * Implemented by AuditLogService - keeps Logger decoupled from concrete implementation
 */
export interface IAuditLogService {
	log(input: LogEntryInput): Promise<string>;
}

/**
 * Logger configuration options
 */
export interface LoggerOptions {
	/**
	 * Optional audit service for persisting logs
	 * When provided, warn/error/security logs are automatically persisted
	 */
	auditService?: IAuditLogService;
}

/**
 * Tagged logger - provides logging methods with a specific tag/prefix
 * Created via Logger.tag() for fluent API
 * Supports chaining multiple tags: LOG.tag("Auth").tag("Login").warn(...)
 */
export class TaggedLogger {
	private tags: string[];

	constructor(
		private logger: Logger,
		tagName: string,
		parentTags: string[] = [],
	) {
		this.tags = [...parentTags, tagName];
	}

	/**
	 * Add another tag (chainable)
	 * @example LOG.tag("Auth").tag("Login").warn("Failed attempt")
	 */
	tag(name: string): TaggedLogger {
		return new TaggedLogger(this.logger, name, this.tags);
	}

	private get primaryTag(): string {
		return this.tags[this.tags.length - 1];
	}

	private get colorFn(): (s: string) => string {
		return PREFIX_COLORS[this.primaryTag] ?? CHALK.white;
	}

	private formatPrefix(): string {
		// Multiple tags: [Auth][Login] or single tag: [Auth]
		return this.tags.map((t) => (PREFIX_COLORS[t] ?? CHALK.white)(`[${t}]`)).join("");
	}

	private get eventPrefix(): string {
		// For audit events: auth.login or just auth
		return this.tags.map((t) => t.toLowerCase()).join(".");
	}

	private timestamp(): string {
		return CHALK.dim(new Date().toISOString().split("T")[1].slice(0, 12));
	}

	private formatTraceId(): string {
		const ctx = getRequestContext();
		if (ctx?.traceId) {
			return CHALK.dim(`[${ctx.traceId.slice(0, 16)}]`);
		}
		return "";
	}

	private shouldLog(level: LoggerLevel): boolean {
		return Logger.shouldLogLevel(level);
	}

	private sendToAudit(level: AuditableLogLevel, message: string, metadata?: Record<string, unknown>): void {
		// Fire-and-forget - use sendToAuditAsync if you need to await
		this.sendToAuditAsync(level, message, metadata).catch(() => {});
	}

	private async sendToAuditAsync(level: AuditableLogLevel, message: string, metadata?: Record<string, unknown>): Promise<void> {
		const auditService = this.logger.getAuditService();
		if (!auditService) {
			if (Bun.env.DEBUG_AUDIT === "true") {
				console.log("[AuditLogs DEBUG] No audit service - skipping", { level, message: message.slice(0, 50) });
			}
			return;
		}

		const ctx = getRequestContext();
		if (Bun.env.DEBUG_AUDIT === "true") {
			console.log("[AuditLogs DEBUG] sendToAudit:", { level, hasContext: !!ctx, traceId: ctx?.traceId?.slice(0, 16), message: message.slice(0, 50) });
		}
		if (level === "security" || ((level === "info" || level === "warn" || level === "error") && ctx)) {
			// Include request context fields in metadata for application-specific tracking
			const enrichedMetadata = {
				...metadata,
				...(ctx?.ipAddress && { ipAddress: ctx.ipAddress }),
				...(ctx?.userAgent && { userAgent: ctx.userAgent }),
				...(ctx?.geoCountry && { geoCountry: ctx.geoCountry }),
				...(ctx?.geoCity && { geoCity: ctx.geoCity }),
				...(ctx?.geoRegion && { geoRegion: ctx.geoRegion }),
			};
			try {
				await auditService.log({
					level,
					event: `log.${this.eventPrefix}.${level}`,
					message,
					traceId: ctx?.traceId,
					userId: ctx?.userId,
					employeeId: ctx?.employeeId,
					username: ctx?.username,
					companyId: ctx?.companyId,
					method: ctx?.method,
					path: ctx?.path,
					metadata: Object.keys(enrichedMetadata).length > 0 ? enrichedMetadata : undefined,
				});
			} catch (err) {
				// Log to console but don't crash - audit failures shouldn't break the app
				const errorMsg = err instanceof Error ? err.message : String(err);
				auditMetrics.recordFailure(errorMsg);
				console.error("[AuditLogs] Failed to persist log entry:", errorMsg);
			}
		}
	}

	private extractErrorMetadata(args: unknown[]): Record<string, unknown> | undefined {
		for (const arg of args) {
			if (arg instanceof Error) {
				return {
					errorName: arg.name,
					errorMessage: arg.message,
					errorStack: arg.stack,
				};
			}
		}
		return undefined;
	}

	private formatArgs(args: unknown[]): unknown[] {
		return args.map((arg) => {
			if (typeof arg === "string") return arg;
			if (typeof arg === "number") return CHALK.yellow(String(arg));
			if (typeof arg === "boolean") return CHALK.cyan(String(arg));
			if (arg instanceof Error) return CHALK.red(arg.stack ?? arg.message);
			if (typeof arg === "object" && arg !== null) return arg;
			return arg;
		});
	}

	debug(...args: unknown[]): void {
		if (!this.shouldLog("debug")) return;
		console.debug(this.timestamp(), formatLevel("debug"), this.formatPrefix(), this.formatTraceId(), ...this.formatArgs(args));
	}

	info(...args: unknown[]): void {
		// Fire-and-forget - use infoAsync if you need to await
		this.infoAsync(...args).catch(() => {});
	}

	/**
	 * Async version of info() that can be awaited
	 * Use this when you need to ensure the log is written before continuing
	 */
	async infoAsync(...args: unknown[]): Promise<void> {
		// Console logging is controlled by log level
		if (this.shouldLog("info")) {
			console.info(this.timestamp(), formatLevel("info"), this.formatPrefix(), this.formatTraceId(), ...this.formatArgs(args));
		}
		// Audit logging always happens (if audit service is connected and we have context)
		const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
		await this.sendToAuditAsync("info", message);
	}

	warn(...args: unknown[]): void {
		// Fire-and-forget - use warnAsync if you need to await
		this.warnAsync(...args).catch(() => {});
	}

	/**
	 * Async version of warn() that can be awaited
	 * Use this when you need to ensure the log is written before continuing
	 */
	async warnAsync(...args: unknown[]): Promise<void> {
		if (this.shouldLog("warn")) {
			console.warn(this.timestamp(), formatLevel("warn"), this.formatPrefix(), this.formatTraceId(), ...this.formatArgs(args));
		}
		const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
		await this.sendToAuditAsync("warn", message, this.extractErrorMetadata(args));
	}

	error(...args: unknown[]): void {
		// Fire-and-forget - use errorAsync if you need to await
		this.errorAsync(...args).catch(() => {});
	}

	/**
	 * Async version of error() that can be awaited
	 * Use this when you need to ensure the log is written before continuing
	 */
	async errorAsync(...args: unknown[]): Promise<void> {
		if (this.shouldLog("error")) {
			console.error(this.timestamp(), formatLevel("error"), this.formatPrefix(), this.formatTraceId(), ...this.formatArgs(args));
		}
		const message = args.map((a) => (typeof a === "string" ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(" ");
		await this.sendToAuditAsync("error", message, this.extractErrorMetadata(args));
	}

	security(event: string, metadata?: Record<string, unknown>): void {
		console.warn(this.timestamp(), formatLevel("security"), this.formatPrefix(), this.formatTraceId(), event, metadata ?? "");
		const auditService = this.logger.getAuditService();
		if (auditService) {
			const ctx = getRequestContext();
			// Include request context fields in metadata for application-specific tracking
			const enrichedMetadata = {
				...metadata,
				...(ctx?.ipAddress && { ipAddress: ctx.ipAddress }),
				...(ctx?.userAgent && { userAgent: ctx.userAgent }),
				...(ctx?.geoCountry && { geoCountry: ctx.geoCountry }),
				...(ctx?.geoCity && { geoCity: ctx.geoCity }),
				...(ctx?.geoRegion && { geoRegion: ctx.geoRegion }),
			};
			auditService.log({
				level: "security",
				event: `security.${this.eventPrefix}.${event}`,
				message: event,
				traceId: ctx?.traceId,
				userId: ctx?.userId,
				employeeId: ctx?.employeeId,
				username: ctx?.username,
				companyId: ctx?.companyId,
				method: ctx?.method,
				path: ctx?.path,
				metadata: Object.keys(enrichedMetadata).length > 0 ? enrichedMetadata : undefined,
			}).catch((err) => {
				const errorMsg = err instanceof Error ? err.message : String(err);
					auditMetrics.recordFailure(errorMsg);
					console.error("[AuditLogs] Failed to persist log entry:", errorMsg);
			});
		}
	}

	success(...args: unknown[]): void {
		if (!this.shouldLog("info")) return;
		const tag = CHALK.bgGreen.white.bold(" OK ");
		console.log(this.timestamp(), tag, this.formatPrefix(), this.formatTraceId(), ...this.formatArgs(args));
	}

	event(level: AuditableLogLevel, eventName: string, metadata?: Record<string, unknown>): void {
		// Fire-and-forget version - use eventAsync if you need to await
		this.eventAsync(level, eventName, metadata).catch(() => {});
	}

	/**
	 * Async version of event() that can be awaited
	 * Use this when you need to ensure the log is written before continuing
	 * (e.g., for request.complete logs to avoid race conditions)
	 */
	async eventAsync(level: AuditableLogLevel, eventName: string, metadata?: Record<string, unknown>): Promise<void> {
		// Console output is controlled by log level
		if (this.shouldLog(level)) {
			const eventTag = CHALK.cyan(`[${eventName}]`);
			if (metadata && Object.keys(metadata).length > 0) {
				console.log(this.timestamp(), formatLevel(level), this.formatPrefix(), this.formatTraceId(), eventTag, metadata);
			} else {
				console.log(this.timestamp(), formatLevel(level), this.formatPrefix(), this.formatTraceId(), eventTag);
			}
		}
		// Audit logging happens regardless of console log level
		const auditService = this.logger.getAuditService();
		if (auditService) {
			const ctx = getRequestContext();
			if (level === "security" || ctx) {
				// Extract statusCode and durationMs from metadata as top-level fields
				// These are stored in dedicated database columns for efficient querying
				const statusCode = metadata?.statusCode as number | undefined;
				const durationMs = metadata?.durationMs as number | undefined;

				// Include request context fields in metadata for application-specific tracking
				// Remove statusCode/durationMs from metadata since they're now top-level
				const { statusCode: _sc, durationMs: _dm, ...restMetadata } = metadata ?? {};
				const enrichedMetadata = {
					...restMetadata,
					...(ctx?.ipAddress && { ipAddress: ctx.ipAddress }),
					...(ctx?.userAgent && { userAgent: ctx.userAgent }),
					...(ctx?.geoCountry && { geoCountry: ctx.geoCountry }),
					...(ctx?.geoCity && { geoCity: ctx.geoCity }),
					...(ctx?.geoRegion && { geoRegion: ctx.geoRegion }),
				};
				try {
					await auditService.log({
						level,
						event: `${this.eventPrefix}.${eventName}`,
						message: eventName,
						traceId: ctx?.traceId,
						userId: ctx?.userId,
						employeeId: ctx?.employeeId,
						username: ctx?.username,
						companyId: ctx?.companyId,
						method: ctx?.method,
						path: ctx?.path,
						statusCode,
						durationMs,
						metadata: Object.keys(enrichedMetadata).length > 0 ? enrichedMetadata : undefined,
					});
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					auditMetrics.recordFailure(errorMsg);
					console.error("[AuditLogs] Failed to persist log entry:", errorMsg);
				}
			}
		}
	}
}

// ============================================================================
// Logger Class
// ============================================================================

/**
 * Unified logger with trace context and audit integration
 *
 * Features:
 * - Fluent API with tag() for specifying context at call time
 * - Automatic trace ID inclusion when in request context
 * - Audit log persistence for warn/error/security levels (when connected)
 * - Environment-based log level control
 * - Pretty console output with colors
 *
 * @example
 * ```ts
 * // Create a single logger instance
 * const LOG = new Logger({ auditService: auditSystem.service });
 *
 * // Use tag() to specify context at call time
 * LOG.tag("Auth").warn("Login failed", { userId: 123 });
 * LOG.tag("DB").info("Query executed", { duration: 45 });
 * LOG.tag("Cache").debug("Cache hit");
 *
 * // Or use the legacy prefix-based constructor for backward compatibility
 * const authLog = new Logger("Auth", { auditService });
 * authLog.warn("Login failed");
 * ```
 */
export class Logger {
	private prefix: string;
	private colorFn: (s: string) => string;
	private auditService?: IAuditLogService;
	private static globalLevel: LoggerLevel | null = null;
	private static globalAuditService?: IAuditLogService;
	private tagCache: Map<string, TaggedLogger> = new Map();

	/**
	 * Create a new Logger instance
	 *
	 * @param prefixOrOptions - Either a string prefix (legacy) or LoggerOptions
	 * @param options - Optional LoggerOptions when using prefix
	 */
	constructor(prefixOrOptions?: string | LoggerOptions, options?: LoggerOptions) {
		if (typeof prefixOrOptions === "string") {
			// Legacy: new Logger("Auth", { auditService })
			this.prefix = prefixOrOptions;
			this.auditService = options?.auditService;
		} else {
			// New: new Logger({ auditService })
			this.prefix = "";
			this.auditService = prefixOrOptions?.auditService;
		}
		this.colorFn = PREFIX_COLORS[this.prefix] ?? CHALK.white;
	}

	/**
	 * Get a tagged logger for fluent API
	 * Tags are cached for performance
	 *
	 * @example
	 * ```ts
	 * LOG.tag("Auth").warn("Login failed");
	 * LOG.tag("DB").info("Query executed");
	 * ```
	 */
	tag(name: string): TaggedLogger {
		let tagged = this.tagCache.get(name);
		if (!tagged) {
			tagged = new TaggedLogger(this, name);
			this.tagCache.set(name, tagged);
		}
		return tagged;
	}

	/**
	 * Connect this logger to an audit service for log persistence
	 *
	 * @example
	 * ```ts
	 * const LOG = new Logger();
	 * LOG.connectAudit(auditSystem.service);
	 * LOG.tag("Auth").warn("Now persisted to audit");
	 * ```
	 */
	connectAudit(auditService: IAuditLogService): void {
		this.auditService = auditService;
	}

	/**
	 * Disconnect this logger from audit service
	 */
	disconnectAudit(): void {
		this.auditService = undefined;
	}

	/**
	 * Check if this logger is connected to an audit service
	 * (either instance-specific or global)
	 */
	get isAuditConnected(): boolean {
		return this.auditService !== undefined || Logger.globalAuditService !== undefined;
	}

	/**
	 * Get the audit service (used by TaggedLogger)
	 * Falls back to global audit service if no instance-specific service is set
	 * @internal
	 */
	getAuditService(): IAuditLogService | undefined {
		return this.auditService ?? Logger.globalAuditService;
	}

	/**
	 * Check if a level should be logged (used by TaggedLogger)
	 * @internal
	 */
	static shouldLogLevel(level: LoggerLevel): boolean {
		return LOG_LEVELS[level] >= LOG_LEVELS[Logger.getLevel()];
	}

	private static getLevel(): LoggerLevel {
		if (Logger.globalLevel !== null) {
			return Logger.globalLevel;
		}

		const envLevel = Bun.env.LOG_LEVEL?.toLowerCase() as LoggerLevel | undefined;
		if (envLevel && envLevel in LOG_LEVELS) {
			return envLevel;
		}

		if (Bun.env.NODE_ENV === "test") {
			return "silent";
		}

		return "info";
	}

	private shouldLog(level: LoggerLevel): boolean {
		return LOG_LEVELS[level] >= LOG_LEVELS[Logger.getLevel()];
	}

	private formatPrefix(): string {
		return this.colorFn(`[${this.prefix}]`);
	}

	private timestamp(): string {
		return CHALK.dim(new Date().toISOString().split("T")[1].slice(0, 12));
	}

	private formatTraceId(): string {
		const ctx = getRequestContext();
		if (ctx?.traceId) {
			return CHALK.dim(`[${ctx.traceId.slice(0, 16)}]`);
		}
		return "";
	}

	/**
	 * Send log to audit system if appropriate (fire-and-forget)
	 */
	private sendToAudit(level: AuditableLogLevel, message: string, metadata?: Record<string, unknown>): void {
		// Fire-and-forget - use sendToAuditAsync if you need to await
		this.sendToAuditAsync(level, message, metadata).catch(() => {});
	}

	/**
	 * Send log to audit system if appropriate (awaitable)
	 */
	private async sendToAuditAsync(level: AuditableLogLevel, message: string, metadata?: Record<string, unknown>): Promise<void> {
		const auditService = this.getAuditService();
		if (!auditService) {
			if (Bun.env.DEBUG_AUDIT === "true") {
				console.log("[AuditLogs DEBUG] Logger.sendToAudit: No audit service", { level, message: message.slice(0, 50) });
			}
			return;
		}

		const ctx = getRequestContext();
		if (Bun.env.DEBUG_AUDIT === "true") {
			console.log("[AuditLogs DEBUG] Logger.sendToAudit:", { level, hasContext: !!ctx, traceId: ctx?.traceId?.slice(0, 16), message: message.slice(0, 50) });
		}

		// Always log security, and log info/warn/error when we have request context
		// Batch sub-requests are logged with the batch trace ID so they appear grouped
		if (level === "security" || ((level === "info" || level === "warn" || level === "error") && ctx)) {
			// Include request context fields in metadata for application-specific tracking
			const enrichedMetadata = {
				...metadata,
				...(ctx?.ipAddress && { ipAddress: ctx.ipAddress }),
				...(ctx?.userAgent && { userAgent: ctx.userAgent }),
				...(ctx?.geoCountry && { geoCountry: ctx.geoCountry }),
				...(ctx?.geoCity && { geoCity: ctx.geoCity }),
				...(ctx?.geoRegion && { geoRegion: ctx.geoRegion }),
			};
			try {
				await auditService.log({
					level,
					event: `log.${this.prefix.toLowerCase()}.${level}`,
					message,
					traceId: ctx?.traceId,
					userId: ctx?.userId,
					employeeId: ctx?.employeeId,
					username: ctx?.username,
					companyId: ctx?.companyId,
					method: ctx?.method,
					path: ctx?.path,
					metadata: Object.keys(enrichedMetadata).length > 0 ? enrichedMetadata : undefined,
				});
			} catch (err) {
				// Log to console but don't crash - audit failures shouldn't break the app
				const errorMsg = err instanceof Error ? err.message : String(err);
				auditMetrics.recordFailure(errorMsg);
				console.error("[AuditLogs] Failed to persist log entry:", errorMsg);
			}
		}
	}

	/**
	 * Extract error details from an Error object
	 */
	private extractErrorMetadata(args: unknown[]): Record<string, unknown> | undefined {
		for (const arg of args) {
			if (arg instanceof Error) {
				return {
					errorName: arg.name,
					errorMessage: arg.message,
					errorStack: arg.stack,
				};
			}
		}
		return undefined;
	}

	debug(...args: unknown[]): void {
		if (!this.shouldLog("debug")) return;
		const traceStr = this.formatTraceId();
		console.debug(this.timestamp(), formatLevel("debug"), this.formatPrefix(), traceStr, ...this.formatArgs(args));
	}

	info(...args: unknown[]): void {
		// Fire-and-forget - use infoAsync if you need to await
		this.infoAsync(...args).catch(() => {});
	}

	/**
	 * Async version of info() that can be awaited
	 * Use this when you need to ensure the log is written before continuing
	 */
	async infoAsync(...args: unknown[]): Promise<void> {
		// Console logging is controlled by log level
		if (this.shouldLog("info")) {
			const traceStr = this.formatTraceId();
			console.info(this.timestamp(), formatLevel("info"), this.formatPrefix(), traceStr, ...this.formatArgs(args));
		}
		// Audit logging always happens (if audit service is connected and we have context)
		const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
		await this.sendToAuditAsync("info", message);
	}

	warn(...args: unknown[]): void {
		// Fire-and-forget - use warnAsync if you need to await
		this.warnAsync(...args).catch(() => {});
	}

	/**
	 * Async version of warn() that can be awaited
	 * Use this when you need to ensure the log is written before continuing
	 */
	async warnAsync(...args: unknown[]): Promise<void> {
		if (this.shouldLog("warn")) {
			const traceStr = this.formatTraceId();
			console.warn(this.timestamp(), formatLevel("warn"), this.formatPrefix(), traceStr, ...this.formatArgs(args));
		}
		const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
		await this.sendToAuditAsync("warn", message, this.extractErrorMetadata(args));
	}

	error(...args: unknown[]): void {
		// Fire-and-forget - use errorAsync if you need to await
		this.errorAsync(...args).catch(() => {});
	}

	/**
	 * Async version of error() that can be awaited
	 * Use this when you need to ensure the log is written before continuing
	 */
	async errorAsync(...args: unknown[]): Promise<void> {
		if (this.shouldLog("error")) {
			const traceStr = this.formatTraceId();
			console.error(this.timestamp(), formatLevel("error"), this.formatPrefix(), traceStr, ...this.formatArgs(args));
		}
		const message = args.map((a) => (typeof a === "string" ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(" ");
		await this.sendToAuditAsync("error", message, this.extractErrorMetadata(args));
	}

	/**
	 * Log a security event - ALWAYS sent to audit regardless of context
	 */
	security(event: string, metadata?: Record<string, unknown>): void {
		const traceStr = this.formatTraceId();
		console.warn(this.timestamp(), formatLevel("security"), this.formatPrefix(), traceStr, event, metadata ?? "");

		// Always send security events to audit
		const auditService = this.getAuditService();
		if (auditService) {
			const ctx = getRequestContext();
			// Include request context fields in metadata for application-specific tracking
			const enrichedMetadata = {
				...metadata,
				...(ctx?.ipAddress && { ipAddress: ctx.ipAddress }),
				...(ctx?.userAgent && { userAgent: ctx.userAgent }),
				...(ctx?.geoCountry && { geoCountry: ctx.geoCountry }),
				...(ctx?.geoCity && { geoCity: ctx.geoCity }),
				...(ctx?.geoRegion && { geoRegion: ctx.geoRegion }),
			};
			auditService.log({
				level: "security",
				event: `security.${this.prefix.toLowerCase()}.${event}`,
				message: event,
				traceId: ctx?.traceId,
				userId: ctx?.userId,
				employeeId: ctx?.employeeId,
				username: ctx?.username,
				companyId: ctx?.companyId,
				method: ctx?.method,
				path: ctx?.path,
				metadata: Object.keys(enrichedMetadata).length > 0 ? enrichedMetadata : undefined,
			}).catch((err) => {
				const errorMsg = err instanceof Error ? err.message : String(err);
					auditMetrics.recordFailure(errorMsg);
					console.error("[AuditLogs] Failed to persist log entry:", errorMsg);
			});
		}
	}

	/** Log a success message */
	success(...args: unknown[]): void {
		if (!this.shouldLog("info")) return;
		const tag = CHALK.bgGreen.white.bold(" OK ");
		const traceStr = this.formatTraceId();
		console.log(this.timestamp(), tag, this.formatPrefix(), traceStr, ...this.formatArgs(args));
	}

	/**
	 * Log a structured event with custom event name
	 * Use this for important events that should be easily filterable in audit logs
	 *
	 * @example
	 * log.event("info", "request.start", { method: "GET", path: "/users" });
	 * log.event("warn", "rate_limit.exceeded", { ip: "1.2.3.4", limit: 100 });
	 */
	event(level: AuditableLogLevel, eventName: string, metadata?: Record<string, unknown>): void {
		// Fire-and-forget version - use eventAsync if you need to await
		this.eventAsync(level, eventName, metadata).catch(() => {});
	}

	/**
	 * Async version of event() that can be awaited
	 * Use this when you need to ensure the log is written before continuing
	 * (e.g., for request.complete logs to avoid race conditions)
	 *
	 * @example
	 * await log.eventAsync("info", "request.complete", { statusCode: 200, durationMs: 15 });
	 */
	async eventAsync(level: AuditableLogLevel, eventName: string, metadata?: Record<string, unknown>): Promise<void> {
		// Console output is controlled by log level
		if (this.shouldLog(level)) {
			const traceStr = this.formatTraceId();
			const formattedLevel = formatLevel(level);
			const eventTag = CHALK.cyan(`[${eventName}]`);

			if (metadata && Object.keys(metadata).length > 0) {
				console.log(this.timestamp(), formattedLevel, this.formatPrefix(), traceStr, eventTag, metadata);
			} else {
				console.log(this.timestamp(), formattedLevel, this.formatPrefix(), traceStr, eventTag);
			}
		}

		// Send to audit with the custom event name (always, regardless of console log level)
		// Batch sub-requests are logged with the batch trace ID so they appear grouped
		const auditService = this.getAuditService();
		if (auditService) {
			const ctx = getRequestContext();
			if (level === "security" || ctx) {
				// Extract statusCode and durationMs from metadata as top-level fields
				// These are stored in dedicated database columns for efficient querying
				const statusCode = metadata?.statusCode as number | undefined;
				const durationMs = metadata?.durationMs as number | undefined;

				// Include request context fields in metadata for application-specific tracking
				// Remove statusCode/durationMs from metadata since they're now top-level
				const { statusCode: _sc, durationMs: _dm, ...restMetadata } = metadata ?? {};
				const enrichedMetadata = {
					...restMetadata,
					...(ctx?.ipAddress && { ipAddress: ctx.ipAddress }),
					...(ctx?.userAgent && { userAgent: ctx.userAgent }),
					...(ctx?.geoCountry && { geoCountry: ctx.geoCountry }),
					...(ctx?.geoCity && { geoCity: ctx.geoCity }),
					...(ctx?.geoRegion && { geoRegion: ctx.geoRegion }),
				};
				try {
					await auditService.log({
						level,
						event: `${this.prefix.toLowerCase()}.${eventName}`,
						message: eventName,
						traceId: ctx?.traceId,
						userId: ctx?.userId,
						employeeId: ctx?.employeeId,
						username: ctx?.username,
						companyId: ctx?.companyId,
						method: ctx?.method,
						path: ctx?.path,
						statusCode,
						durationMs,
						metadata: Object.keys(enrichedMetadata).length > 0 ? enrichedMetadata : undefined,
					});
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					auditMetrics.recordFailure(errorMsg);
					console.error("[AuditLogs] Failed to persist log entry:", errorMsg);
				}
			}
		}
	}

	/** Format args - colorize strings, pretty-print objects */
	private formatArgs(args: unknown[]): unknown[] {
		return args.map((arg) => {
			if (typeof arg === "string") return arg;
			if (typeof arg === "number") return CHALK.yellow(String(arg));
			if (typeof arg === "boolean") return CHALK.cyan(String(arg));
			if (arg instanceof Error) return CHALK.red(arg.stack ?? arg.message);
			if (typeof arg === "object" && arg !== null) {
				return arg; // Let console handle object formatting
			}
			return arg;
		});
	}

	/**
	 * Globally set log level (useful for tests)
	 * @example Logger.setLevel("silent") // disable all logs
	 * @example Logger.setLevel("debug") // enable all logs
	 * @example Logger.setLevel(null) // reset to environment default
	 */
	static setLevel(level: LoggerLevel | null): void {
		Logger.globalLevel = level;
	}

	/** Get current effective log level */
	static getEffectiveLevel(): LoggerLevel {
		return Logger.getLevel();
	}

	/**
	 * Run a function with logs disabled, then restore previous level
	 * @example await Logger.silent(() => runNoisyCode())
	 */
	static async silent<T>(fn: () => T | Promise<T>): Promise<T> {
		const prev = Logger.globalLevel;
		Logger.globalLevel = "silent";
		try {
			return await fn();
		} finally {
			Logger.globalLevel = prev;
		}
	}

	/**
	 * Run a function with specific log level, then restore previous level
	 * @example await Logger.withLevel("debug", () => runCode())
	 */
	static async withLevel<T>(level: LoggerLevel, fn: () => T | Promise<T>): Promise<T> {
		const prev = Logger.globalLevel;
		Logger.globalLevel = level;
		try {
			return await fn();
		} finally {
			Logger.globalLevel = prev;
		}
	}

	/**
	 * Set a global audit service that ALL Logger instances will use by default.
	 * This is the recommended way to enable audit logging across your entire application,
	 * including any `new Logger("...")` instances created anywhere in the codebase.
	 *
	 * Instance-specific audit services (set via connectAudit) take precedence.
	 *
	 * @example
	 * ```ts
	 * // At application startup
	 * const auditSystem = await AuditLogSystem.create({ dbFile: "./audit.db" });
	 * Logger.setGlobalAuditService(auditSystem.service);
	 *
	 * // Now ALL loggers automatically persist to audit:
	 * const myLogger = new Logger("MyModule");
	 * myLogger.warn("This is persisted!"); // Uses global audit service
	 * ```
	 */
	static setGlobalAuditService(service: IAuditLogService): void {
		Logger.globalAuditService = service;
	}

	/**
	 * Clear the global audit service.
	 * After calling this, only loggers with instance-specific audit services will persist logs.
	 */
	static clearGlobalAuditService(): void {
		Logger.globalAuditService = undefined;
	}

	/**
	 * Check if a global audit service is configured
	 */
	static get hasGlobalAuditService(): boolean {
		return Logger.globalAuditService !== undefined;
	}
}

/**
 * Pre-configured loggers for common use cases.
 * These automatically use the global audit service when set via Logger.setGlobalAuditService().
 */
export const logger = {
	server: new Logger("Server"),
	db: new Logger("DB"),
	cache: new Logger("Cache"),
	auth: new Logger("Auth"),
	http: new Logger("HTTP"),
	cron: new Logger("Cron"),
};
