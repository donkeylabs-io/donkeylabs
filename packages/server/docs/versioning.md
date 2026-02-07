# API Versioning

Router-level API versioning with semver support. Routes declare a version, the server resolves the best match via the `X-API-Version` header, and deprecated versions send standard sunset headers.

## Quick Start

```ts
import { createRouter, AppServer } from "@donkeylabs/server";
import { z } from "zod";

// Version 1
const usersV1 = createRouter("users", { version: "1.0.0" });
usersV1.route("list").typed({
  output: z.object({ users: z.array(z.object({ id: z.string(), name: z.string() })) }),
  handle: async (_input, ctx) => {
    const users = await ctx.db.selectFrom("users").select(["id", "name"]).execute();
    return { users };
  },
});

// Version 2 - adds email field
const usersV2 = createRouter("users", { version: "2.0.0" });
usersV2.route("list").typed({
  output: z.object({ users: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })) }),
  handle: async (_input, ctx) => {
    const users = await ctx.db.selectFrom("users").select(["id", "name", "email"]).execute();
    return { users };
  },
});

const server = new AppServer({ db, versioning: { defaultBehavior: "latest" } });
server.use(usersV1);
server.use(usersV2);
```

**Client requests:**
```sh
# Get latest version (v2)
curl -X POST http://localhost:3000/users.list

# Request specific version
curl -X POST http://localhost:3000/users.list -H "X-API-Version: 1"

# Request minor version
curl -X POST http://localhost:3000/users.list -H "X-API-Version: 2.0"
```

---

## Server Configuration

Configure versioning behavior in `AppServer`:

```ts
const server = new AppServer({
  db,
  versioning: {
    // What to do when no X-API-Version header is sent
    defaultBehavior: "latest",  // "latest" | "unversioned" | "error"

    // Echo the resolved version back in the response header
    echoVersion: true,

    // Custom header name (default: "X-API-Version")
    headerName: "X-API-Version",
  },
});
```

### Default Behavior Options

| Value | Behavior |
|-------|----------|
| `"latest"` | No version header = use highest registered version (default) |
| `"unversioned"` | No version header = only match routes without a version |
| `"error"` | No version header = return `VERSION_REQUIRED` error |

---

## Router Options

### Setting a Version

```ts
const router = createRouter("users", { version: "2.1.0" });
```

Version strings follow semver format: `major.minor.patch`. All three components are optional:

```ts
createRouter("users", { version: "2" });      // Interpreted as 2.0.0
createRouter("users", { version: "2.1" });    // Interpreted as 2.1.0
createRouter("users", { version: "2.1.3" });  // Exact
```

### Deprecating a Version

```ts
const usersV1 = createRouter("users", {
  version: "1.0.0",
  deprecated: {
    sunsetDate: "2025-06-01",
    message: "Use v2 for expanded user fields",
    successor: "2.0.0",
  },
});
```

When a deprecated version is resolved, the response includes standard headers:

```
Sunset: 2025-06-01
Deprecation: true
X-Deprecation-Notice: Use v2 for expanded user fields. Upgrade to 2.0.0.
```

### Child Router Inheritance

Child routers inherit the parent's version unless they override it:

```ts
const api = createRouter("api", { version: "2.0.0" });

// Inherits version 2.0.0
const users = api.router("users");

// Overrides with its own version
const legacy = api.router("legacy");
// (set version on the legacy router directly if needed)
```

---

## Version Resolution

The `X-API-Version` header supports flexible matching:

| Header Value | Matches |
|-------------|---------|
| `"2"` | Highest 2.x.x version |
| `"2.1"` | Highest 2.1.x version |
| `"2.1.3"` | Exact match only |
| `"2.x"` | Highest 2.x.x (wildcard) |
| `"2.1.x"` | Highest 2.1.x (wildcard) |
| (none) | Depends on `defaultBehavior` config |

### Resolution Algorithm

1. Parse the requested version string
2. Filter registered versions that satisfy the request
3. Sort by semver (highest first)
4. Return the highest match, or `null` if none

```ts
// Registered: 1.0.0, 2.0.0, 2.1.0, 3.0.0
// Request "2"   → resolves to 2.1.0 (highest 2.x)
// Request "2.0" → resolves to 2.0.0 (exact minor)
// Request "3"   → resolves to 3.0.0
// Request "4"   → null (no match)
```

