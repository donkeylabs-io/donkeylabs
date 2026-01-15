# Logger Service

Structured logging with configurable levels, custom transports, and child loggers for contextual logging.

## Quick Start

```ts
// Access via ctx.core.logger
ctx.core.logger.info("User logged in", { userId: 123 });
ctx.core.logger.error("Payment failed", { orderId: 456, error: "Insufficient funds" });
```

---

## API Reference

### Interface

```ts
interface Logger {
  debug(message: string, data?: Record<string, any>): void;
  info(message: string, data?: Record<string, any>): void;
  warn(message: string, data?: Record<string, any>): void;
  error(message: string, data?: Record<string, any>): void;
  child(context: Record<string, any>): Logger;
}
```

### Log Levels

| Level | Priority | Use Case |
|-------|----------|----------|
| `debug` | 0 | Detailed debugging information |
| `info` | 1 | General operational messages |
| `warn` | 2 | Warning conditions |
| `error` | 3 | Error conditions |

Only messages at or above the configured level are logged.

---

## Configuration

```ts
const server = new AppServer({
  db,
  logger: {
    level: "info",       // Minimum level to log (default: "info")
    format: "pretty",    // "pretty" or "json" (default: "pretty")
    transports: [],      // Custom transports (optional)
  },
});
```

---

## Usage Examples

### Basic Logging

```ts
router.route("checkout").typed({
  handle: async (input, ctx) => {
    ctx.core.logger.info("Checkout started", {
      userId: ctx.user.id,
      cartTotal: input.total,
    });

    try {
      const order = await processPayment(input);
      ctx.core.logger.info("Payment successful", { orderId: order.id });
      return order;
    } catch (error) {
      ctx.core.logger.error("Payment failed", {
        userId: ctx.user.id,
        error: error.message,
      });
      throw error;
    }
  },
});
```

### Child Loggers

Child loggers inherit parent settings and add persistent context:

```ts
// In plugin initialization
service: async (ctx) => {
  // Create logger with plugin context
  const log = ctx.core.logger.child({ plugin: "payments" });

  return {
    async processPayment(orderId: string) {
      // Create request-specific logger
      const requestLog = log.child({ orderId });

      requestLog.info("Processing payment");
      // Logs: { plugin: "payments", orderId: "123", ... }

      requestLog.debug("Validating card");
      requestLog.info("Payment complete");
    },
  };
};
```

### Request Logging Middleware

```ts
const requestLogger = createMiddleware(async (req, ctx, next) => {
  const start = Date.now();
  const requestId = ctx.requestId;

  // Create request-scoped logger
  const log = ctx.core.logger.child({
    requestId,
    method: req.method,
    path: new URL(req.url).pathname,
    ip: ctx.ip,
  });

  log.info("Request started");

  try {
    const response = await next();
    log.info("Request completed", {
      status: response.status,
      duration: Date.now() - start,
    });
    return response;
  } catch (error) {
    log.error("Request failed", {
      error: error.message,
      duration: Date.now() - start,
    });
    throw error;
  }
});
```

---

## Output Formats

### Pretty Format (Default)

Human-readable colored output for development:

```
[12:34:56.789] INFO  User logged in {"userId":123}
[12:34:56.790] ERROR Payment failed {"orderId":456,"error":"Insufficient funds"}
```

### JSON Format

Structured JSON for production log aggregation:

```json
{"timestamp":"2024-01-15T12:34:56.789Z","level":"info","message":"User logged in","userId":123}
{"timestamp":"2024-01-15T12:34:56.790Z","level":"error","message":"Payment failed","orderId":456,"error":"Insufficient funds"}
```

---

## Custom Transports

Create custom transports to send logs to external services:

```ts
import { createLogger, type LogTransport, type LogEntry } from "./core/logger";

// Custom transport for external service
class DatadogTransport implements LogTransport {
  constructor(private apiKey: string) {}

  log(entry: LogEntry): void {
    fetch("https://http-intake.logs.datadoghq.com/v1/input", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": this.apiKey,
      },
      body: JSON.stringify({
        timestamp: entry.timestamp.toISOString(),
        level: entry.level,
        message: entry.message,
        ...entry.data,
        ...entry.context,
      }),
    });
  }
}

// File transport
class FileTransport implements LogTransport {
  constructor(private filePath: string) {}

  log(entry: LogEntry): void {
    const line = JSON.stringify({
      timestamp: entry.timestamp.toISOString(),
      level: entry.level,
      message: entry.message,
      ...entry.data,
      ...entry.context,
    }) + "\n";

    Bun.write(this.filePath, line, { append: true });
  }
}

// Use custom transports
const logger = createLogger({
  level: "info",
  transports: [
    new ConsoleTransport("pretty"),
    new DatadogTransport(process.env.DD_API_KEY!),
    new FileTransport("./logs/app.log"),
  ],
});
```

---

## Best Practices

### 1. Use Appropriate Levels

```ts
// Debug - detailed technical info (disabled in production)
log.debug("Cache lookup", { key, hit: !!cached });

// Info - notable events
log.info("Order created", { orderId, total });

// Warn - unexpected but handled conditions
log.warn("Retry attempt", { attempt: 3, maxAttempts: 5 });

// Error - failures requiring attention
log.error("Database connection lost", { error: err.message });
```

### 2. Include Relevant Context

```ts
// Bad - missing context
log.error("Failed");

// Good - actionable information
log.error("Payment processing failed", {
  userId: user.id,
  orderId: order.id,
  amount: order.total,
  provider: "stripe",
  error: err.message,
  errorCode: err.code,
});
```

### 3. Use Child Loggers for Scopes

```ts
// Create scoped loggers for different concerns
const dbLog = logger.child({ component: "database" });
const authLog = logger.child({ component: "auth" });
const apiLog = logger.child({ component: "api" });

// Each log includes its scope
dbLog.info("Query executed");    // includes component: "database"
authLog.info("Token validated"); // includes component: "auth"
```

### 4. Don't Log Sensitive Data

```ts
// Bad - exposes password
log.info("Login attempt", { email, password });

// Good - redact sensitive fields
log.info("Login attempt", { email, passwordProvided: !!password });

// Bad - exposes token
log.debug("Auth header", { authorization: req.headers.get("authorization") });

// Good - mask token
log.debug("Auth header present", { hasAuth: !!req.headers.get("authorization") });
```

---

## LogEntry Structure

```ts
interface LogEntry {
  timestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, any>;     // Per-call data
  context?: Record<string, any>;  // From child logger
}
```

---

## Environment-Based Configuration

```ts
const server = new AppServer({
  db,
  logger: {
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    format: process.env.NODE_ENV === "production" ? "json" : "pretty",
  },
});
```
