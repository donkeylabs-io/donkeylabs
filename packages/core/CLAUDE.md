# Core Package

Shared utilities and type-safe API definitions for both frontend and backend packages in the monorepo.

## Key Components

### Route Definitions
- **Location**: `src/routes/*`
- **Purpose**: Type-safe API route definitions using Zod schemas
- All API routes are defined here and exported via `src/routes/index.ts` as `API`
- Each route includes: path, method, request/response schemas, permissions, and rate limits
- Backend implements these routes, frontend consumes them via APIClient

### APIClient
- **Location**: `src/client/APIClient.ts`
- **Purpose**: Type-safe frontend HTTP client with auto session management
- Usage:
  ```typescript
  const client = new APIClient(baseUrl);

  // Single request
  const request = APIRequest.router('user')
    .route('list')
    .input({ limit: 10 })
    .build();
  const users = await client.run(request);

  // Batch requests (fail-safe)
  const [users, perms] = await client.batch([...]);

  // Parallel requests (fail-fast)
  const [users, perms] = await client.parallel([...]);
  ```
- Handles: session refresh, token expiration, error parsing, callbacks

### Shared Types
- **Location**: `src/types/*`
- JWT types, Express extensions, and other shared interfaces

### Utilities
- **Dates**: `src/dates/` - UTC date handling with moment.js
- **Formatting**: `src/formatting/` - String and number formatting utilities
- **Errors**: `src/errors/` - Standardized API error classes and types
- **JWT**: `src/jwt/` - JWT token utilities and session management

## Adding New Routes

1. Create route file in `src/routes/<domain>/index.ts`
2. Define request/response schemas with Zod
3. Create `RouteDefinition` instances
4. Export router in `src/routes/index.ts`
5. Backend automatically gets types to implement
6. Frontend gets typed client methods

## Dependencies
- `zod` for schema validation
- `jsonwebtoken` for JWT handling
- `moment` for date formatting
- `superjson` for serialization
