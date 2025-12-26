# Bun Server Core

Bun-specific server utilities and infrastructure for building Express-based APIs. This package provides battle-tested building blocks that handle routing, middleware, database management, caching, auth, and more.

## Key Components

### Server
- **Location**: [src/server.ts](src/server.ts)
- **Purpose**: Express server bootstrapper with standard middleware
- Handles: JSON parsing, CORS, static assets, request logging, error handling
- Usage:
  ```typescript
  import { Server } from "bun-server-core";

  const server = new Server(dependencies, allowedOrigins);
  server.registerRouter(() => myRouter);
  server.listen(8000);
  ```

### MagikRouter
- **Location**: [src/router/index.ts](src/router/index.ts)
- **Purpose**: Bridges `core` route definitions to Express handlers
- Features: Type-safe handlers, automatic rate limiting, request context injection
- Usage:
  ```typescript
  import { MagikRouter } from "bun-server-core";
  import { authRouter } from "core";

  const auth = new MagikRouter(authRouter, cache);
  auth.handle("login", async (input, ctx) => {
    const session = await authModel.login(input, ctx);
    ctx.res.json(session);
  });
  ```

### Database Utilities
- **Location**: [src/db/index.ts](src/db/index.ts)
- **Exports**: `buildDB`, `buildInstrumentedDB`, `buildMigrator`, `tableCount`, `paginationData`
- SQLite + Kysely configuration for Bun
- Instrumented DB logs slow queries for observability
- Usage:
  ```typescript
  import { buildDB, buildMigrator } from "bun-server-core";

  const db = buildDB<DB>("./db/storage.sqlite");
  const migrator = buildMigrator(db, "./db/migrations");
  await migrator.migrateToLatest();
  ```

### Cache & Rate Limiting
- **Location**: [src/cache/index.ts](src/cache/index.ts)
- **Class**: `SimpleCache`
- SQLite-backed JSON cache with automatic cleanup
- Powers per-route rate limiting
- Usage:
  ```typescript
  import { SimpleCache } from "bun-server-core";

  const cache = new SimpleCache(db);
  await cache.set("key", { data: "value" }, 3600); // 1 hour TTL
  const value = await cache.get("key");
  ```

### Middleware
- **Location**: [src/middleware/index.ts](src/middleware/index.ts)
- Request logging with timing and metadata
- Rate limiting per IP/route
- Request timeout enforcement
- Error handling and ApiError translation
- All pre-configured in `Server` class

### Auth Utilities
- **JWT**: [src/jwt/jwt.ts](src/jwt/jwt.ts) - Sign and verify tokens
- **OTP**: [src/otp/otp.ts](src/otp/otp.ts) - TOTP generation, QR codes
- **Encryption**: [src/encryption/encryption.ts](src/encryption/encryption.ts) - Symmetric encryption for secrets

### HTTP Utilities
- **Location**: [src/http/](src/http/)
- **resilient-fetch**: Retry logic with exponential backoff
- **circuit-breaker**: Circuit breaker pattern for external APIs
- Protects services from cascading failures

## Available Scripts

Database migration management (consumed by downstream packages):

```typescript
import {
  createMigrationScript,
  runMigrationsUp,
  runMigrationsDown,
  runMigrationsToLatest,
  syncPermissions
} from "bun-server-core";

// Create new migration
await createMigrationScript("./db/migrations");

// Run migrations
await runMigrationsUp(db, migrator);
await runMigrationsDown(db, migrator);
await runMigrationsToLatest(db, migrator);

// Sync permissions (if using RBAC)
await syncPermissions(db, permissionDefs);
```

## Testing

- All features have unit tests in `src/*/test/` directories
- Shared test utilities exported from `src/test/index.ts`
- Run tests: `bun test` from package directory

## Dependencies

- `express` - Web framework
- `kysely` + `kysely-bun-sqlite` - Database ORM
- `jsonwebtoken` - JWT handling
- `otplib` - TOTP/2FA
- `cors` - CORS middleware
- `audit-logs` - Structured logging (workspace package)
- `core` - Shared route definitions (workspace package)

## Architecture Pattern

This package implements the infrastructure layer. Domain packages (like `api.pitsafrp.com`) use these utilities to build business logic without reimplementing auth, routing, caching, etc.
