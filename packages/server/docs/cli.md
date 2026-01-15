# CLI & Scripts

Command-line tools for managing plugins, generating types, and scaffolding code.

## Quick Reference

### Non-Interactive Commands (AI-Friendly)

These commands run without prompts - ideal for automation and AI assistants:

```sh
# Create plugin with options
bun scripts/create-plugin.ts --name myPlugin --schema --deps auth,cache
bun scripts/create-plugin.ts --help  # Show all options

# Create server file
bun scripts/create-server.ts --name server.ts --port 3000 --plugins auth,users
bun scripts/create-server.ts --help  # Show all options

# Create migration
bun scripts/create-migration.ts users add_avatar_column
bun scripts/create-migration.ts --help  # Show usage

# Generate types
bun run gen:registry                           # Regenerate registry.d.ts
bun run gen:server                             # Regenerate context.d.ts
bun scripts/generate-types.ts <plugin>         # Generate schema types for plugin

# Watch plugin for changes (runs watcher)
bun scripts/watcher.ts <plugin>
```

### Interactive CLI

For guided workflows with menus:

```sh
bun run cli
```

---

## Non-Interactive Commands

### Create Plugin

```sh
bun scripts/create-plugin.ts [options]

Options:
  --name <name>        Plugin name (required)
  --schema             Include database schema (optional)
  --config             Include configuration support (optional)
  --deps <list>        Comma-separated dependencies (optional)
  --handlers           Include custom handler template (optional)
  --middleware         Include custom middleware template (optional)

Examples:
  # Simple plugin
  bun scripts/create-plugin.ts --name analytics

  # Plugin with schema and dependencies
  bun scripts/create-plugin.ts --name orders --schema --deps auth,products

  # Full-featured plugin
  bun scripts/create-plugin.ts --name notifications --schema --config --deps auth --handlers --middleware
```

**Generated structure:**

```
plugins/myPlugin/
├── index.ts          # Plugin definition
├── schema.ts         # Database types (if --schema)
└── migrations/       # Migration folder (if --schema)
    └── 001_initial.ts
```

### Create Server

```sh
bun scripts/create-server.ts [options]

Options:
  --name <filename>    Output filename (default: server.ts)
  --port <number>      Server port (default: 3000)
  --plugins <list>     Comma-separated plugins to include

Examples:
  # Basic server
  bun scripts/create-server.ts --name app.ts --port 8080

  # Server with plugins
  bun scripts/create-server.ts --name api.ts --port 3000 --plugins auth,users,orders
```

### Create Migration

```sh
bun scripts/create-migration.ts <plugin> <migration_name>

Examples:
  bun scripts/create-migration.ts users add_avatar_column
  bun scripts/create-migration.ts orders add_status_index
```

**Generated file:** `plugins/<plugin>/migrations/002_add_avatar_column.ts`

### Generate Types

```sh
# Regenerate all plugin/handler registry types
bun run gen:registry

# Regenerate server context types
bun run gen:server

# Generate schema types for a specific plugin
bun scripts/generate-types.ts <plugin>

Examples:
  bun scripts/generate-types.ts users
  bun scripts/generate-types.ts orders
```

### Watch Plugin

```sh
bun scripts/watch.ts <plugin>

Examples:
  bun scripts/watch.ts auth
  bun scripts/watch.ts orders
```

Watches for changes and auto-regenerates types.

---

## Interactive CLI

Launch the interactive menu:

```sh
bun run cli
```

### From Project Root

```
Plugin CLI

Context: Project Root

? Select a command:
  1. Create New Plugin
  2. Create New Server
  ─────────────────────────
  3. Publish Plugin Version
  4. Install Plugin from Global
  ─────────────────────────
  5. Generate Registry
  6. Watch Plugin
  ─────────────────────────
  × Exit
```

### From Plugin Directory

When running from inside `plugins/<name>/`:

```
Plugin CLI

Context: Plugin 'auth'

? What would you like to do?
  1. Live Watch
  2. Generate Schema Types
  3. Create Migration
  4. Publish New Version
  ─────────────────────────
  ← Back to Global Menu
  × Exit
```

---

## Package.json Scripts

Add these to your `package.json`:

```json
{
  "scripts": {
    "cli": "bun scripts/cli.ts",
    "gen:registry": "bun scripts/generate-registry.ts",
    "gen:server": "bun scripts/generate-server.ts",
    "dev": "bun --watch index.ts",
    "test": "bun test",
    "typecheck": "bun --bun tsc --noEmit"
  }
}
```

---

## Global Plugin Registry

Share plugins across projects using the global registry.

### Publish Plugin

```sh
# Interactive
bun run cli
# Select: Publish Plugin Version

# Non-interactive (from plugin directory)
bun scripts/publish.ts --version 1.0.0
```

### Install Plugin

```sh
# Interactive
bun run cli
# Select: Install Plugin from Global

# Non-interactive
bun scripts/install.ts --name auth --version latest
```

### Check for Updates

The CLI automatically checks for updates when opened and shows:

```
Updates Available:
  auth: 1.0.0 → 1.1.0
  users: 2.0.0 → 2.1.0
```

---

## Workflow Examples

### Creating a New Feature

```sh
# 1. Create the plugin
bun scripts/create-plugin.ts --name orders --schema --deps auth,products

# 2. Edit the generated files
#    - plugins/orders/index.ts (service logic)
#    - plugins/orders/migrations/001_initial.ts (database schema)

# 3. Generate types
bun run gen:registry

# 4. Start watching for changes
bun scripts/watch.ts orders

# 5. Add routes and test
```

### Adding Database Changes

```sh
# 1. Create migration
bun scripts/create-migration.ts orders add_shipping_address

# 2. Edit the migration file
#    - plugins/orders/migrations/002_add_shipping_address.ts

# 3. Regenerate schema types
bun scripts/generate-types.ts orders

# 4. Update service code to use new columns
```

### Setting Up a New Project

```sh
# 1. Initialize project
mkdir my-api && cd my-api
bun init

# 2. Install dependencies
bun add kysely zod

# 3. Copy framework files or install from template

# 4. Create initial plugins
bun scripts/create-plugin.ts --name auth --schema
bun scripts/create-plugin.ts --name users --schema --deps auth

# 5. Generate registry
bun run gen:registry

# 6. Create server
bun scripts/create-server.ts --name index.ts --port 3000 --plugins auth,users

# 7. Start development
bun --watch index.ts
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `INIT_CWD` | Original directory when running via `bun run` |
| `GLOBAL_REGISTRY_PATH` | Path to global plugin registry |

---

## Troubleshooting

### "Plugin not found" after creation

```sh
bun run gen:registry
```

### Types not updating

```sh
# Regenerate all types
bun run gen:registry
bun run gen:server

# Restart TypeScript server in your IDE
# VS Code: Cmd+Shift+P > "TypeScript: Restart TS Server"
```

### Migration not running

Check that migration file exports `up` and `down` functions:

```ts
export async function up(db: Kysely<any>): Promise<void> { ... }
export async function down(db: Kysely<any>): Promise<void> { ... }
```

### Watch mode not detecting changes

Ensure you're watching the correct plugin:

```sh
bun scripts/watch.ts <exact-plugin-name>
```
