# Rate Limiter Service

Request throttling with sliding window algorithm and automatic IP detection from proxy headers.

## Quick Start

```ts
// Check rate limit
const result = await ctx.core.rateLimiter.check(`api:${ctx.ip}`, 100, 60000);

if (!result.allowed) {
  return new Response("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": String(result.retryAfter) },
  });
}
```

---

## API Reference

### Interface

```ts
interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

interface RateLimitResult {
  allowed: boolean;       // Whether request is allowed
  remaining: number;      // Requests remaining in window
  limit: number;          // Total limit
  resetAt: Date;          // When window resets
  retryAfter?: number;    // Seconds until retry (if blocked)
}
```

### Methods

| Method | Description |
|--------|-------------|
| `check(key, limit, windowMs)` | Check and increment counter for key |
| `reset(key)` | Reset counter for key |

---

## IP Extraction

The framework automatically extracts client IP and provides it as `ctx.ip`. Headers are checked in priority order:

1. `CF-Connecting-IP` (Cloudflare)
2. `True-Client-IP` (Akamai, Cloudflare Enterprise)
3. `X-Real-IP` (Nginx)
4. `X-Forwarded-For` (first IP in chain)
5. Socket address (direct connection)

```ts
router.route("protected").typed({
  handle: async (input, ctx) => {
    console.log("Client IP:", ctx.ip); // Automatically extracted
  },
});
```

---

## Usage Examples

### Basic Rate Limiting

```ts
router.route("api").typed({
  handle: async (input, ctx) => {
    // 100 requests per minute per IP
    const result = await ctx.core.rateLimiter.check(
      `api:${ctx.ip}`,
      100,
      60000
    );

    if (!result.allowed) {
      return Response.json(
        { error: "Rate limit exceeded", retryAfter: result.retryAfter },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfter),
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": result.resetAt.toISOString(),
          },
        }
      );
    }

    // Process request...
    return { data: "success" };
  },
});
```

### Per-User Rate Limiting

```ts
router.route("user-action").typed({
  handle: async (input, ctx) => {
    // Rate limit by user, not IP (for authenticated routes)
    const key = `user:${ctx.user.id}:action`;
    const result = await ctx.core.rateLimiter.check(key, 10, 60000);

    if (!result.allowed) {
      throw new Error(`Rate limited. Try again in ${result.retryAfter}s`);
    }

    return performAction(input);
  },
});
```

### Per-Route Rate Limiting

```ts
// Different limits for different endpoints
const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  login: { limit: 5, windowMs: 60000 },        // 5/min
  search: { limit: 30, windowMs: 60000 },      // 30/min
  upload: { limit: 10, windowMs: 3600000 },    // 10/hour
  default: { limit: 100, windowMs: 60000 },    // 100/min
};

async function checkRouteLimit(route: string, ip: string, ctx: ServerContext) {
  const config = RATE_LIMITS[route] || RATE_LIMITS.default;
  return ctx.core.rateLimiter.check(`${route}:${ip}`, config.limit, config.windowMs);
}
```

### Tiered Rate Limits

```ts
// Different limits based on subscription tier
router.route("api").typed({
  handle: async (input, ctx) => {
    const tier = ctx.user?.tier || "free";

    const limits: Record<string, { limit: number; window: number }> = {
      free: { limit: 100, window: 3600000 },      // 100/hour
      pro: { limit: 1000, window: 3600000 },      // 1000/hour
      enterprise: { limit: 10000, window: 3600000 }, // 10000/hour
    };

    const { limit, window } = limits[tier];
    const key = `api:${ctx.user?.id || ctx.ip}:${tier}`;

    const result = await ctx.core.rateLimiter.check(key, limit, window);

    if (!result.allowed) {
      return Response.json({
        error: "Rate limit exceeded",
        tier,
        limit,
        upgrade: tier === "free" ? "Upgrade to Pro for higher limits" : undefined,
      }, { status: 429 });
    }

    return processRequest(input);
  },
});
```

---

## Rate Limit Middleware

