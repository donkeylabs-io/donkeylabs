# Quick Start Guide

Get from zero to a working API in 5 minutes.

## 1. Create a Project

```bash
bunx @donkeylabs/cli init my-app
cd my-app
bun install
```

Choose **sveltekit-app** for full-stack or **starter** for API-only.

## 2. Start Development Server

```bash
bun run dev
```

Your server is now running. The API client is auto-generated at `src/lib/api.ts`.

## 3. Create Your First Feature

Using Claude Code with the MCP server:

```
scaffold_feature
  name: "todos"
  crud: true
  fields: "title: string, completed: boolean"
```

This creates:
```
src/server/routes/todos/
├── index.ts              # Router
├── todos.schemas.ts      # Zod schemas
├── handlers/
│   ├── create.handler.ts
│   ├── list.handler.ts
│   ├── get.handler.ts
│   ├── update.handler.ts
│   └── delete.handler.ts
└── todos.test.ts
```

## 4. Add Database Table

Create a plugin with a migration:

```
create_plugin
  name: "todos"
  hasSchema: true
```

```
add_migration
  pluginName: "todos"
  migrationName: "create_todos"
  upCode: 'await db.schema.createTable("todos").addColumn("id", "text", (col) => col.primaryKey()).addColumn("title", "text", (col) => col.notNull()).addColumn("completed", "integer", (col) => col.notNull().defaultTo(0)).addColumn("created_at", "text", (col) => col.notNull()).addColumn("updated_at", "text", (col) => col.notNull()).execute();'
```

## 5. Register Everything

In `src/server/index.ts`:

```typescript
import { todosPlugin } from "./plugins/todos";
import { todosRouter } from "./routes/todos";

server.registerPlugin(todosPlugin);
server.use(todosRouter);
```

## 6. Generate Types

```bash
bunx donkeylabs generate
```

## 7. Use the API

**In +page.server.ts (SSR - no HTTP overhead):**
```typescript
import { createApi } from "$lib/api";

export const load = async ({ locals }) => {
  const api = createApi({ locals });
  const todos = await api.todos.list({});
  return { todos };
};
```

**In +page.svelte (browser):**
```svelte
<script lang="ts">
  import { createApi } from "$lib/api";

  const api = createApi();
  let { data } = $props();

  async function addTodo(title: string) {
    await api.todos.create({ title, completed: false });
  }
</script>
```

## Next Steps

- **Add authentication**: See `get_architecture_guidance` with task "add auth"
- **Add real-time updates**: Use SSE routes with `add_sse_route`
- **Add background jobs**: Use `add_async_job` for email, processing, etc.
- **Read the docs**: `donkeylabs://docs/plugins`, `donkeylabs://docs/handlers`

## Key Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server |
| `bunx donkeylabs generate` | Regenerate types |
| `bun test` | Run tests |
| `bun --bun tsc --noEmit` | Type check |

## MCP Tools Reference

| Tool | Use For |
|------|---------|
| `scaffold_feature` | Create complete feature module with handlers |
| `create_plugin` | Create reusable business logic plugin |
| `add_migration` | Add database schema changes |
| `add_route` | Add route to existing router |
| `generate_types` | Regenerate TypeScript types |

## Troubleshooting

**Types not updating?**
```bash
bunx donkeylabs generate
```

**Migration errors?**
- Use Kysely schema builder, never raw SQL
- Check migration file numbering (001_, 002_, etc.)

**Route not found?**
- Register the router with `server.use(router)`
- Run `bunx donkeylabs generate`
