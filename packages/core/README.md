# `core`

Shared TypeScript primitives that keep the backend and frontend in sync. The package exposes Zod-based route definitions, reusable error classes, JWT helpers, and an API client implementation that understands every route exposed by the ERP API.

## Contents

```
packages/core
├── src/
│   ├── client/            # API client & persistence helpers
│   ├── dates/             # Moment-backed date utilities for UI formatting
│   ├── errors/            # Typed API error factory with HTTP status helpers
│   ├── formatting/        # UI format helpers shared by marketing sites
│   ├── interfaces/        # Route & rate limit abstractions
│   ├── jwt/               # JWT decoding + session normalization
│   ├── routes/            # Zod RouteDefinition instances for every API router
│   └── types/             # Shared TypeScript & Zod schemas
└── index.ts               # Barrel export + base URL/date helpers
```

Key exports:

* **`RouteDefinition` & `RouterDefinition`** – Express-agnostic abstractions used by the API server and the API client to validate input/output and attach metadata such as permissions and rate limits.【F:packages/core/src/interfaces/server/route.ts†L1-L89】【F:packages/core/src/routes/auth/index.ts†L1-L94】
* **`APIErrors`** – Centralized error factory that converts backend failures into serialized responses (and vice versa) so that UIs can surface localized feedback.【F:packages/core/src/errors/index.ts†L1-L130】
* **`APIClient`** – Fetch wrapper that automatically attaches tokens, refreshes sessions, handles PDFs, and translates JSON failures into `ApiError` instances.【F:packages/core/src/client/APIClient.ts†L1-L123】
* **Date helpers** – `timeSinceNowString`, `getFullDateString`, `toUTC`, and related functions for Spanish-localized formatting built on Moment.js.【F:packages/core/src/index.ts†L1-L39】

## Scripts

| Command | Description |
| --- | --- |
| `bun run lint` | Formats with Prettier and fixes linting issues via ESLint. |
| `bun run test` | Executes the Bun test suite for any utilities with coverage. |

## Usage

Add `core` as a workspace dependency and import the primitives you need:

```ts
import { APIRequest, APIClient, authRouter } from "core";

const client = new APIClient("/api");
const { routeDef } = APIRequest.router("auth").route("browserAuthentication");
const response = await client.run({ routeDef, input: { username, otpCode } });
```

The same route definitions power server handlers:

```ts
import { authRouter } from "core";

router.handle("browserAuthentication", async (input, ctx) => {
  const session = await model.login(input, ctx);
  ctx.res.json(authRouter.routes.browserAuthentication.parseResponse(session));
});
```

When you add or modify API routes, update the corresponding files in `src/routes` so that server and client stay in sync.
