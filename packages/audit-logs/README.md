# @pitsa/audit-logs

A comprehensive audit logging system with real-time streaming, sensitive data redaction, and structured logging.

## Features

- **Structured Logging** - Pre-configured domain loggers (server, db, cache, auth, http, cron)
- **Request Context** - AsyncLocalStorage-based trace ID propagation
- **Audit Persistence** - SQLite-based log storage with FTS5 full-text search
- **Sensitive Data Redaction** - Automatic redaction of passwords, tokens, JWTs, credit cards
- **Real-time Streaming** - WebSocket-based live log streaming with filters
- **Retention Management** - Configurable retention periods per log level

## Installation

```bash
bun add @pitsa/audit-logs
```

Add as a workspace dependency in `package.json`:

```json
{
  "dependencies": {
    "@pitsa/audit-logs": "workspace:*"
  }
}
```

## Quick Start

### Basic Logging

```typescript
import { logger } from "@pitsa/audit-logs";

// Use pre-configured domain loggers
logger.server.info("Server started on port 8000");
logger.db.tag("SLOW").warn("Query took 150ms");
logger.auth.error("Login failed", { userId: 123 });
logger.http.debug("Request received", { method: "GET", path: "/api/users" });

// Tag chaining for additional context
logger.auth.tag("Login").tag("MFA").info("MFA code sent");
```

### Log Levels

| Level    | Priority | Description                          |
|----------|----------|--------------------------------------|
| debug    | 0        | Verbose debugging information        |
| info     | 1        | General informational messages       |
| warn     | 2        | Warning conditions                   |
| error    | 3        | Error conditions                     |
| security | 4        | Security-related events (always logged) |

Set log level via environment:

```bash
LOG_LEVEL=debug bun run server.ts  # Enable all logs
LOG_LEVEL=warn bun run server.ts   # Only warn, error, security
```

### Request Context

Wrap request handlers with `runWithRequestContext` for automatic trace ID propagation:

```typescript
import { runWithRequestContext, generateTraceId, logger } from "@pitsa/audit-logs";

app.use((req, res, next) => {
  const context = {
    traceId: generateTraceId(),
    method: req.method,
    path: req.path,
    startTime: Date.now(),
  };

  runWithRequestContext(context, () => {
    // All logs within this context will include the trace ID
    logger.http.info("Request started");
    next();
  });
});
```

### Structured Events

Log structured events for easy filtering in audit logs:

```typescript
logger.auth.event("info", "login_attempt", {
  method: "password",
  success: true,
});

logger.http.event("warn", "rate_limit_exceeded", {
  ip: "1.2.3.4",
  limit: 100,
});
```

## Server Setup

### Full Audit System

```typescript
import { AuditLogSystem, Logger, logger } from "@pitsa/audit-logs/server";

// Initialize the audit system
const auditSystem = new AuditLogSystem({
  dbFile: "./data/audit.db",
  runMigrations: true,
  jwtSecret: process.env.JWT_SECRET,
  retention: {
    default: 3,     // 3 months
    security: 12,   // 1 year
    error: 6,       // 6 months
  },
});
await auditSystem.initialize();

// Set global audit service - ALL loggers will automatically use this
// No need to manually connect individual loggers
Logger.setGlobalAuditService(auditSystem.service);

// Now ALL loggers persist to the database automatically:
logger.auth.warn("Failed login attempt", { userId: 123 });

// Custom loggers also work without explicit connection:
const myLogger = new Logger("MyModule");
myLogger.warn("This is also persisted!"); // Uses global audit service

// Loggers from other packages (like bun-server-core) also work:
// The trace ID is automatically propagated via AsyncLocalStorage
```

### Express Middleware

```typescript
import { createAuditMiddleware, createRequestLogger } from "@pitsa/audit-logs/server";

// Add audit context to requests
app.use(createAuditMiddleware({
  excludePaths: ["/health", "/metrics"],
  extractContext: (req) => ({
    userId: req.user?.id,
    username: req.user?.email,
  }),
}));

// Log all requests
app.use(createRequestLogger());
```

### WebSocket Streaming

```typescript
// Handle WebSocket upgrades for real-time log streaming
server.on("upgrade", (request, socket, head) => {
  if (request.url === "/audit/stream") {
    auditSystem.handleUpgrade(request, socket, head);
  }
});
```

## API Reference

### Logger

```typescript
import { Logger, logger } from "@pitsa/audit-logs";

// Pre-configured loggers
logger.server  // Server operations
logger.db      // Database operations
logger.cache   // Cache operations
logger.auth    // Authentication
logger.http    // HTTP requests
logger.cron    // Scheduled jobs

// Create custom logger
const myLogger = new Logger("MyModule");

// Fire-and-forget methods (logs persist asynchronously)
myLogger.debug(...args)           // Debug level
myLogger.info(...args)            // Info level
myLogger.warn(...args)            // Warning level
myLogger.error(...args)           // Error level
myLogger.success(...args)         // Success (info level, green badge)
myLogger.security(event, meta)    // Security event (always persisted)
myLogger.event(level, name, meta) // Structured event

// Awaitable methods (use these in route handlers to ensure persistence before response)
await myLogger.infoAsync(...args)            // Awaitable info
await myLogger.warnAsync(...args)            // Awaitable warning
await myLogger.errorAsync(...args)           // Awaitable error
await myLogger.eventAsync(level, name, meta) // Awaitable structured event

// Tag for additional context (also supports async methods)
myLogger.tag("Subsystem").info("Message")
await myLogger.tag("Subsystem").infoAsync("Message")

// Instance-level audit connection
myLogger.connectAudit(auditService)
myLogger.disconnectAudit()
myLogger.isAuditConnected          // boolean

// Static methods for global configuration
Logger.setGlobalAuditService(service)  // All loggers use this by default
Logger.clearGlobalAuditService()       // Clear global service
Logger.hasGlobalAuditService           // boolean

// Log level control
Logger.setLevel("debug")               // Set global log level
Logger.setLevel(null)                  // Reset to environment default
Logger.getEffectiveLevel()             // Get current level
await Logger.silent(() => fn())        // Run with logs disabled
await Logger.withLevel("debug", fn)    // Run with specific level
```

