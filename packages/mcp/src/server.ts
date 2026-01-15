#!/usr/bin/env bun
/**
 * @donkeylabs/mcp - MCP Server for AI-assisted development
 *
 * Provides tools for AI assistants to scaffold and manage @donkeylabs/server projects.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { join, dirname, basename, relative } from "path";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "fs";

// Find project root by looking for donkeylabs.config.ts or package.json with @donkeylabs/server
function findProjectRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (dir !== "/") {
    if (existsSync(join(dir, "donkeylabs.config.ts"))) {
      return dir;
    }
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (
          pkg.dependencies?.["@donkeylabs/server"] ||
          pkg.devDependencies?.["@donkeylabs/server"]
        ) {
          return dir;
        }
      } catch {}
    }
    dir = dirname(dir);
  }
  return process.cwd();
}

const projectRoot = findProjectRoot() || process.cwd();

// Tool definitions
const tools = [
  {
    name: "create_plugin",
    description:
      "Create a new plugin with correct directory structure and files",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Plugin name (camelCase)",
        },
        hasSchema: {
          type: "boolean",
          description: "Whether the plugin needs a database schema",
          default: false,
        },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Names of plugins this plugin depends on",
          default: [],
        },
      },
      required: ["name"],
    },
  },
  {
    name: "add_route",
    description: "Add a new route to a router with proper typing",
    inputSchema: {
      type: "object" as const,
      properties: {
        routerFile: {
          type: "string",
          description: "Path to the router file (relative to project root)",
        },
        routeName: {
          type: "string",
          description: "Route name (will be appended to router namespace)",
        },
        inputSchema: {
          type: "string",
          description: "Zod schema for input validation",
        },
        outputType: {
          type: "string",
          description: "TypeScript type for output (optional)",
        },
        handler: {
          type: "string",
          description: "Handler code (the async function body)",
        },
      },
      required: ["routerFile", "routeName", "handler"],
    },
  },
  {
    name: "add_migration",
    description: "Create a numbered migration file for a plugin",
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginName: {
          type: "string",
          description: "Name of the plugin",
        },
        migrationName: {
          type: "string",
          description:
            "Descriptive name for the migration (e.g., create_users)",
        },
        upSql: {
          type: "string",
          description: "SQL for the up migration",
        },
        downSql: {
          type: "string",
          description: "SQL for the down migration",
        },
      },
      required: ["pluginName", "migrationName", "upSql"],
    },
  },
  {
    name: "add_service_method",
    description: "Add a method to a plugin's service",
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginName: {
          type: "string",
          description: "Name of the plugin",
        },
        methodName: {
          type: "string",
          description: "Name of the method",
        },
        params: {
          type: "string",
          description: "Method parameters (e.g., 'userId: string, data: Data')",
        },
        returnType: {
          type: "string",
          description: "Return type (e.g., 'Promise<User>')",
        },
        implementation: {
          type: "string",
          description: "Method implementation code",
        },
      },
      required: ["pluginName", "methodName", "implementation"],
    },
  },
  {
    name: "generate_types",
    description: "Run type generation (registry, context, client)",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          enum: ["all", "registry", "context", "client"],
          description: "What to generate",
          default: "all",
        },
      },
    },
  },
  {
    name: "list_plugins",
    description: "List all plugins with their service methods",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_project_info",
    description: "Get project structure information",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// Tool implementations
async function createPlugin(args: {
  name: string;
  hasSchema?: boolean;
  dependencies?: string[];
}): Promise<string> {
  const { name, hasSchema = false, dependencies = [] } = args;
  const pluginDir = join(projectRoot, "src", "plugins", name);

  if (existsSync(pluginDir)) {
    return `Error: Plugin directory already exists: ${pluginDir}`;
  }

  mkdirSync(pluginDir, { recursive: true });

  // Create index.ts
  const depsImport =
    dependencies.length > 0
      ? `\nimport { ${dependencies.map((d) => `${d}Plugin`).join(", ")} } from "../${dependencies[0]}";`
      : "";

  const depsArray =
    dependencies.length > 0
      ? `\n  dependencies: [${dependencies.map((d) => `${d}Plugin`).join(", ")}],`
      : "";

  const indexContent = `import { createPlugin } from "@donkeylabs/server";${depsImport}${hasSchema ? `\nimport type { ${name[0].toUpperCase() + name.slice(1)}Schema } from "./schema";` : ""}

export const ${name}Plugin = createPlugin.define({
  name: "${name}",${depsArray}${hasSchema ? `\n  schema: {} as ${name[0].toUpperCase() + name.slice(1)}Schema,` : ""}
  service: async (ctx) => ({
    // Add service methods here
    example: () => "Hello from ${name}!",
  }),
});
`;

  await Bun.write(join(pluginDir, "index.ts"), indexContent);

  // Create schema.ts if needed
  if (hasSchema) {
    mkdirSync(join(pluginDir, "migrations"), { recursive: true });

    const schemaContent = `// Auto-generated schema types for ${name} plugin
// Run 'donkeylabs generate' after adding migrations

export interface ${name[0].toUpperCase() + name.slice(1)}Schema {
  // Tables will be added here after running migrations
}
`;
    await Bun.write(join(pluginDir, "schema.ts"), schemaContent);

    // Create initial migration
    const migrationContent = `-- Migration: 001_initial
-- Created: ${new Date().toISOString()}

-- UP
-- Add your table creation SQL here

-- DOWN
-- Add your rollback SQL here
`;
    await Bun.write(
      join(pluginDir, "migrations", "001_initial.sql"),
      migrationContent
    );
  }

  return `Created plugin at ${relative(projectRoot, pluginDir)}:
- index.ts (plugin definition)${hasSchema ? "\n- schema.ts (type definitions)\n- migrations/001_initial.sql" : ""}

Next steps:
1. Add service methods to index.ts
${hasSchema ? "2. Edit migrations/001_initial.sql with your schema\n3. Run 'donkeylabs generate' to generate types" : "2. Run 'donkeylabs generate' to update registry"}`;
}

async function addRoute(args: {
  routerFile: string;
  routeName: string;
  inputSchema?: string;
  outputType?: string;
  handler: string;
}): Promise<string> {
  const { routerFile, routeName, inputSchema, outputType, handler } = args;
  const fullPath = join(projectRoot, routerFile);

  if (!existsSync(fullPath)) {
    return `Error: Router file not found: ${routerFile}`;
  }

  const content = await Bun.file(fullPath).text();

  // Find the last route definition or the router creation
  const lastRouteMatch = content.match(/\.route\([^)]+\)\s*\.[^;]+;?\s*$/m);
  const routerMatch = content.match(/createRouter\([^)]+\)/);

  if (!routerMatch) {
    return `Error: Could not find createRouter() in ${routerFile}`;
  }

  const newRoute = inputSchema
    ? `  .route("${routeName}").typed({
    input: ${inputSchema},${outputType ? `\n    output: ${outputType},` : ""}
    handle: async (input, ctx) => {
      ${handler}
    },
  })`
    : `  .route("${routeName}").typed({
    handle: async (_input, ctx) => {
      ${handler}
    },
  })`;

  // Insert before the last semicolon of the router chain
  const insertPoint = content.lastIndexOf(";");
  const newContent =
    content.slice(0, insertPoint) + "\n" + newRoute + content.slice(insertPoint);

  await Bun.write(fullPath, newContent);

  return `Added route "${routeName}" to ${routerFile}`;
}

async function addMigration(args: {
  pluginName: string;
  migrationName: string;
  upSql: string;
  downSql?: string;
}): Promise<string> {
  const { pluginName, migrationName, upSql, downSql = "" } = args;
  const migrationsDir = join(
    projectRoot,
    "src",
    "plugins",
    pluginName,
    "migrations"
  );

  if (!existsSync(migrationsDir)) {
    mkdirSync(migrationsDir, { recursive: true });
  }

  // Find next migration number
  const existing = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => parseInt(f.split("_")[0], 10))
    .filter((n) => !isNaN(n));

  const nextNum = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  const numStr = String(nextNum).padStart(3, "0");
  const filename = `${numStr}_${migrationName}.sql`;

  const content = `-- Migration: ${numStr}_${migrationName}
-- Created: ${new Date().toISOString()}

-- UP
${upSql}

-- DOWN
${downSql}
`;

  await Bun.write(join(migrationsDir, filename), content);

  return `Created migration: ${relative(projectRoot, join(migrationsDir, filename))}

Run 'donkeylabs generate' to update schema types.`;
}

async function addServiceMethod(args: {
  pluginName: string;
  methodName: string;
  params?: string;
  returnType?: string;
  implementation: string;
}): Promise<string> {
  const {
    pluginName,
    methodName,
    params = "",
    returnType = "void",
    implementation,
  } = args;
  const pluginFile = join(projectRoot, "src", "plugins", pluginName, "index.ts");

  if (!existsSync(pluginFile)) {
    return `Error: Plugin not found: ${pluginName}`;
  }

  const content = await Bun.file(pluginFile).text();

  // Find the service object
  const serviceMatch = content.match(/service:\s*async\s*\([^)]*\)\s*=>\s*\({/);
  if (!serviceMatch) {
    return `Error: Could not find service definition in ${pluginName}/index.ts`;
  }

  // Find where to insert (before the closing of the service object)
  const serviceStart = serviceMatch.index! + serviceMatch[0].length;
  const methodDef = `
    ${methodName}: ${params ? `(${params})` : "()"}: ${returnType} => {
      ${implementation}
    },`;

  // Insert after the opening brace of the service return
  const newContent =
    content.slice(0, serviceStart) + methodDef + content.slice(serviceStart);

  await Bun.write(pluginFile, newContent);

  return `Added method "${methodName}" to ${pluginName} plugin`;
}

async function generateTypes(args: { target?: string }): Promise<string> {
  const { target = "all" } = args;

  try {
    const proc = Bun.spawn(["bun", "run", "donkeylabs", "generate"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();

    await proc.exited;

    if (proc.exitCode !== 0) {
      return `Generation failed:\n${error || output}`;
    }

    return `Types generated successfully:\n${output}`;
  } catch (e) {
    return `Error running generation: ${e}`;
  }
}

async function listPlugins(): Promise<string> {
  const pluginsDir = join(projectRoot, "src", "plugins");

  if (!existsSync(pluginsDir)) {
    return "No plugins directory found at src/plugins/";
  }

  const plugins: string[] = [];

  for (const entry of readdirSync(pluginsDir)) {
    const pluginPath = join(pluginsDir, entry);
    if (!statSync(pluginPath).isDirectory()) continue;

    const indexPath = join(pluginPath, "index.ts");
    if (!existsSync(indexPath)) continue;

    const content = await Bun.file(indexPath).text();

    // Extract service methods
    const serviceMatch = content.match(
      /service:\s*async\s*\([^)]*\)\s*=>\s*\({([^}]+)\}/s
    );
    const methods: string[] = [];

    if (serviceMatch) {
      const methodMatches = serviceMatch[1].matchAll(
        /(\w+):\s*(?:async\s*)?\([^)]*\)/g
      );
      for (const m of methodMatches) {
        methods.push(m[1]);
      }
    }

    // Check for dependencies
    const depsMatch = content.match(/dependencies:\s*\[([^\]]*)\]/);
    const deps = depsMatch ? depsMatch[1].trim() : "";

    // Check for schema
    const hasSchema =
      existsSync(join(pluginPath, "schema.ts")) ||
      content.includes("schema:");

    plugins.push(`
## ${entry}
- Methods: ${methods.length > 0 ? methods.join(", ") : "none"}
- Dependencies: ${deps || "none"}
- Has schema: ${hasSchema ? "yes" : "no"}
- Path: src/plugins/${entry}/`);
  }

  if (plugins.length === 0) {
    return "No plugins found in src/plugins/";
  }

  return `# Plugins (${plugins.length})${plugins.join("\n")}`;
}

async function getProjectInfo(): Promise<string> {
  const info: string[] = [`# Project: ${basename(projectRoot)}`];

  // Check for config file
  const configPath = join(projectRoot, "donkeylabs.config.ts");
  if (existsSync(configPath)) {
    info.push("- Config: donkeylabs.config.ts");
  }

  // List main directories
  const srcDir = join(projectRoot, "src");
  if (existsSync(srcDir)) {
    const dirs = readdirSync(srcDir)
      .filter((d) => statSync(join(srcDir, d)).isDirectory())
      .map((d) => `  - ${d}/`);
    info.push(`- Source structure:\n${dirs.join("\n")}`);
  }

  // Count plugins
  const pluginsDir = join(projectRoot, "src", "plugins");
  if (existsSync(pluginsDir)) {
    const count = readdirSync(pluginsDir).filter((d) =>
      statSync(join(pluginsDir, d)).isDirectory()
    ).length;
    info.push(`- Plugins: ${count}`);
  }

  // Check for generated types
  const genDir = join(projectRoot, ".@donkeylabs/server");
  if (existsSync(genDir)) {
    info.push("- Generated types: .@donkeylabs/server/");
  }

  // Check package.json for dependencies
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await Bun.file(pkgPath).text());
      const serverVersion =
        pkg.dependencies?.["@donkeylabs/server"] ||
        pkg.devDependencies?.["@donkeylabs/server"];
      if (serverVersion) {
        info.push(`- @donkeylabs/server: ${serverVersion}`);
      }
    } catch {}
  }

  return info.join("\n");
}

// Create and start the server
const server = new Server(
  {
    name: "donkeylabs-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "create_plugin":
        result = await createPlugin(args as Parameters<typeof createPlugin>[0]);
        break;
      case "add_route":
        result = await addRoute(args as Parameters<typeof addRoute>[0]);
        break;
      case "add_migration":
        result = await addMigration(args as Parameters<typeof addMigration>[0]);
        break;
      case "add_service_method":
        result = await addServiceMethod(
          args as Parameters<typeof addServiceMethod>[0]
        );
        break;
      case "generate_types":
        result = await generateTypes(args as { target?: string });
        break;
      case "list_plugins":
        result = await listPlugins();
        break;
      case "get_project_info":
        result = await getProjectInfo();
        break;
      default:
        result = `Unknown tool: ${name}`;
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
