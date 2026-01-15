# Middleware

Request/response middleware for cross-cutting concerns like authentication, rate limiting, CORS, and logging.

## Quick Start

```ts
import { createMiddleware } from "./middleware";

// Create middleware with config
const authMiddleware = createMiddleware<{ required: boolean }>(
  async (req, ctx, next, config) => {
    const token = req.headers.get("Authorization");

    if (config.required && !token) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Modify context
    ctx.user = await validateToken(token);

    // Continue to next middleware/handler
    return next();
  }
);
```

---

## API Reference

### Types

```ts
// The next function - calls the next middleware or handler
type NextFn = () => Promise<Response>;

// Middleware function signature
type MiddlewareFn<TConfig = void> = (
  req: Request,
  ctx: ServerContext,
  next: NextFn,
  config: TConfig
) => Promise<Response>;

// Runtime middleware structure
interface MiddlewareRuntime<TConfig = void> {
  execute: MiddlewareFn<TConfig>;
  readonly __config: TConfig;  // Phantom type for config inference
}
```

### createMiddleware Factory

```ts
function createMiddleware<TConfig = void>(
  execute: MiddlewareFn<TConfig>
): MiddlewareRuntime<TConfig>;
```

---

## Creating Middleware

### Step 1: Define Middleware

```ts
// middleware/auth.ts
import { createMiddleware } from "../middleware";

interface AuthConfig {
  required?: boolean;
  role?: string;
}

export const authMiddleware = createMiddleware<AuthConfig>(
  async (req, ctx, next, config) => {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");

    if (!token) {
      if (config.required) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return next();
    }

    try {
      const user = await verifyToken(token);

      if (config.role && user.role !== config.role) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }

      ctx.user = user;
    } catch {
      if (config.required) {
        return Response.json({ error: "Invalid token" }, { status: 401 });
      }
    }

    return next();
  }
);
```

### Step 2: Register in Plugin

Middleware is defined as a function that receives `(ctx, service)` and returns middleware definitions:

```ts
// plugins/auth/index.ts
import { createPlugin, createMiddleware } from "@donkeylabs/server";

export const authPlugin = createPlugin.define({
  name: "auth",

  // Service MUST come before middleware for type inference
  service: async (ctx) => ({
    async validateToken(token: string) {
      // Validation logic...
      return { id: 1, name: "User" };
    },
  }),

  // Middleware receives (ctx, service) - can access its own service!
  middleware: (ctx, service) => ({
    auth: createMiddleware<{ required?: boolean }>(
      async (req, reqCtx, next, config) => {
        const token = req.headers.get("Authorization")?.replace("Bearer ", "");

        if (!token && config?.required) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (token) {
          // Use own service for validation
          reqCtx.user = await service.validateToken(token);
        }

        return next();
      }
    ),
  }),
});
```

**Important:** The `service` property must come before `middleware` in the plugin definition for TypeScript to correctly infer the service type.

### Step 3: Regenerate Registry

```sh
bun run gen:registry
```

### Step 4: Use in Routes

```ts
// Now available as .auth() method
router.middleware
  .auth({ required: true, role: "admin" })
  .route("admin").typed({ ... });
```

---

## Middleware Examples

### Rate Limiting Middleware

```ts
interface RateLimitConfig {
  limit: number;
  window: string;  // "1m", "1h", etc.
  keyPrefix?: string;
}

export const rateLimitMiddleware = createMiddleware<RateLimitConfig>(
  async (req, ctx, next, config) => {
    const windowMs = parseDuration(config.window);
    const key = config.keyPrefix
      ? `${config.keyPrefix}:${ctx.ip}`
      : `ratelimit:${ctx.ip}`;

    const result = await ctx.core.rateLimiter.check(key, config.limit, windowMs);

    if (!result.allowed) {
      return Response.json(
        { error: "Rate limit exceeded" },
        {
          status: 429,
          headers: { "Retry-After": String(result.retryAfter) },
        }
      );
    }

    const response = await next();

    // Add rate limit headers
    response.headers.set("X-RateLimit-Limit", String(config.limit));
    response.headers.set("X-RateLimit-Remaining", String(result.remaining));

    return response;
  }
);
```

### CORS Middleware

```ts
interface CORSConfig {
  origin?: string | string[];
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
}

export const corsMiddleware = createMiddleware<CORSConfig>(
  async (req, ctx, next, config) => {
    const origin = req.headers.get("Origin");
    const allowedOrigins = Array.isArray(config.origin)
      ? config.origin
      : [config.origin || "*"];

    // Handle preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin!)
            ? origin!
            : allowedOrigins[0],
          "Access-Control-Allow-Methods": (config.methods || ["GET", "POST"]).join(", "),
          "Access-Control-Allow-Headers": (config.headers || ["Content-Type"]).join(", "),
          "Access-Control-Allow-Credentials": String(config.credentials ?? false),
        },
      });
    }

    const response = await next();

    // Add CORS headers to response
    if (origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin))) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      if (config.credentials) {
        response.headers.set("Access-Control-Allow-Credentials", "true");
      }
    }

    return response;
  }
);
```

