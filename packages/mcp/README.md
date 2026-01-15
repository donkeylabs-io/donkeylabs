# @donkeylabs/mcp

MCP (Model Context Protocol) server for AI-assisted development with `@donkeylabs/server`.

## Installation

```bash
bun add @donkeylabs/mcp
```

## Configuration

Add to your Claude Code MCP settings (`.mcp.json` or IDE settings):

```json
{
  "mcpServers": {
    "donkeylabs": {
      "command": "bun",
      "args": ["node_modules/@donkeylabs/mcp/src/server.ts"]
    }
  }
}
```

Or if using from the monorepo:

```json
{
  "mcpServers": {
    "donkeylabs": {
      "command": "bun",
      "args": ["packages/mcp/src/server.ts"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `create_plugin` | Create a new plugin with correct directory structure and files |
| `add_route` | Add a route to a router with proper typing |
| `add_migration` | Create a numbered migration file for a plugin |
| `add_service_method` | Add a method to a plugin's service |
| `generate_types` | Run type generation (registry, context, client) |
| `list_plugins` | List all plugins with their service methods |
| `get_project_info` | Get project structure information |

## Tool Details

### create_plugin

Creates a new plugin with the correct directory structure:

```
src/plugins/<name>/
├── index.ts      # Plugin definition
├── schema.ts     # Database types (if hasSchema: true)
└── migrations/   # SQL migrations (if hasSchema: true)
```

**Parameters:**
- `name` (required): Plugin name in camelCase
- `hasSchema` (optional): Whether the plugin needs a database schema
- `dependencies` (optional): Names of plugins this plugin depends on

### add_route

Adds a new route to an existing router file with proper TypeScript typing.

**Parameters:**
- `routerFile` (required): Path to the router file
- `routeName` (required): Route name (appended to router namespace)
- `handler` (required): Handler code (the async function body)
- `inputSchema` (optional): Zod schema for input validation
- `outputType` (optional): TypeScript type for output

### add_migration

Creates a numbered migration file for a plugin.

**Parameters:**
- `pluginName` (required): Name of the plugin
- `migrationName` (required): Descriptive name (e.g., `create_users`)
- `upSql` (required): SQL for the up migration
- `downSql` (optional): SQL for the down migration

### add_service_method

Adds a method to a plugin's service.

**Parameters:**
- `pluginName` (required): Name of the plugin
- `methodName` (required): Name of the method
- `implementation` (required): Method implementation code
- `params` (optional): Method parameters (e.g., `userId: string, data: Data`)
- `returnType` (optional): Return type (e.g., `Promise<User>`)

### generate_types

Runs type generation for the project.

**Parameters:**
- `target` (optional): What to generate - `all`, `registry`, `context`, or `client`

### list_plugins

Lists all plugins in the project with their service methods.

### get_project_info

Returns project structure information including:
- Project root path
- Config file location
- Plugins directory
- Output directory
- Available plugins

## Documentation

For detailed documentation on `@donkeylabs/server`, see:

- [Plugins](https://github.com/donkeylabs/server/blob/main/packages/server/docs/plugins.md)
- [Router](https://github.com/donkeylabs/server/blob/main/packages/server/docs/router.md)
- [CLI](https://github.com/donkeylabs/server/blob/main/packages/server/docs/cli.md)

## License

MIT
