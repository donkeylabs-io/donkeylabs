# Custom Services

Custom services allow you to register application-specific dependencies that integrate with the server's context system. Services are available in route handlers via `ctx.services` with full type inference.

## Overview

Use custom services when you need to:
- Initialize app-specific classes that depend on plugins
- Share stateful instances across route handlers
- Integrate third-party SDKs with type safety
- Create domain-specific facades over core services

## Defining a Service

Use `defineService()` to create a type-safe service definition:

```typescript
// src/server/services/nvr.ts
import { defineService } from "@donkeylabs/server";
import { NVRClient } from "./nvr-client";

export const nvrService = defineService("nvr", async (ctx) => {
  // Access plugins, db, core services during initialization
  const nvr = new NVRClient({
    authProvider: ctx.plugins.auth,
    logger: ctx.core.logger,
  });

  await nvr.connect();
  return nvr;
});
```

The factory function receives `HookContext` which provides:
- `ctx.db` - Database instance (Kysely)
- `ctx.core` - Core services (logger, cache, events, jobs, etc.)
- `ctx.plugins` - Plugin services
- `ctx.config` - Server configuration
- `ctx.services` - Other registered services

## Registering Services

Register services with the server before starting:

```typescript
// src/server/index.ts
import { AppServer } from "@donkeylabs/server";
import { nvrService } from "./services/nvr";
import { analyticsService } from "./services/analytics";

const server = new AppServer({ db, port: 3000 });

// Register using service definition (recommended)
server.registerService(nvrService);
server.registerService(analyticsService);

// Or register inline
server.registerService("cache-warmer", async (ctx) => {
  return new CacheWarmer(ctx.core.cache);
});

await server.start();
```

## Using Services in Routes

Services are available via `ctx.services` in route handlers:

```typescript
router.route("recordings").typed({
  input: z.object({ cameraId: z.string() }),
  output: recordingsSchema,
  handle: async (input, ctx) => {
    // Fully typed - ctx.services.nvr has proper type inference
    return ctx.services.nvr.getRecordings(input.cameraId);
  },
});
```

## Type Generation

When you run `donkeylabs generate`, the CLI scans for `defineService()` calls and generates types automatically. The generated `ServiceRegistry` interface includes all your services:

```typescript
// Generated in context.d.ts
declare module "@donkeylabs/server" {
  interface ServiceRegistry {
    nvr: NVRClient;
    analytics: AnalyticsService;
  }
}
```

### Service Definition Locations

The CLI scans these locations for service definitions:
- `src/server/services/*.ts`
- `src/lib/services/*.ts`
- Server entry file (e.g., `src/server/index.ts`)

## Runtime Registration

You can also register services at runtime in `onReady` hooks:

```typescript
server.onReady(async (ctx) => {
  // Initialize something that needs the full context
  const dashboard = new AdminDashboard(ctx.plugins, ctx.core);
  await dashboard.initialize();

  // Register it as a service
  ctx.setService("dashboard", dashboard);
});
```

Services registered via `setService()` are immediately available but won't have generated types (use `defineService()` for type generation).

## Service Dependencies

Services can depend on other services by accessing them in the factory:

```typescript
export const reportService = defineService("reports", async (ctx) => {
  // Depend on another service (must be registered first)
  const analytics = ctx.services.analytics;

  return new ReportGenerator(analytics, ctx.core.cache);
});
```

**Important:** Register services in dependency order. If service B depends on service A, register A first.

## Best Practices

### 1. Keep Services Focused
Each service should have a single responsibility:

```typescript
// Good - focused service
export const emailService = defineService("email", (ctx) => ({
  send: (to, subject, body) => sendEmail(to, subject, body),
  sendTemplate: (to, template, data) => sendTemplate(to, template, data),
}));

// Avoid - too many responsibilities
export const everythingService = defineService("everything", (ctx) => ({
  sendEmail: ...,
  processPayment: ...,
  generateReport: ...,
}));
```

### 2. Handle Cleanup
If your service needs cleanup, use `onShutdown`:

```typescript
export const connectionPoolService = defineService("pool", async (ctx) => {
  const pool = await createPool();

  // Register cleanup
  // Note: You'll need to handle this in your server setup
  return pool;
});

// In server setup
server.registerService(connectionPoolService);
server.onShutdown(async () => {
  await server.getServices().pool?.close();
});
```

### 3. Use Plugins for Reusable Logic
Services are app-specific. For reusable business logic, use plugins instead:

```typescript
// Use a plugin for reusable auth logic
export const authPlugin = createPlugin.define({
  name: "auth",
  service: (ctx) => ({ ... }),
});

// Use a service for app-specific integrations
export const myAppService = defineService("myApp", (ctx) => {
  // Uses the auth plugin
  return new MyAppIntegration(ctx.plugins.auth);
});
```

## Example: Full Service Setup

```typescript
// services/analytics.ts
import { defineService } from "@donkeylabs/server";
import { AnalyticsSDK } from "analytics-sdk";

export class AnalyticsService {
  private sdk: AnalyticsSDK;

  constructor(apiKey: string, logger: Logger) {
    this.sdk = new AnalyticsSDK(apiKey);
    this.logger = logger;
  }

  track(event: string, properties: Record<string, any>) {
    this.logger.debug("Tracking event", { event, properties });
    return this.sdk.track(event, properties);
  }

  identify(userId: string, traits: Record<string, any>) {
    return this.sdk.identify(userId, traits);
  }
}

export const analyticsService = defineService("analytics", (ctx) => {
  const apiKey = ctx.config.analyticsApiKey;
  if (!apiKey) {
    ctx.core.logger.warn("Analytics API key not configured");
    return null;
  }

  return new AnalyticsService(apiKey, ctx.core.logger);
});
```

```typescript
// server/index.ts
import { AppServer } from "@donkeylabs/server";
import { analyticsService } from "./services/analytics";

const server = new AppServer({
  db,
  port: 3000,
  config: {
    analyticsApiKey: process.env.ANALYTICS_API_KEY,
  },
});

server.registerService(analyticsService);

// Use in routes
router.route("signup").typed({
  input: signupSchema,
  output: userSchema,
  handle: async (input, ctx) => {
    const user = await ctx.plugins.users.create(input);

    // Track signup event
    ctx.services.analytics?.track("user.signup", {
      userId: user.id,
      email: user.email,
    });

    return user;
  },
});
```