### Logging Middleware

```ts
interface LogConfig {
  level?: "debug" | "info";
  includeBody?: boolean;
}

export const loggingMiddleware = createMiddleware<LogConfig>(
  async (req, ctx, next, config) => {
    const start = Date.now();

    const logData: any = {
      method: req.method,
      url: req.url,
      ip: ctx.ip,
      requestId: ctx.requestId,
    };

    if (config.includeBody && req.method === "POST") {
      try {
        logData.body = await req.clone().json();
      } catch {}
    }

    const log = config.level === "debug"
      ? ctx.core.logger.debug
      : ctx.core.logger.info;

    log("Request started", logData);

    const response = await next();

    log("Request completed", {
      ...logData,
      status: response.status,
      duration: Date.now() - start,
    });

    return response;
  }
);
```

### Caching Middleware

```ts
interface CacheConfig {
  ttl: number;
  keyFn?: (req: Request, ctx: ServerContext) => string;
}

export const cacheMiddleware = createMiddleware<CacheConfig>(
  async (req, ctx, next, config) => {
    // Only cache GET requests
    if (req.method !== "GET" && req.method !== "POST") {
      return next();
    }

    const key = config.keyFn
      ? config.keyFn(req, ctx)
      : `cache:${new URL(req.url).pathname}`;

    // Check cache
    const cached = await ctx.core.cache.get<{ body: string; headers: Record<string, string> }>(key);

    if (cached) {
      return new Response(cached.body, {
        headers: {
          ...cached.headers,
          "X-Cache": "HIT",
        },
      });
    }

    // Get fresh response
    const response = await next();

    // Cache the response
    if (response.ok) {
      const body = await response.clone().text();
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));

      await ctx.core.cache.set(key, { body, headers }, config.ttl);
      response.headers.set("X-Cache", "MISS");
    }

    return response;
  }
);
```

### Validation Middleware

```ts
import { z } from "zod";

interface ValidationConfig {
  headers?: z.ZodType;
  query?: z.ZodType;
}

export const validateMiddleware = createMiddleware<ValidationConfig>(
  async (req, ctx, next, config) => {
    // Validate headers
    if (config.headers) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));

      const result = config.headers.safeParse(headers);
      if (!result.success) {
        return Response.json(
          { error: "Invalid headers", details: result.error.issues },
          { status: 400 }
        );
      }
    }

    // Validate query params
    if (config.query) {
      const url = new URL(req.url);
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));

      const result = config.query.safeParse(query);
      if (!result.success) {
        return Response.json(
          { error: "Invalid query parameters", details: result.error.issues },
          { status: 400 }
        );
      }
    }

    return next();
  }
);
```

---

## Using Middleware

### Single Middleware

```ts
router.middleware
  .auth({ required: true })
  .route("protected").typed({
    handle: async (input, ctx) => {
      return { userId: ctx.user.id };
    },
  });
```

### Chained Middleware

Middleware executes in order (left to right):

```ts
router.middleware
  .cors({ origin: "*" })             // 1st: CORS handling
  .logging({ level: "info" })        // 2nd: Log request start
  .auth({ required: true })          // 3rd: Check authentication
  .rateLimit({ limit: 100, window: "1m" })  // 4th: Rate limiting
  .route("api").typed({
    handle: async (input, ctx) => {
      // All middleware passed
    },
  });
```

### Reusable Middleware Chain

```ts
// Create reusable middleware chain
const protectedApi = router.middleware
  .cors({ origin: "https://myapp.com" })
  .auth({ required: true })
  .rateLimit({ limit: 1000, window: "1h" });

// Apply to multiple routes
protectedApi.route("users").typed({ ... });
protectedApi.route("orders").typed({ ... });
protectedApi.route("products").typed({ ... });
```

### Conditional Middleware

```ts
const baseMiddleware = router.middleware.cors({ origin: "*" });

// Add auth only in production
const middleware = process.env.NODE_ENV === "production"
  ? baseMiddleware.auth({ required: true })
  : baseMiddleware;

middleware.route("api").typed({ ... });
```

---

## Middleware Execution Flow

```
Request
   │
   ▼
┌─────────────────────────────────┐
│  Middleware 1 (CORS)            │
│    │                            │
│    ▼                            │
│  Middleware 2 (Auth)            │
│    │                            │
│    ▼                            │
│  Middleware 3 (RateLimit)       │
│    │                            │
│    ▼                            │
│  ┌───────────────────────────┐  │
│  │  Handler                  │  │
│  │  (your route handler)     │  │
│  └───────────────────────────┘  │
│    │                            │
│    ▼                            │
│  Middleware 3 (post-handler)    │
│    │                            │
│    ▼                            │
│  Middleware 2 (post-handler)    │
│    │                            │
│    ▼                            │
│  Middleware 1 (post-handler)    │
└─────────────────────────────────┘
   │
   ▼
Response
```

