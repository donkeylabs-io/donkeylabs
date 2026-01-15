# Error System

The error system provides throwable HTTP errors that are automatically caught by the server and converted to proper HTTP responses with status codes and JSON error bodies.

## Quick Start

```ts
// In any route handler
const router = createRouter("users")
  .route("get").typed({
    input: z.object({ id: z.number() }),
    output: z.object({ name: z.string() }),
    handle: async (input, ctx) => {
      const user = await ctx.db.selectFrom("users")
        .where("id", "=", input.id)
        .selectAll()
        .executeTakeFirst();

      if (!user) {
        // Throws 404 with JSON body: { error: "NOT_FOUND", message: "User not found" }
        throw ctx.errors.NotFound("User not found", { userId: input.id });
      }

      return user;
    }
  });
```

## Available Errors

All standard HTTP errors are available via `ctx.errors`:

| Method | Status | Code | Description |
|--------|--------|------|-------------|
| `BadRequest()` | 400 | BAD_REQUEST | Invalid request data |
| `Unauthorized()` | 401 | UNAUTHORIZED | Authentication required |
| `Forbidden()` | 403 | FORBIDDEN | Not allowed to access |
| `NotFound()` | 404 | NOT_FOUND | Resource not found |
| `MethodNotAllowed()` | 405 | METHOD_NOT_ALLOWED | HTTP method not supported |
| `Conflict()` | 409 | CONFLICT | Resource conflict |
| `Gone()` | 410 | GONE | Resource no longer available |
| `UnprocessableEntity()` | 422 | UNPROCESSABLE_ENTITY | Validation failed |
| `TooManyRequests()` | 429 | TOO_MANY_REQUESTS | Rate limited |
| `InternalServer()` | 500 | INTERNAL_SERVER_ERROR | Server error |
| `NotImplemented()` | 501 | NOT_IMPLEMENTED | Feature not implemented |
| `BadGateway()` | 502 | BAD_GATEWAY | Upstream error |
| `ServiceUnavailable()` | 503 | SERVICE_UNAVAILABLE | Service down |
| `GatewayTimeout()` | 504 | GATEWAY_TIMEOUT | Upstream timeout |

## Error Response Format

All errors are returned as JSON with consistent structure:

```json
{
  "error": "NOT_FOUND",
  "message": "User not found",
  "details": { "userId": 123 }
}
```

The `details` field is optional and only included if provided.

## Error Factory Signature

Each error factory has the same signature:

```ts
ctx.errors.NotFound(
  message?: string,        // Custom message (uses default if omitted)
  details?: Record<string, any>,  // Additional context
  cause?: Error            // Original error that caused this
): HttpError
```

## Custom Errors

### Creating Custom Errors at Runtime

Use `ctx.errors.custom()` for one-off custom errors:

```ts
throw ctx.errors.custom(418, "IM_A_TEAPOT", "I'm a teapot");
```

### Registering Custom Errors

Register reusable custom errors that appear on `ctx.errors`:

```ts
// During server setup
const server = new AppServer({ db, port: 3000 });

// Access errors service
server.getCore().errors.register("PaymentRequired", {
  status: 402,
  code: "PAYMENT_REQUIRED",
  defaultMessage: "Payment is required",
});

// Now available everywhere
throw ctx.errors.PaymentRequired("Subscription expired");
```

### Plugin Custom Errors

Plugins can define custom errors that are automatically registered:

```ts
export const paymentPlugin = createPlugin.define({
  name: "payment",
  customErrors: {
    PaymentFailed: {
      status: 402,
      code: "PAYMENT_FAILED",
      defaultMessage: "Payment processing failed",
    },
    InsufficientFunds: {
      status: 402,
      code: "INSUFFICIENT_FUNDS",
      defaultMessage: "Insufficient funds",
    },
    CardDeclined: {
      status: 402,
      code: "CARD_DECLINED",
      defaultMessage: "Card was declined",
    },
  },
  service: async (ctx) => ({
    charge: async (amount: number) => {
      if (amount > 10000) {
        throw ctx.core.errors.InsufficientFunds("Maximum charge amount exceeded");
      }
      // ...
    },
  }),
});
```

After plugin initialization, these errors are available on `ctx.errors`:

```ts
// In any route handler
throw ctx.errors.CardDeclined("Please try a different card");
```

## Type Augmentation for Custom Errors

For TypeScript autocomplete on custom errors, augment the `ErrorFactories` interface:

```ts
// In your plugin or types file
declare module "../core/errors" {
  interface ErrorFactories {
    PaymentFailed: ErrorFactory;
    InsufficientFunds: ErrorFactory;
    CardDeclined: ErrorFactory;
  }
}
```

## Validation Errors

For Zod validation failures, use `createValidationError`:

```ts
import { createValidationError } from "./core/errors";

// Convert Zod errors to HTTP error
const result = schema.safeParse(data);
if (!result.success) {
  throw createValidationError(result.error.issues);
}
```

Response format:

```json
{
  "error": "BAD_REQUEST",
  "message": "Validation Failed",
  "details": {
    "issues": [
      { "path": ["email"], "message": "Invalid email" },
      { "path": ["password"], "message": "Too short" }
    ]
  }
}
```

## Client-Side Error Handling

The API client provides typed error handling:

```ts
import { createApiClient, ApiError, ValidationError, ErrorCodes } from "./client";

const api = createApiClient("http://localhost:3000");

try {
  await api.users.get({ id: 999 });
} catch (error) {
  if (error instanceof ValidationError) {
    // Handle validation errors with field details
    console.log(error.getFieldErrors("email"));
    console.log(error.hasFieldError("password"));
  } else if (error instanceof ApiError) {
    // Handle other API errors
    if (error.is(ErrorCodes.NOT_FOUND)) {
      console.log("User not found");
    } else if (error.is(ErrorCodes.UNAUTHORIZED)) {
      // Redirect to login
    }

    // Access error properties
    console.log(error.status);   // 404
    console.log(error.code);     // "NOT_FOUND"
    console.log(error.message);  // "User not found"
    console.log(error.details);  // { userId: 999 }
  }
}
```

## Error Checking Utility

Check if any error is an HttpError:

```ts
try {
  await someOperation();
} catch (error) {
  if (ctx.errors.isHttpError(error)) {
    // Safe to access error.status, error.code, etc.
    console.log(error.status, error.code);
  } else {
    // Regular JavaScript error
    throw error;
  }
}
```

## Best Practices

### Use Specific Error Types

```ts
// Good - specific error type
throw ctx.errors.NotFound("User not found");

// Avoid - generic error
throw ctx.errors.BadRequest("User not found");
```

### Include Helpful Details

```ts
// Good - includes context for debugging
throw ctx.errors.NotFound("User not found", {
  userId: input.id,
  searchedIn: "users",
});

// Less helpful
throw ctx.errors.NotFound("Not found");
```

### Chain Errors for Debugging

```ts
try {
  await externalService.call();
} catch (e) {
  throw ctx.errors.BadGateway(
    "External service failed",
    { service: "payment-gateway" },
    e as Error  // Preserve original error
  );
}
```

### Handle in Middleware

```ts
export const errorLoggingMiddleware = createMiddleware({
  name: "errorLogger",
  execute: async (req, ctx, next) => {
    try {
      return await next();
    } catch (error) {
      if (ctx.core.errors.isHttpError(error)) {
        ctx.core.logger.warn("HTTP error", {
          status: error.status,
          code: error.code,
          message: error.message,
        });
      } else {
        ctx.core.logger.error("Unhandled error", { error });
      }
      throw error;  // Re-throw for server to handle
    }
  },
});
```
