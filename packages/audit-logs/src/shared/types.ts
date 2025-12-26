import { z } from "zod";

// ============================================================================
// Log Levels
// ============================================================================

export const LogLevel = z.enum(["debug", "info", "warn", "error", "security"]);
export type LogLevel = z.infer<typeof LogLevel>;

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  security: 4,
};

// ============================================================================
// Log Entry
// ============================================================================

export const LogEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(), // Unix ms
  level: LogLevel,
  event: z.string(), // Namespaced: auth.login, api.GET./orders

  // Context
  userId: z.number().nullable(),
  companyId: z.number().nullable(),
  employeeId: z.number().nullable(),
  username: z.string().nullable(),

  // Request info
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  geoCountry: z.string().nullable(),
  geoCity: z.string().nullable(),

  // API-specific
  method: z.string().nullable(), // GET, POST, etc.
  path: z.string().nullable(),
  statusCode: z.number().nullable(),
  durationMs: z.number().nullable(),

  // Flexible payload (JSON string)
  metadata: z.string().nullable(),

  // Human-readable message (optional)
  message: z.string().nullable(),

  // For request correlation
  traceId: z.string().nullable(),
});

export type LogEntry = z.infer<typeof LogEntrySchema>;

export const LogEntryInputSchema = z.object({
  level: LogLevel.optional(),
  event: z.string(),

  // Context (optional)
  userId: z.number().optional(),
  companyId: z.number().optional(),
  employeeId: z.number().optional(),
  username: z.string().optional(),

  // Request info (optional)
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  geoCountry: z.string().optional(),
  geoCity: z.string().optional(),

  // API-specific (optional)
  method: z.string().optional(),
  path: z.string().optional(),
  statusCode: z.number().optional(),
  durationMs: z.number().optional(),

  // Flexible payload
  metadata: z.record(z.string(), z.unknown()).optional(),

  // Human-readable message (optional)
  message: z.string().optional(),

  // For request correlation
  traceId: z.string().optional(),
});

export type LogEntryInput = z.infer<typeof LogEntryInputSchema>;

// ============================================================================
// Query Filters
// ============================================================================