---

## Modifying Context

Middleware can add properties to `ctx`:

```ts
// Auth middleware adds ctx.user
const authMiddleware = createMiddleware<AuthConfig>(async (req, ctx, next, config) => {
  ctx.user = await validateToken(req.headers.get("Authorization"));
  return next();
});

// Handler can access ctx.user
router.middleware.auth({ required: true }).route("profile").typed({
  handle: async (input, ctx) => {
    return { name: ctx.user.name };  // ctx.user is set
  },
});
```

---

## Response Modification

Middleware can modify the response:

```ts
const timingMiddleware = createMiddleware(async (req, ctx, next) => {
  const start = Date.now();

  // Get response from handler
  const response = await next();

  // Add timing header
  response.headers.set("X-Response-Time", `${Date.now() - start}ms`);

  return response;
});
```

---

## Early Returns

Middleware can return early without calling `next()`:

```ts
const maintenanceMiddleware = createMiddleware(async (req, ctx, next) => {
  if (process.env.MAINTENANCE_MODE === "true") {
    return Response.json(
      { error: "Service under maintenance" },
      { status: 503 }
    );
  }

  return next();  // Continue if not in maintenance
});
```

---

## Error Handling

```ts
const errorMiddleware = createMiddleware(async (req, ctx, next) => {
  try {
    return await next();
  } catch (error: any) {
    ctx.core.logger.error("Unhandled error", {
      error: error.message,
      stack: error.stack,
      requestId: ctx.requestId,
    });

    return Response.json(
      { error: "Internal server error", requestId: ctx.requestId },
      { status: 500 }
    );
  }
});
```

---

## Best Practices

### 1. Keep Middleware Focused

```ts
// Good - single responsibility
const authMiddleware = createMiddleware(...);      // Just auth
const rateLimitMiddleware = createMiddleware(...); // Just rate limiting
const loggingMiddleware = createMiddleware(...);   // Just logging

// Bad - too many responsibilities
const everythingMiddleware = createMiddleware(async (req, ctx, next) => {
  // Check auth
  // Rate limit
  // Log
  // Validate
  // Cache
  // ...
});
```

### 2. Order Matters

```ts
// Good order
router.middleware
  .cors()      // Handle CORS first (for preflight)
  .logging()   // Log all requests
  .auth()      // Then authenticate
  .rateLimit() // Then rate limit
  .route("api")

// Bad order
router.middleware
  .rateLimit() // Rate limit before auth = limit by IP only
  .auth()      // Auth after rate limit = may waste rate limit on bad tokens
  .cors()      // CORS late = preflight requests fail
```

### 3. Make Config Optional When Possible

```ts
interface AuthConfig {
  required?: boolean;  // Default: false
  role?: string;       // Default: any role
}

// Allows simple usage
router.middleware.auth().route("optional-auth")
router.middleware.auth({ required: true }).route("required-auth")
```

### 4. Document Configuration

```ts
/**
 * Rate limiting middleware
 *
 * @param config.limit - Max requests in window (default: 100)
 * @param config.window - Time window ("1m", "1h", "1d")
 * @param config.keyPrefix - Cache key prefix (default: "ratelimit")
 *
 * @example
 * router.middleware.rateLimit({ limit: 100, window: "1m" })
 */
export const rateLimitMiddleware = createMiddleware<RateLimitConfig>(...);
```

### 5. Test Middleware in Isolation

```ts
import { authMiddleware } from "./middleware/auth";

test("auth middleware rejects invalid token", async () => {
  const req = new Request("http://test", {
    headers: { Authorization: "Bearer invalid" },
  });

  const ctx = createMockContext();
  const next = vi.fn();

  const response = await authMiddleware.execute(req, ctx, next, { required: true });

  expect(response.status).toBe(401);
  expect(next).not.toHaveBeenCalled();
});
```

---

## Common Patterns

### Authentication + Authorization

```ts
// First check if authenticated, then check role
router.middleware
  .auth({ required: true })
  .role({ allowed: ["admin", "moderator"] })
  .route("admin").typed({ ... });
```

### Public Routes with Optional Auth

```ts
// Auth runs but doesn't require login
router.middleware
  .auth({ required: false })
  .route("public").typed({
    handle: async (input, ctx) => {
      // ctx.user may or may not exist
      if (ctx.user) {
        return { message: `Hello, ${ctx.user.name}!` };
      }
      return { message: "Hello, guest!" };
    },
  });
```

### Environment-Specific Middleware

```ts
const middleware = router.middleware.cors({ origin: "*" });

if (process.env.NODE_ENV === "production") {
  middleware
    .auth({ required: true })
    .rateLimit({ limit: 100, window: "1m" });
}

middleware.route("api").typed({ ... });
```