### AuditLogService

```typescript
import { AuditLogService } from "@pitsa/audit-logs/server";

// Query logs
const logs = await service.query({
  userId: 123,
  minLevel: "warn",
  startTime: Date.now() - 86400000, // Last 24 hours
  limit: 100,
});

// Full-text search
const results = await service.search("login failed");

// Get statistics
const stats = await service.getStats({
  startTime: Date.now() - 604800000, // Last week
});

// Cleanup old logs
const deleted = await service.cleanupOldLogs();
```

### Redactor

```typescript
import { Redactor, defaultRedactor } from "@pitsa/audit-logs/server";

// Use default redactor
const safe = defaultRedactor.redact({
  username: "john",
  password: "secret123",  // Will be [REDACTED]
  apiKey: "sk-abc123",    // Will be [REDACTED]
});

// Custom patterns
const customRedactor = new Redactor([
  { type: "field", pattern: /internalId/i },
  { type: "value", pattern: /^CUSTOM-\d+$/ },
]);
```

## Log Entry Schema

```typescript
interface LogEntry {
  id: string;
  timestamp: number;
  level: "debug" | "info" | "warn" | "error" | "security";
  event: string;

  // Context
  userId?: number;
  companyId?: number;
  employeeId?: number;
  username?: string;

  // Request info
  ipAddress?: string;
  userAgent?: string;
  geoCountry?: string;
  geoCity?: string;

  // API-specific
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;

  // Payload
  metadata?: object;
  message?: string;

  // Correlation
  traceId?: string;
}
```

## Retention Configuration

Configure how long logs are retained:

```typescript
const retention = {
  default: 3,     // 3 months for most logs
  security: 12,   // 1 year for security events
  error: 6,       // 6 months for errors
  warn: 3,        // 3 months for warnings
  info: 3,        // 3 months for info
  debug: 1,       // 1 month for debug logs
};
```

## Testing

Use in-memory SQLite for tests:

```typescript
import { Database } from "bun:sqlite";
import { Kysely, BunSqliteDialect } from "kysely";
import { AuditLogService } from "@pitsa/audit-logs/server";

// Create in-memory database for tests
const sqlite = new Database(":memory:");
const db = new Kysely({ dialect: new BunSqliteDialect({ database: sqlite }) });

// Run migrations manually or use test utilities
const service = new AuditLogService(db);
```

Silence logs in tests:

```typescript
import { Logger } from "@pitsa/audit-logs";

// In test setup
beforeAll(() => Logger.setLevel("silent"));
afterAll(() => Logger.setLevel(null));

// Or wrap specific code
await Logger.silent(async () => {
  // Logs disabled here
});
```

## Scaling & Production

### WebSocket Limitations

The WebSocket hub maintains in-memory connection state. This means:

- **Single-instance deployment**: WebSocket connections are not synchronized across multiple server instances
- For multi-instance deployments, consider adding a pub/sub layer (Redis) or routing WebSocket connections to a dedicated instance
- Connection limits and rate limiting are per-instance

### Configuration Options

```typescript
const auditSystem = await AuditLogSystem.create({
  dbFile: "./audit.db",
  websocket: {
    maxConnectionsPerUser: 5,      // Max connections per user (default: 5)
    rateLimitMessages: 100,        // Max messages per window (default: 100)
    rateLimitWindowMs: 60000,      // Rate limit window in ms (default: 1 minute)
  },
});
```

### Monitoring Audit Failures

Track audit log persistence failures for alerting:

```typescript
import { auditMetrics } from "@pitsa/audit-logs/server";

// Get current failure metrics
const metrics = auditMetrics.getSnapshot();
console.log({
  failureCount: metrics.failureCount,
  lastFailureAt: metrics.lastFailureAt,
  lastError: metrics.lastError,
});

// Example: Alert if failure rate is high
setInterval(() => {
  const { failureCount } = auditMetrics.getSnapshot();
  if (failureCount > 100) {
    // Send alert to monitoring system
  }
}, 60000);

// Reset metrics after handling (e.g., after sending alert)
auditMetrics.reset();
```

### Performance Considerations

- **Database indexes**: The schema includes indexes for `timestamp`, `user_id`, `company_id`, `event`, `level`, `ip_address`, and `trace_id`
- **FTS5 search**: Full-text search uses SQLite FTS5 for efficient text queries
- **WAL mode**: SQLite uses WAL journal mode for better concurrent read performance
- **Batch inserts**: Use `logBatch()` for inserting multiple entries efficiently

## License

Private - PITSA FRP
