# `bun-server-core`

Reusable building blocks for Bun-based Express services. The package wraps common infrastructure such as routing, rate limiting, instrumentation, OTP utilities, and caching so that application packages can stay focused on domain logic.

## Features

* **Express bootstrapper** – `Server` wires up JSON parsing, raw body preservation, static assets, CORS, and request logging before attaching routers.【F:packages/bun-server-core/src/server.ts†L1-L46】【F:packages/bun-server-core/src/middleware/index.ts†L1-L87】
* **Router glue** – `MagikRouter` bridges `core` route definitions to Express handlers, injects contextual metadata, and enforces rate limits per-route via the shared cache.【F:packages/bun-server-core/src/router/index.ts†L1-L70】
* **Cache & rate limiting** – `SimpleCache` persists JSON payloads in SQLite and powers rate-limiting state with automatic cleanup timers.【F:packages/bun-server-core/src/cache/index.ts†L1-L73】
* **Database helpers** – `buildDB`, `buildInstrumentedDB`, and `buildMigrator` encapsulate Bun-friendly SQLite/Kysely configuration and log slow queries for observability.【F:packages/bun-server-core/src/db/index.ts†L1-L46】【F:packages/bun-server-core/src/db/instrumentation.ts†L1-L27】
* **OTP utilities** – Generate and validate TOTP secrets and QR codes for authenticator apps shared between API and frontend packages.【F:packages/bun-server-core/src/otp/otp.ts†L1-L18】
* **Centralized error handling** – Translate thrown `ApiError`s into HTTP responses and provide sane fallbacks for unexpected failures.【F:packages/bun-server-core/src/middleware/errors.ts†L1-L24】

## Directory overview

```
packages/bun-server-core
├── src/
│   ├── cache/           # SQLite-backed cache + rate limit storage
│   ├── db/              # BunSqlite dialect helpers, migrations, instrumentation
│   ├── encryption/      # Symmetric encryption helpers (for secrets at rest)
│   ├── jwt/             # Token helpers mirrored on the frontend
│   ├── middleware/      # Logging, rate limiting, and error handling
│   ├── otp/             # TOTP utilities and QR generation
│   ├── router/          # MagikRouter implementation
│   ├── stats/           # Request/system metrics collector
│   └── test/            # Reusable testing harness for API packages
└── index.ts             # Barrel exports used by downstream packages
```

## Scripts

This package exposes utilities and does not define runtime scripts. Tests are typically executed from downstream packages (such as the API) using the shared helpers.

## Using the router helper

```ts
import { Server, MagikRouter } from "bun-server-core";
import { authRouter } from "core";

const server = new Server(dependencies, allowedOrigins);
const auth = new MagikRouter(authRouter, cache);

auth.handle("browserAuthentication", async (input, ctx) => {
  const session = await authModel.login(input, ctx);
  ctx.res.json(session);
});

server.registerRouter(() => auth);
server.listen(8000);
```

For advanced usage (instrumented databases, cron-powered services, caching strategies), see the API package README.