export const LogQueryFiltersSchema = z.object({
  // Pagination
  limit: z.number().min(1).max(1000).optional(),
  offset: z.number().min(0).optional(),

  // Time range
  startTime: z.number().optional(), // Unix ms
  endTime: z.number().optional(), // Unix ms

  // Filters
  userId: z.number().optional(),
  companyId: z.number().optional(),
  employeeId: z.number().optional(),
  username: z.string().optional(),
  ipAddress: z.string().optional(),
  event: z.string().optional(), // Exact match or prefix with *
  events: z.array(z.string()).optional(), // Multiple events
  level: LogLevel.optional(),
  levels: z.array(LogLevel).optional(),
  minLevel: LogLevel.optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  traceId: z.string().optional(),

  // Full-text search
  search: z.string().optional(),

  // Sort
  sortBy: z.enum(["timestamp", "level", "event"]).default("timestamp"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type LogQueryFilters = z.infer<typeof LogQueryFiltersSchema>;

// ============================================================================
// Query Results
// ============================================================================

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface LogStats {
  totalLogs: number;
  byLevel: Record<LogLevel, number>;
  byEvent: { event: string; count: number }[];
  byUser: { userId: number; username: string | null; count: number }[];
  timeRange: { start: number; end: number } | null;
}

export interface UserActivitySummary {
  userId: number;
  username: string | null;
  totalActions: number;
  firstSeen: number;
  lastSeen: number;
  topEvents: { event: string; count: number }[];
  recentLogs: LogEntry[];
}

/**
 * Summary of a trace (group of logs with same trace_id)
 * Used for the main audit log view to show requests instead of individual logs
 */
export interface TraceSummary {
  traceId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  logCount: number;
  method?: string;
  path?: string;
  userId?: number;
  username?: string;
  employeeId?: number;
  ipAddress?: string;
  statusCode?: number;
  requestDurationMs?: number;
  highestLevel: LogLevel;
}

// ============================================================================
// WebSocket Messages
// ============================================================================

// Client → Server
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    filters: z.object({
      userId: z.number().optional(),
      companyId: z.number().optional(),
      events: z.array(z.string()).optional(), // Glob patterns: ["auth.*", "api.POST.*"]
      levels: z.array(LogLevel).optional(),
      minLevel: LogLevel.optional(),
    }),
  }),
  z.object({ type: z.literal("unsubscribe") }),
  z.object({ type: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Server → Client
export type ServerMessage =
  | { type: "connected"; connectionId: string }
  | { type: "log"; entry: LogEntry }
  | { type: "subscribed"; filters: StreamFilters }
  | { type: "error"; message: string }
  | { type: "pong" };

export interface StreamFilters {
  userId?: number;
  companyId?: number;
  events?: string[]; // Glob patterns
  levels?: LogLevel[];
  minLevel?: LogLevel;
}

// ============================================================================
// Connection State
// ============================================================================

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

// ============================================================================
// Retention Config (in months)
// ============================================================================

export interface RetentionConfig {
  default: number; // months
  security?: number;
  error?: number;
  warn?: number;
  info?: number;
  debug?: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  default: 3, // 3 months
  security: 12, // 12 months (1 year)
  error: 6, // 6 months
  warn: 3, // 3 months
  info: 3, // 3 months
  debug: 1, // 1 month
};

// ============================================================================
// Redaction
// ============================================================================

export interface RedactionPattern {
  type: "field" | "value";
  pattern: RegExp;
}

export const REDACTED_PLACEHOLDER = "[REDACTED]";

// Default patterns for sensitive data
export const DEFAULT_REDACTION_PATTERNS: RedactionPattern[] = [
  // Field name patterns
  { type: "field", pattern: /password/i },
  { type: "field", pattern: /passwd/i },
  { type: "field", pattern: /secret/i },
  { type: "field", pattern: /token/i },
  { type: "field", pattern: /apikey/i },
  { type: "field", pattern: /api_key/i },
  { type: "field", pattern: /api-key/i },
  { type: "field", pattern: /authorization/i },
  { type: "field", pattern: /auth/i },
  { type: "field", pattern: /cookie/i },
  { type: "field", pattern: /session/i },
  { type: "field", pattern: /credential/i },
  { type: "field", pattern: /credit.?card/i },
  { type: "field", pattern: /card.?number/i },
  { type: "field", pattern: /cvv/i },
  { type: "field", pattern: /cvc/i },
  { type: "field", pattern: /ssn/i },
  { type: "field", pattern: /social.?security/i },
  { type: "field", pattern: /private.?key/i },
  { type: "field", pattern: /encryption.?key/i },

  // Value patterns (detect sensitive values regardless of field name)
  { type: "value", pattern: /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/ }, // JWT
  { type: "value", pattern: /^Bearer\s+.+$/i }, // Bearer token
  { type: "value", pattern: /^\d{13,19}$/ }, // Credit card number (13-19 digits)
  { type: "value", pattern: /^\d{3,4}$/ }, // CVV (3-4 digits, only if in sensitive context)
];

// ============================================================================
// Middleware Options
// ============================================================================

export interface MiddlewareOptions {
  excludePaths?: string[];
  excludeMethods?: string[];
  captureBody?: boolean;
  captureResponse?: boolean;
  additionalRedaction?: string[];
  // Function to extract user context from request
  extractContext?: (req: unknown) => {
    userId?: number;
    companyId?: number;
    employeeId?: number;
    username?: string;
  };
}

// ============================================================================
// System Options
// ============================================================================

export interface WebSocketOptions {
  /** Maximum connections per user (default: 5) */
  maxConnectionsPerUser?: number;
  /** Rate limit: max messages per window (default: 100) */
  rateLimitMessages?: number;
  /** Rate limit window in milliseconds (default: 60000 = 1 minute) */
  rateLimitWindowMs?: number;
}

export interface AuditLogSystemOptions {
  dbFile: string;
  runMigrations?: boolean;
  retention?: RetentionConfig;
  redactionPatterns?: RedactionPattern[];
  /** JWT secret for WebSocket auth */
  jwtSecret?: string;
  /** WebSocket rate limiting and connection limits */
  websocket?: WebSocketOptions;
}
