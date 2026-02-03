# Hot Reload Limitations & Solutions

## The Problem

**Plugins don't hot reload** when you make changes. This is a fundamental limitation of the current architecture:

```
Change: plugins/users/index.ts
❌ Service methods don't update automatically
❌ Type definitions don't refresh
❌ Must restart server to see changes
```

## Why Plugins Don't Hot Reload

1. **Plugin Initialization Happens Once**
   - Plugins register at server startup
   - Services are instantiated with closures
   - Dependencies are resolved at init time

2. **Type Generation Required**
   - Plugin schemas generate TypeScript types
   - Types are written to disk
   - TypeScript compiler needs restart to see changes

3. **State Management**
   - Plugins may have internal state
   - Connections (DB, Redis) are established
   - Cron jobs are scheduled

## Current Workarounds

### 1. Plugin Watcher (Best for Plugin Development)

```bash
# Watch specific plugin
bun scripts/watcher.ts users

# This watches migrations and index.ts
# Auto-runs type generation on changes
```

### 2. Manual Type Regeneration

```bash
# After any plugin change
bun run gen:types

# Then restart server
Ctrl+C && bun run dev
```

### 3. Use Routes for Rapid Prototyping

**During development only:**

```typescript
// Instead of creating full plugin
// Put logic directly in route temporarily

router.route("quick-test").typed(defineRoute({
  handle: async (input, ctx) => {
    // Direct DB access for rapid iteration
    // Move to plugin once stable
    return ctx.db.selectFrom("users").execute();
  },
}));
```

### 4. Development Plugin Pattern

Create a "dev" plugin that reloads:

```typescript
// plugins/dev/index.ts
export const devPlugin = createPlugin.define({
  name: "dev",
  service: async (ctx) => {
    // Only in development
    if (process.env.NODE_ENV === "production") {
      return { hotReload: async () => {} };
    }
    
    return {
      hotReload: async (pluginName: string) => {
        // Force re-import
        const module = await import(`../${pluginName}/index.ts?${Date.now()}`);
        ctx.core.logger.info(`Reloaded ${pluginName}`);
      },
    };
  },
});
```

## Future Solutions

### Option 1: Plugin Hot Reload API

```typescript
// Proposed API
const server = new AppServer({
  hotReload: {
    plugins: true, // Enable plugin hot reload
    onPluginChange: async (pluginName) => {
      // 1. Clear require cache
      // 2. Re-import plugin
      // 3. Re-generate types
      // 4. Update service registry
    },
  },
});
```

### Option 2: Service Re-instantiation

```typescript
// Reload just the service methods
server.reloadPluginService("users", async (ctx) => ({
  // New service implementation
  getById: async (id) => { ... },
}));
```

### Option 3: Plugin Development Mode

```bash
# New CLI command
donkeylabs dev

# Features:
# - Watches all plugin files
# - Auto-restarts on structural changes
# - Auto-regenerates types
# - Maintains DB connection
```

## Recommended Development Workflow

**For Active Plugin Development:**

```bash
# Terminal 1: Run server
bun run dev

# Terminal 2: Watch plugin
bun scripts/watcher.ts users

# Make changes to plugin
# Watcher auto-generates types
# Server shows new types after restart

# When done:
# Commit both plugin AND generated types
```

## Summary

| What | Hot Reload? | Solution |
|------|-------------|----------|
| Route handlers | ✅ Yes | Instant |
| Route schemas | ⚠️ Needs type gen | Auto-regen |
| Plugin methods | ❌ No | Restart server |
| Plugin structure | ❌ No | Restart + type gen |
| Database changes | ⚠️ Migration + type gen | Run migrations |

**Best Practice:** Develop in routes first, extract to plugins once stable.