Create reusable rate limit middleware:

```ts
// middleware/rateLimit.ts
import { createMiddleware } from "../middleware";
import { parseDuration } from "../core/rate-limiter";

interface RateLimitConfig {
  limit: number;
  window: string; // "1m", "1h", etc.
  keyPrefix?: string;
  keyFn?: (ctx: ServerContext) => string;
}

export const rateLimitMiddleware = createMiddleware<RateLimitConfig>(
  async (req, ctx, next, config) => {
    const windowMs = parseDuration(config.window);
    const keyBase = config.keyFn?.(ctx) ?? ctx.ip;
    const key = config.keyPrefix
      ? `${config.keyPrefix}:${keyBase}`
      : `ratelimit:${keyBase}`;

    const result = await ctx.core.rateLimiter.check(key, config.limit, windowMs);

    // Add rate limit headers to response
    const response = result.allowed
      ? await next()
      : Response.json({ error: "Too Many Requests" }, { status: 429 });

    response.headers.set("X-RateLimit-Limit", String(result.limit));
    response.headers.set("X-RateLimit-Remaining", String(result.remaining));
    response.headers.set("X-RateLimit-Reset", result.resetAt.toISOString());

    if (!result.allowed) {
      response.headers.set("Retry-After", String(result.retryAfter));
    }

    return response;
  }
);

// Register in plugin
export const rateLimitPlugin = createPlugin.define({
  name: "rateLimit",
  middleware: {
    rateLimit: rateLimitMiddleware,
  },
  service: async () => ({}),
});
```

**Usage:**

```ts
router.middleware
  .rateLimit({ limit: 100, window: "1m" })
  .route("api")
  .typed({ handle: ... });

router.middleware
  .rateLimit({ limit: 5, window: "1h", keyPrefix: "login" })
  .route("login")
  .typed({ handle: ... });
```

---

## Helper Functions

### parseDuration

Convert duration strings to milliseconds:

```ts
import { parseDuration } from "./core/rate-limiter";

parseDuration("100ms");  // 100
parseDuration("30s");    // 30000
parseDuration("5m");     // 300000
parseDuration("2h");     // 7200000
parseDuration("1d");     // 86400000
```

### createRateLimitKey

Build consistent rate limit keys:

```ts
import { createRateLimitKey } from "./core/rate-limiter";

const key = createRateLimitKey("api.users.list", "192.168.1.1");
// "ratelimit:api.users.list:192.168.1.1"
```

### extractClientIP

Manual IP extraction if needed:

```ts
import { extractClientIP } from "./core/rate-limiter";

const ip = extractClientIP(req, socketAddr);
```

---

## Real-World Examples

### API Rate Limiting with Response Headers

```ts
async function withRateLimit(
  ctx: ServerContext,
  key: string,
  limit: number,
  windowMs: number,
  handler: () => Promise<Response>
): Promise<Response> {
  const result = await ctx.core.rateLimiter.check(key, limit, windowMs);

  const headers = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.floor(result.resetAt.getTime() / 1000)),
  };

  if (!result.allowed) {
    return Response.json(
      {
        error: "rate_limit_exceeded",
        message: `Rate limit exceeded. Retry in ${result.retryAfter} seconds.`,
      },
      {
        status: 429,
        headers: {
          ...headers,
          "Retry-After": String(result.retryAfter),
        },
      }
    );
  }

  const response = await handler();

  // Add headers to successful response
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}
```

### Login Brute Force Protection

```ts
router.route("login").typed({
  handle: async (input, ctx) => {
    // Strict limit on login attempts
    const result = await ctx.core.rateLimiter.check(
      `login:${ctx.ip}`,
      5,      // 5 attempts
      300000  // per 5 minutes
    );

    if (!result.allowed) {
      ctx.core.logger.warn("Login rate limited", {
        ip: ctx.ip,
        email: input.email,
      });

      return Response.json({
        error: "Too many login attempts",
        retryAfter: result.retryAfter,
      }, { status: 429 });
    }

    const user = await authenticate(input.email, input.password);

    if (!user) {
      // Failed attempt still counts
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Success - optionally reset limit
    await ctx.core.rateLimiter.reset(`login:${ctx.ip}`);

    return { token: generateToken(user) };
  },
});
```

