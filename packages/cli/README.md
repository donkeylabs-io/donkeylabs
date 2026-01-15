# @donkeylabs/cli

CLI tool for `@donkeylabs/server` - project scaffolding and code generation.

## Installation

```bash
bun add -D @donkeylabs/cli
```

Or install globally:

```bash
bun add -g @donkeylabs/cli
```

## Commands

### Interactive Mode

Run without arguments for an interactive menu:

```bash
donkeylabs
```

### Initialize Project

Create a new project:

```bash
# Interactive project setup
donkeylabs init

# Server-only project
donkeylabs init --type server

# SvelteKit + adapter project
donkeylabs init --type sveltekit

# Initialize in specific directory
donkeylabs init my-project
```

### Generate Types

Generate TypeScript types from your plugins and routes:

```bash
donkeylabs generate
# or
donkeylabs gen
```

This generates:
- `registry.d.ts` - Plugin registry types
- `context.d.ts` - App context with merged schemas
- `routes.ts` - Route input/output types
- `client.ts` - API client (or adapter-specific client)

### Plugin Management

Create and manage plugins:

```bash
# Create a new plugin (interactive)
donkeylabs plugin create

# Create a named plugin
donkeylabs plugin create auth

# List plugins
donkeylabs plugin list
```

## Configuration

Create a `donkeylabs.config.ts` in your project root:

```typescript
import { defineConfig } from "@donkeylabs/server";

export default defineConfig({
  // Glob patterns for plugin files
  plugins: ["./src/plugins/**/index.ts"],

  // Generated types output directory
  outDir: ".@donkeylabs/server",

  // Server entry file (for route extraction)
  entry: "./src/index.ts",

  // Optional: Client generation
  client: {
    output: "./src/client/api.ts",
  },

  // Optional: Adapter for framework-specific generation
  adapter: "@donkeylabs/adapter-sveltekit",
});
```

## Context-Aware Menus

The interactive mode is context-aware:

**From project root:**
- Create New Plugin
- Initialize New Project
- Generate Types
- Generate Registry
- Generate Server Context

**From inside a plugin directory (`src/plugins/<name>/`):**
- Generate Schema Types
- Create Migration
- Back to Global Menu

## Templates

The CLI includes starter templates:

- `templates/starter` - Basic server project
- `templates/sveltekit-app` - Full SvelteKit + adapter project

## Usage with package.json

Add scripts to your `package.json`:

```json
{
  "scripts": {
    "gen:types": "donkeylabs generate",
    "new:plugin": "donkeylabs plugin create"
  }
}
```

## License

MIT
