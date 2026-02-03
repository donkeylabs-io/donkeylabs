# Development Experience Guide

This guide covers the development workflow, hot reload system, and tooling for DonkeyLabs framework.

## Table of Contents

- [Hot Reload System](#hot-reload-system)
- [Dev Server Modes](#dev-server-modes)
- [File Watching](#file-watching)
- [Type Generation](#type-generation)
- [Debugging Utilities](#debugging-utilities)
- [Performance Optimization](#performance-optimization)
- [VS Code Integration](#vs-code-integration)

---

## Hot Reload System

The framework provides sophisticated hot reload capabilities that dramatically speed up development.

### What Gets Hot Reloaded

| Component | Hot Reload Support | Trigger | Notes |
|-----------|-------------------|---------|-------|
| Route handlers | ✅ Yes | File save in routes/ | Instant, no server restart |
| Route schemas | ✅ Yes | File save | Requires type regeneration |
| Plugin service methods | ⚠️ Partial | File save | Type regen needed for full typing |
| Plugin structure changes | ❌ No | N/A | Requires full restart |
| Middleware | ✅ Yes | File save | Instant |
| Database migrations | ⚠️ Partial | Migration added | Auto-runs migration + type gen |
| Generated types | ✅ Auto | Source changes | Triggered by file watcher |

### How Hot Reload Works

**In-Process Mode** (`bun --bun run dev`):

1. Vite's file watcher detects changes in `src/server/`
2. Route files are identified by glob pattern `**/routes/**/*.ts`
3. Changed module is invalidated in Vite's cache
4. Module is re-imported with cache-busting query param
5. `appServer.reloadRouter(prefix, newRouter)` updates the route map
6. Changes are immediately available without restart

```typescript
// From packages/adapter-sveltekit/src/vite.ts
async function hotReloadRoute(filepath: string) {
  // 1. Invalidate Vite module cache
  const mod = viteServer.moduleGraph.getModuleById(filepath);
  if (mod) viteServer.moduleGraph.invalidateModule(mod);

  // 2. Re-import with timestamp
  const freshModule = await viteServer.ssrLoadModule(`${filepath}?t=${Date.now()}`);

  // 3. Extract router from exports
  let newRouter = freshModule.router || freshModule.default;
  
  // 4. Hot swap in app server
  if (newRouter && prefix) {
    appServer.reloadRouter(prefix, newRouter);
    console.log("[donkeylabs-dev] Route hot reload complete:", prefix);
  }
}
```

### Hot Reload Limitations

**Plugin structure changes** (adding new methods, changing signatures):
- Changes require full type regeneration
- May need server restart if plugin initialization changed
- Run `bun run gen:types` after structure changes

**Database schema changes**:
- Migrations are detected and auto-run
- Schema types are regenerated
- But plugin may need restart to see new table types

**Configuration changes**:
- `donkeylabs.config.ts` changes require restart
- Environment variable changes require restart

---

## Dev Server Modes

The framework supports two development server modes:

### In-Process Mode (Recommended)

```bash
bun --bun run dev
```

**Architecture:**
```
┌─────────────────────────────────────────────┐
│              Vite Dev Server                │
│  ┌──────────────────────────────────────┐   │
│  │   @donkeylabs/server (in-process)    │   │
│  │   - Runs in same Bun process         │   │
│  │   - Shares event loop with Vite      │   │
│  │   - Direct middleware integration    │   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │        SvelteKit (Vite plugin)       │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
         ↓ Single port (e.g., 5173)
```

**Advantages:**
- 🚀 **Fastest performance**: No inter-process communication
- 🔄 **Full hot reload**: All features work
- 📦 **Single port**: No CORS, no proxy issues
- 🧠 **Shared memory**: SSR can directly call server methods
- ⚡ **Instant startup**: No process spawning

**How it works:**
1. Vite loads the `@donkeylabs/adapter-sveltekit` plugin
2. Plugin detects Bun runtime (`typeof globalThis.Bun !== "undefined"`)
3. Server entry file is imported directly (not spawned)
4. Server initializes but doesn't start HTTP server
5. Vite middleware stack gets custom handler for API routes
6. API requests are handled in-process via middleware

### Subprocess Mode (Fallback)

```bash
bun run dev
```

**Architecture:**
```
┌─────────────────────────────────────────────┐
│              Vite Dev Server                │
│  ┌──────────────────────────────────────┐   │
│  │        SvelteKit (Vite plugin)       │   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │      Proxy Middleware (port 5173)    │   │
│  │   - Intercepts /api/* requests       │   │
│  │   - Forwards to backend process      │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
         ↓ HTTP Proxy
┌─────────────────────────────────────────────┐
│        Backend Server (port 3001)           │
│  ┌──────────────────────────────────────┐   │
│  │   @donkeylabs/server (subprocess)    │   │
│  │   - Spawned via Bun child_process    │   │
│  │   - Runs full HTTP server            │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

**Use when:**
- Not using Bun runtime
- Debugging backend separately
- Need isolated backend process

**Limitations:**
- Requires two ports
- Proxy overhead
- Hot reload works but is slower
- SSR calls require HTTP instead of direct

---

## File Watching

The framework has multiple file watchers for different purposes:

### 1. Route/Type Watcher (Vite Plugin)

**Location:** `packages/adapter-sveltekit/src/vite.ts`

**Watches:** `src/server/**/*.ts` (configurable)

**Triggers:**
- Route file changes → Hot reload
- Any `.ts` file → Type regeneration

**Config:**
```typescript
// vite.config.ts
donkeylabsDev({
  watchDir: "./src/server",        // Watch this directory
  watchTypes: true,                 // Auto-generate types
  hotReloadRoutes: true,            // Enable hot reload
  routePatterns: ["**/routes/**/*.ts"], // Route file glob
})
```

### 2. Plugin Watcher (CLI Script)

**Location:** `packages/cli/scripts/watcher.ts`

**Usage:**
```bash
# Watch a specific plugin for changes
bun scripts/watcher.ts users
```

**Watches:** Individual plugin directory

**Triggers:**
- `migrations/*.ts` changes → Generate schema types
- `index.ts` changes → Regenerate registry

**Why use it:**
- Focused watching for plugin development
- Prevents unnecessary type regeneration
- Better performance than full watcher

### 3. Migration Watcher

**Triggers:**
- New migration file created
- Migration modified

**Actions:**
1. Runs `bun scripts/generate-types.ts <plugin>`
2. Generates `schema.ts` with Kysely types
3. Updates plugin `index.ts` to import schema
4. Regenerates registry

**Debouncing:**
- 500ms debounce to batch rapid changes
- 2s cooldown after generation to prevent loops

---

## Type Generation

Type generation is automatic but can be triggered manually:

### Auto-Generation (Dev Mode)

**Triggers:**
- File changes in watched directories
- Migration file added
- Plugin structure modified

**Generated files:**
- `registry.d.ts` - Plugin registry types
- `context.d.ts` - App context with merged schemas
- `routes.ts` - Route input/output types
- `client.ts` or `api.ts` - API client

### Manual Generation

```bash
# Generate all types
bun run gen:types

# Or via CLI
bunx donkeylabs generate

# Generate for specific plugin
bun scripts/generate-types.ts users
```

### Generation Pipeline

```
1. Parse all plugin index.ts files
   ↓
2. Extract schema types (if withSchema used)
   ↓
3. Merge schemas from all plugins
   ↓
4. Generate registry.d.ts (PluginRegistry augmentation)
   ↓
5. Generate context.d.ts (GlobalContext with merged DB)
   ↓
6. Extract route definitions from route files
   ↓
7. Generate route types (input/output validation)
   ↓
8. Generate API client with full typing
```

**Time:** ~1-3 seconds for typical project

---

## Debugging Utilities

### Debug Logging

Enable detailed logging:

```typescript
// src/server/index.ts
const server = new AppServer({
  logger: { level: "debug" },
});
```

**Log prefixes:**
- `[donkeylabs-dev]` - Dev server activity
- `[donkeylabs-hot-reload]` - Hot reload events
- `[plugin-name]` - Plugin-specific logs

### Dev Server Logs

When running `bun --bun run dev`:

```
[donkeylabs-dev] Starting in-process mode (Bun runtime detected)
[donkeylabs-dev] Watching src/server for type generation, hot reload...
[donkeylabs-dev] Server initialized (in-process mode)
[donkeylabs-dev] Ready at http://localhost:5173

[donkeylabs-dev] Hot reloading route: /src/server/routes/users/index.ts
[donkeylabs-dev] Route hot reload complete: users
```

### Inspecting Hot Reload

To debug hot reload issues:

1. **Check mode:**
   ```bash
   bun --bun run dev  # Should show "in-process mode"
   ```

2. **Verify file pattern:**
   Your route files should match the pattern:
   ```typescript
   // Default: **/routes/**/*.ts
   src/server/routes/users/index.ts  ✅
   src/server/plugins/users/index.ts ❌ (not a route)
   ```

3. **Check console:**
   Look for `[donkeylabs-dev]` messages

4. **Manual test:**
   ```typescript
   // Add to route file
   console.log("Route loaded:", Date.now());
   ```

---

## Performance Optimization

### Dev Server Performance

**Fastest setup:**
```bash
# Use Bun runtime
bun --bun run dev

# Disable type watching if not needed (rare)
donkeylabsDev({ watchTypes: false })
```

**Slowdown causes:**
1. Subprocess mode (proxy overhead)
2. Type regeneration on every save (debounced but still frequent)
3. Too many plugins (increases init time)
4. Complex middleware chains

### Type Generation Performance

**Fast:**
- Few plugins (< 10)
- Simple schemas
- SSD storage

**Slow:**
- Many plugins (> 20)
- Complex type definitions
- Network drives

**Optimization:**
- Use plugin watcher for focused work
- Commit generated types to avoid regeneration
- Skip validation in dev: `skipLibCheck: true`

---

## VS Code Integration

### Recommended Extensions

1. **Svelte for VS Code** - Svelte/SvelteKit support
2. **TypeScript Importer** - Auto-import types
3. **Error Lens** - Inline error display
4. **TODO Highlight** - Mark todos in code

### VS Code Extension Opportunities

A custom DonkeyLabs VS Code extension could provide:

#### 1. Code Snippets

**Plugin snippet:**
```json
{
  "DonkeyLabs Plugin": {
    "prefix": "plugin",
    "body": [
      "export const ${1:name}Plugin = createPlugin",
      "  .withSchema<${2:Schema}>()",
      "  .define({",
      "    name: '${1:name}',",
      "    service: async (ctx) => ({",
      "      $3",
      "    }),",
      "  });"
    ]
  }
}
```

**Route snippet:**
```json
{
  "DonkeyLabs Route": {
    "prefix": "route",
    "body": [
      "router.route('${1:name}').typed(defineRoute({",
      "  input: ${2:inputSchema},",
      "  output: ${3:outputSchema},",
      "  handle: async (input, ctx) => {",
      "    $4",
      "  },",
      "}));"
    ]
  }
}
```

#### 2. Go to Definition

**Route → Plugin:**
- Click on `ctx.plugins.users.getById`
- Jump to plugin service method definition

**Implementation:**
```typescript
// VS Code extension
vscode.languages.registerDefinitionProvider('typescript', {
  provideDefinition(document, position) {
    // Detect ctx.plugins.* pattern
    // Resolve plugin path from registry
    // Return Location to plugin method
  }
});
```

#### 3. Auto-Import

**Context-aware suggestions:**
- Type `ctx.plugins.` → Suggest all available plugins
- Type `ctx.core.` → Suggest core services
- Type `router.` → Suggest middleware methods

#### 4. Type Hints

**Show generated types inline:**
```typescript
// Hover shows:
// (property) users: {
//   getById: (id: string) => Promise<User | undefined>
//   create: (data: CreateUserInput) => Promise<User>
// }
ctx.plugins.users
```

#### 5. Status Bar

**Display:**
- ⏳ Type generation in progress
- ✅ Types up to date
- 🔄 Hot reload active
- 🌡️ Backend status (in-process/subprocess)

**Click actions:**
- Regenerate types
- Restart dev server
- Toggle hot reload

#### 6. Commands

**Command palette:**
- `DonkeyLabs: Generate Types`
- `DonkeyLabs: Create Plugin`
- `DonkeyLabs: Add Migration`
- `DonkeyLabs: Restart Dev Server`

#### 7. File Explorer Integration

**Context menus:**
- Right-click on `plugins/` folder → "Create Plugin"
- Right-click on plugin folder → "Add Migration"
- Right-click on route file → "Add Route Handler"

#### 8. Error Diagnostics

**Custom linting:**
- Warn about raw SQL in migrations
- Detect missing type regeneration
- Flag business logic in routes
- Check plugin dependency cycles

### Implementation Approach

**Option 1: Language Server Protocol (LSP)**
- Full IDE integration
- Real-time type checking
- Complex to implement

**Option 2: VS Code Extension API**
- Simpler implementation
- Good enough for most features
- Can use existing TypeScript compiler API

**Priority features:**
1. Code snippets (easy win)
2. Status bar indicator
3. Commands palette integration
4. Go to definition (high value)
5. Auto-import (high value)
6. Diagnostics (nice to have)

### Example Extension Structure

```
donkeylabs-vscode/
├── package.json
├── src/
│   ├── extension.ts          # Main entry
│   ├── providers/
│   │   ├── definition.ts     # Go to definition
│   │   ├── completion.ts     # Auto-complete
│   │   └── diagnostics.ts    # Linting
│   ├── commands/
│   │   ├── generateTypes.ts
│   │   ├── createPlugin.ts
│   │   └── addMigration.ts
│   └── status/
│       └── bar.ts            # Status bar
└── snippets/
    ├── plugin.json
    ├── route.json
    └── migration.json
```

---

## Troubleshooting

### Hot Reload Not Working

**Symptoms:** Changes don't appear after save

**Checklist:**
1. ✅ Using `bun --bun run dev`
2. ✅ File is in `src/server/routes/`
3. ✅ File matches pattern `**/routes/**/*.ts`
4. ✅ No TypeScript errors in file
5. ✅ Console shows `[donkeylabs-dev]` messages

**Fixes:**
```bash
# Restart dev server
Ctrl+C && bun --bun run dev

# Manual type regeneration
bun run gen:types

# Check file pattern
grep "routePatterns" vite.config.ts
```

### Types Not Updating

**Symptoms:** `api.ts` shows old types

**Causes:**
1. Type generation skipped due to cooldown
2. Plugin has TypeScript errors
3. Migration doesn't compile

**Fix:**
```bash
# Force regeneration
bun run gen:types

# Check for errors
bun --bun tsc --noEmit

# Regenerate specific plugin
bun scripts/generate-types.ts <plugin-name>
```

### Slow Dev Server

**Symptoms:** Long startup, slow requests

**Causes:**
1. Using subprocess mode
2. Too many plugins initializing
3. Slow database connection
4. Heavy middleware chains

**Fix:**
```bash
# Switch to in-process
bun --bun run dev

# Check plugin count
ls -1 src/server/plugins/ | wc -l

# Profile startup
DEBUG=* bun --bun run dev
```

### "Cannot find module" Errors

**Causes:**
1. Types not generated
2. Import path wrong
3. Plugin not registered

**Fix:**
```bash
# Generate types
bun run gen:types

# Verify import path
# Check plugin is registered in server/index.ts
```

---

## Summary

The DonkeyLabs dev experience includes:

1. **Sophisticated hot reload** - Route changes without restart
2. **Two dev modes** - In-process (fast) and subprocess (compatible)
3. **Automatic type generation** - Triggered by file changes
4. **File watchers** - Route watcher + plugin watcher
5. **Debugging tools** - Console logging, status indicators
6. **VS Code opportunities** - Snippets, go-to-def, auto-import

**Best practices:**
- Always use `bun --bun run dev`
- Run `gen:types` after structural changes
- Use plugin watcher for focused plugin dev
- Commit generated types for faster CI
- Check console for `[donkeylabs-dev]` messages
