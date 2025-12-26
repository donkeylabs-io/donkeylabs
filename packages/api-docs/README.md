# @pitsa/api-docs

Automatic API documentation generator for the Pitsa VPS monorepo. This package generates comprehensive documentation from route definitions in the `core` package, making it easy to maintain up-to-date API documentation that stays in sync with your actual implementation.

## Overview

The `api-docs` package analyzes route definitions from the `core` package and generates structured documentation including:

- **Route Definitions**: Path, HTTP method, and endpoint information
- **Request/Response Schemas**: Full type documentation with validation constraints
- **Permissions**: Required permissions for each endpoint
- **Rate Limiting**: Rate limit configurations and thresholds
- **SDK Examples**: Code examples showing how to call endpoints using the APIClient

This documentation is automatically generated and exported as JSON, making it consumable by frontend applications, documentation sites, or other tools.

## Quick Start

### Installation

This package is part of the monorepo and is available as a workspace dependency.

```json
{
  "dependencies": {
    "api-docs": "workspace:*"
  }
}
```

### Generate Documentation

Run the documentation generator script:

```bash
bun run generate
```

This command:
1. Parses all route definitions from the `core` package
2. Extracts schema information, permissions, and rate limits
3. Generates code examples from SDK calls
4. Outputs comprehensive documentation to `packages/app.pitsafrp.com/static/api-docs.json`
5. Displays a summary of the generated documentation

Example output:
```
API Documentation Generated
============================
Total Routers: 5
Total Routes: 42

Routes by Method:
  GET: 15
  POST: 18
  PUT: 5
  DELETE: 4

Output: /path/to/packages/app.pitsafrp.com/static/api-docs.json
Generated at: 2024-12-17T10:30:00Z
```

## Package Structure

```
packages/api-docs/
├── src/
│   ├── index.ts              # Main exports
│   ├── types.ts              # TypeScript type definitions for documentation
│   ├── schema-parser.ts      # Parses Zod/TypeScript schemas into documentation
│   ├── route-generator.ts    # Generates route documentation from route definitions
│   └── code-generator.ts     # Generates SDK code examples
├── scripts/
│   └── generate.ts           # CLI script to generate documentation
├── package.json              # Package configuration
└── README.md                 # This file
```

## Core Concepts

### SchemaDoc

Represents the structure of a request or response with full type information:

```typescript
interface SchemaDoc {
  type: SchemaFieldType;           // The base type (string, number, object, etc.)
  isOptional: boolean;              // Whether the field is optional
  isNullable: boolean;              // Whether the field can be null
  description?: string;             // Human-readable description
  defaultValue?: unknown;           // Default value if any
  constraints?: SchemaConstraints;  // Validation constraints
  children?: Record<string, SchemaDoc>;  // Nested fields (for objects)
  itemType?: SchemaDoc;             // Item type (for arrays)
}
```

### RouteDoc

Documents a single API endpoint:

```typescript
interface RouteDoc {
  routerName: string;         // Name of the router (e.g., "orders")
  routeName: string;          // Name of the route (e.g., "createOrder")
  path: string;               // URL path (e.g., "/api/orders")
  method: "get" | "post" | "put" | "delete" | "patch";
  permissions: string[];      // Required permissions to access this route
  rateLimit?: RateLimitDoc;   // Rate limiting configuration
  request: SchemaDoc;         // Request schema
  response: SchemaDoc;        // Response schema
  sdkExample: string;         // Code example using the SDK
}
```

### ApiDocs

The complete documentation structure:

```typescript
interface ApiDocs {
  routers: RouterDoc[];       // All routers and their routes
  generatedAt: string;        // ISO timestamp of generation
  version: string;            // API version
}
```

## Usage Examples

### Consuming Generated Documentation

The generated documentation is exported as JSON and can be consumed by your frontend application:

```typescript
// In your frontend app
import apiDocs from './static/api-docs.json';

// Access route information
const orderRoutes = apiDocs.routers.find(r => r.name === 'orders');
const createOrderRoute = orderRoutes.routes.find(r => r.routeName === 'createOrder');

console.log(`Endpoint: ${createOrderRoute.method.toUpperCase()} ${createOrderRoute.path}`);
console.log(`Required Permissions: ${createOrderRoute.permissions.join(', ')}`);
```

### Building Documentation UI

Create interactive documentation pages from the generated JSON:

```typescript
// Generate a documentation page for all endpoints
apiDocs.routers.forEach(router => {
  router.routes.forEach(route => {
    // Display route details, parameters, responses, examples
  });
});
```

### Type-Safe Documentation

The generated schema documentation preserves full type information, allowing you to create type-safe helpers:

```typescript
// Validate request data against schema documentation
function validateRequest(routePath: string, data: unknown): ValidationResult {
  const route = findRouteByPath(routePath);
  return validateAgainstSchema(data, route.request);
}
```

## How It Works

### 1. Route Definition Parsing

The generator reads route definitions from the `core` package, which follow the Pitsa API pattern. Each route is defined with:
- HTTP method and path
- Request and response schemas (typically Zod schemas)
- Permission requirements
- Rate limiting configuration

### 2. Schema Analysis

The `schema-parser.ts` module:
- Parses TypeScript/Zod schema definitions
- Extracts field types, constraints, and descriptions
- Builds a nested structure representing complex types
- Generates readable descriptions for each field

### 3. Route Documentation Generation

The `route-generator.ts` module:
- Iterates through all routes in the API definition
- Generates documentation for each route
- Includes request/response schemas
- Extracts permission and rate limit information
- Compiles statistics about the API

### 4. Code Example Generation

The `code-generator.ts` module:
- Creates SDK usage examples for each route
- Shows proper TypeScript usage
- Demonstrates error handling patterns
- Makes it easy for developers to understand how to use each endpoint

## Dependencies

- **core**: The core package containing route definitions and types
- **zod**: For schema validation and type inference
- **shiki**: For syntax highlighting in code examples (if applicable)
- **typescript**: For type checking during development

## Development

### Building

This is a TypeScript package. No build step is required for development since Bun supports TypeScript natively.

### Adding New Features

To extend the documentation generator:

1. Add new types to `src/types.ts`
2. Extend parsers in `src/schema-parser.ts` for new schema types
3. Add route analysis logic to `src/route-generator.ts`
4. Enhance code generation in `src/code-generator.ts`

## Integration

The generated documentation is automatically output to `packages/app.pitsafrp.com/static/api-docs.json`, making it available to the frontend application for display in documentation pages or API explorers.

## Future Enhancements

Planned features for the api-docs package:

- [ ] OpenAPI/Swagger specification generation
- [ ] Interactive API explorer component
- [ ] Markdown documentation output
- [ ] Changelog generation from API changes
- [ ] Client library generation from schema definitions

## License

Part of the Pitsa VPS monorepo.