### Cost-Based Rate Limiting

```ts
// Different operations have different costs
const OPERATION_COSTS: Record<string, number> = {
  "query.simple": 1,
  "query.complex": 5,
  "mutation.create": 2,
  "mutation.bulkCreate": 10,
  "export.csv": 20,
  "export.pdf": 50,
};

router.route("graphql").typed({
  handle: async (input, ctx) => {
    const operationType = analyzeQuery(input.query);
    const cost = OPERATION_COSTS[operationType] || 1;

    // 1000 cost units per hour
    const key = `graphql:${ctx.user.id}`;

    // Check if we have enough budget
    const current = await ctx.core.cache.get<number>(`${key}:cost`) || 0;

    if (current + cost > 1000) {
      return Response.json({
        error: "Rate limit exceeded",
        cost,
        used: current,
        limit: 1000,
      }, { status: 429 });
    }

    // Increment cost
    await ctx.core.cache.set(`${key}:cost`, current + cost, 3600000);

    return executeQuery(input.query);
  },
});
```

---

## Custom Adapters

Implement `RateLimitAdapter` for custom backends:

```ts
interface RateLimitAdapter {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: Date }>;
  get(key: string): Promise<{ count: number; resetAt: Date } | null>;
  reset(key: string): Promise<void>;
}
```

### Built-in Redis Adapter

A production-ready Redis adapter is included. Requires `ioredis` as a peer dependency (`bun add ioredis`).

```ts
import Redis from "ioredis";
import { RedisRateLimitAdapter } from "@donkeylabs/server/core";

const redis = new Redis("redis://localhost:6379");

const server = new AppServer({
  rateLimiter: {
    adapter: new RedisRateLimitAdapter(redis, { prefix: "myapp:" }),
  },
});

// Remember to disconnect on shutdown
server.onShutdown(() => redis.disconnect());
```

**Features:**
- Atomic Lua script for `INCR` + conditional `PEXPIRE` (prevents race conditions)
- Pipeline `GET` + `PTTL` in a single round-trip for `get()`
- Optional `prefix` for key namespace isolation in shared Redis instances

### Custom Redis Adapter Example

For custom requirements, implement `RateLimitAdapter` directly:

```ts
import { type RateLimitAdapter } from "@donkeylabs/server/core";

class MyCustomRateLimitAdapter implements RateLimitAdapter {
  // Implement increment, get, reset
}
```

---

## Best Practices

### 1. Use Appropriate Key Granularity

```ts
// Per IP for anonymous
`public:${ctx.ip}`

// Per user for authenticated
`user:${ctx.user.id}`

// Per user per endpoint
`user:${ctx.user.id}:${endpoint}`

// Per organization for team limits
`org:${ctx.user.orgId}`
```

### 2. Set Reasonable Limits

```ts
// Consider normal usage patterns
const limits = {
  // Login: low limit, short window (brute force protection)
  login: { limit: 5, window: "5m" },

  // Search: moderate limit (expensive operations)
  search: { limit: 30, window: "1m" },

  // Read API: generous limit
  read: { limit: 1000, window: "1h" },

  // Write API: moderate limit
  write: { limit: 100, window: "1h" },
};
```

### 3. Return Helpful Headers

```ts
// Always include rate limit info in responses
response.headers.set("X-RateLimit-Limit", limit);
response.headers.set("X-RateLimit-Remaining", remaining);
response.headers.set("X-RateLimit-Reset", resetTimestamp);
response.headers.set("Retry-After", seconds); // Only when blocked
```

### 4. Log Rate Limit Events

```ts
if (!result.allowed) {
  ctx.core.logger.warn("Rate limit exceeded", {
    key,
    ip: ctx.ip,
    userId: ctx.user?.id,
    endpoint: req.url,
  });
}
```