---

## Backward Compatibility

Unversioned routers continue to work exactly as before:

```ts
// No version = always matches when no X-API-Version header is sent
const router = createRouter("health");
router.route("ping").typed({
  handle: async () => ({ ok: true }),
});
```

Unversioned routes are stored in a separate fast-path map and are never affected by version resolution. Existing applications require **zero changes** to adopt versioning.

---

## Client Usage

### TypeScript Client

```ts
import { createApiClient } from "./client";

// Pin client to a specific API version
const api = createApiClient({
  baseUrl: "http://localhost:3000",
  apiVersion: "2",
});

// All requests include X-API-Version: 2
const users = await api.users.list();
```

### Test Harness

```ts
const { api } = await createTestHarness(server);

// Call with a specific version
const result = await api.call("users.list", {}, { version: "1" });
```

### `callRoute` (Server-Side)

```ts
// Call a specific version from within the server
const result = await server.callRoute("users.list", input, ip, { version: "2" });
```

---

## Semver Utilities

The versioning module exports utilities for working with semver strings:

```ts
import { parseSemVer, compareSemVer, resolveVersion } from "@donkeylabs/server";

// Parse a version string
const v = parseSemVer("2.1.3");
// { major: 2, minor: 1, patch: 3, raw: "2.1.3" }

// Compare two versions
compareSemVer(parseSemVer("1.0.0")!, parseSemVer("2.0.0")!); // -1

// Resolve best match from a list
const versions = ["1.0.0", "2.0.0", "2.1.0"].map(v => parseSemVer(v)!);
resolveVersion(versions, "2"); // Returns 2.1.0
```

### Exported Types

```ts
interface SemVer {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

interface VersioningConfig {
  defaultBehavior?: "latest" | "unversioned" | "error";
  echoVersion?: boolean;
  headerName?: string;
}

interface DeprecationInfo {
  sunsetDate?: string;
  message?: string;
  successor?: string;
}

interface RouterOptions {
  version?: string;
  deprecated?: DeprecationInfo;
}
```

---

## Code Generation

When running `donkeylabs generate`, versioned routes include version metadata in `RouteInfo`:

```ts
{
  name: "users.list",
  handler: "typed",
  version: "2.0.0",
  deprecated: false,
  // ...
}
```

This metadata is available to all adapters (TypeScript, SvelteKit, Swift) for client generation.

---

## Real-World Example

### Multi-Version API with Deprecation

```ts
import { createRouter, AppServer } from "@donkeylabs/server";
import { z } from "zod";

// V1 - deprecated, sunset June 2025
const v1 = createRouter("orders", {
  version: "1.0.0",
  deprecated: {
    sunsetDate: "2025-06-01",
    message: "V1 returns flat totals. Use V2 for itemized pricing.",
    successor: "2.0.0",
  },
});

v1.route("get").typed({
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), total: z.number() }),
  handle: async (input, ctx) => {
    const order = await ctx.plugins.orders.get(input.id);
    return { id: order.id, total: order.total };
  },
});

// V2 - current
const v2 = createRouter("orders", { version: "2.0.0" });

v2.route("get").typed({
  input: z.object({ id: z.string() }),
  output: z.object({
    id: z.string(),
    items: z.array(z.object({ name: z.string(), price: z.number(), qty: z.number() })),
    subtotal: z.number(),
    tax: z.number(),
    total: z.number(),
  }),
  handle: async (input, ctx) => {
    return ctx.plugins.orders.getDetailed(input.id);
  },
});

// Server
const server = new AppServer({
  db,
  versioning: { defaultBehavior: "latest", echoVersion: true },
});

server.use(v1);
server.use(v2);
```

```sh
# V1 response includes deprecation headers
curl -X POST http://localhost:3000/orders.get \
  -H "X-API-Version: 1" \
  -d '{"id": "order-123"}'
# Response headers:
#   X-API-Version: 1.0.0
#   Sunset: 2025-06-01
#   Deprecation: true
#   X-Deprecation-Notice: V1 returns flat totals. Use V2 for itemized pricing. Upgrade to 2.0.0.

# V2 response (default)
curl -X POST http://localhost:3000/orders.get \
  -d '{"id": "order-123"}'
# Response header: X-API-Version: 2.0.0
```
