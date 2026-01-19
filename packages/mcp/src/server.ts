#!/usr/bin/env bun
/**
 * @donkeylabs/mcp - MCP Server for AI-assisted development
 *
 * Provides tools and resources for AI assistants to scaffold and manage @donkeylabs/server projects.
 * Helps agents follow best practices and avoid creating unmaintainable code.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { join, dirname, basename, relative } from "path";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "fs";

// =============================================================================
// PROJECT DETECTION & HELPERS
// =============================================================================

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

// =============================================================================
// PROJECT CONFIG DETECTION
// =============================================================================

interface ProjectConfig {
  adapter?: string;
  pluginsDir: string;
  routesDir: string;
  clientOutput?: string;
}

function detectProjectConfig(): ProjectConfig {
  const configPath = join(projectRoot, "donkeylabs.config.ts");

  // Default paths for standalone server
  let config: ProjectConfig = {
    pluginsDir: "src/plugins",
    routesDir: "src/routes",
  };

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");

      // Check for SvelteKit adapter
      if (content.includes("adapter-sveltekit") || content.includes("@donkeylabs/adapter-sveltekit")) {
        config.adapter = "sveltekit";
        config.pluginsDir = "src/server/plugins";
        config.routesDir = "src/server/routes";
      }

      // Check for custom plugins path
      const pluginsMatch = content.match(/plugins:\s*\["([^"]+)"/);
      if (pluginsMatch) {
        const pluginPath = pluginsMatch[1];
        if (pluginPath.includes("src/server/plugins")) {
          config.pluginsDir = "src/server/plugins";
        } else if (pluginPath.includes("src/plugins")) {
          config.pluginsDir = "src/plugins";
        }
      }

      // Check for custom routes path
      const routesMatch = content.match(/routes:\s*"([^"]+)"/);
      if (routesMatch) {
        const routePath = routesMatch[1];
        if (routePath.includes("src/server/routes")) {
          config.routesDir = "src/server/routes";
        }
      }

      // Check for client output
      const clientMatch = content.match(/client:\s*\{[^}]*output:\s*"([^"]+)"/);
      if (clientMatch) {
        config.clientOutput = clientMatch[1];
      }
    } catch (e) {
      // Use defaults on error
    }
  }

  return config;
}

const projectConfig = detectProjectConfig();

function toPascalCase(str: string): string {
  return str
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (word) => word.toUpperCase())
    .replace(/[\s-_]+/g, "");
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function isCamelCase(str: string): boolean {
  return /^[a-z][a-zA-Z0-9]*$/.test(str);
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
}

function validateProjectExists(): ValidationResult {
  const configPath = join(projectRoot, "donkeylabs.config.ts");
  const pkgPath = join(projectRoot, "package.json");

  if (!existsSync(configPath) && !existsSync(pkgPath)) {
    return {
      valid: false,
      error: "No @donkeylabs/server project found",
      suggestion: "Run 'bunx @donkeylabs/cli init' to create a new project, or navigate to an existing project directory.",
    };
  }
  return { valid: true };
}

function validatePluginName(name: string): ValidationResult {
  if (!isCamelCase(name)) {
    return {
      valid: false,
      error: `Plugin name "${name}" is not in camelCase`,
      suggestion: `Use camelCase naming (e.g., "${name.charAt(0).toLowerCase()}${name.slice(1).replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())}")`,
    };
  }
  return { valid: true };
}

function validatePluginExists(name: string): ValidationResult {
  const pluginDir = join(projectRoot, projectConfig.pluginsDir, name);
  if (!existsSync(pluginDir)) {
    const availablePlugins = listAvailablePlugins();
    return {
      valid: false,
      error: `Plugin "${name}" not found at ${projectConfig.pluginsDir}/${name}/`,
      suggestion: availablePlugins.length > 0
        ? `Available plugins: ${availablePlugins.join(", ")}`
        : "Create a plugin first using the create_plugin tool.",
    };
  }
  return { valid: true };
}

function validateRouterExists(routerFile: string): ValidationResult {
  const fullPath = join(projectRoot, routerFile);
  if (!existsSync(fullPath)) {
    const availableRouters = listAvailableRouters();
    return {
      valid: false,
      error: `Router file not found: ${routerFile}`,
      suggestion: availableRouters.length > 0
        ? `Available routers:\n${availableRouters.map(r => `  - ${r}`).join("\n")}\n\nOr use create_router to create a new one.`
        : "Create a router first using the create_router tool.",
    };
  }
  return { valid: true };
}

function listAvailablePlugins(): string[] {
  const pluginsDir = join(projectRoot, projectConfig.pluginsDir);
  if (!existsSync(pluginsDir)) return [];

  return readdirSync(pluginsDir)
    .filter((d) => statSync(join(pluginsDir, d)).isDirectory())
    .filter((d) => existsSync(join(pluginsDir, d, "index.ts")));
}

function listAvailableRouters(): string[] {
  const routesDir = join(projectRoot, projectConfig.routesDir);
  if (!existsSync(routesDir)) {
    return [];
  }
  return findRouterFiles(routesDir, projectConfig.routesDir);
}

function findRouterFiles(dir: string, prefix: string): string[] {
  const files: string[] = [];

  function scan(currentDir: string, currentPrefix: string) {
    for (const entry of readdirSync(currentDir)) {
      const fullPath = join(currentDir, entry);
      const relativePath = `${currentPrefix}/${entry}`;

      if (statSync(fullPath).isDirectory()) {
        const indexPath = join(fullPath, "index.ts");
        if (existsSync(indexPath)) {
          files.push(`${relativePath}/index.ts`);
        }
        scan(fullPath, relativePath);
      } else if (entry.endsWith(".ts") && !entry.includes(".test.") && !entry.includes(".spec.")) {
        files.push(relativePath);
      }
    }
  }

  scan(dir, prefix);
  return files;
}

function formatError(error: string, context?: string, suggestion?: string, relatedTool?: string): string {
  let message = `## Error: ${error}\n`;

  if (context) {
    message += `\n### Context\n${context}\n`;
  }

  if (suggestion) {
    message += `\n### How to Fix\n${suggestion}\n`;
  }

  if (relatedTool) {
    message += `\n### Related Tool\nConsider using: \`${relatedTool}\`\n`;
  }

  return message;
}

// =============================================================================
// RESOURCE DEFINITIONS
// =============================================================================

// Resolve docs directory relative to this file's location
// This handles running from different working directories
function findDocsDir(): string {
  const possiblePaths = [
    // When running from monorepo
    join(import.meta.dir, "..", "..", "..", "server", "docs"),
    // When installed as package
    join(import.meta.dir, "..", "..", "node_modules", "@donkeylabs", "server", "docs"),
    // Fallback to trying to find it from cwd
    join(process.cwd(), "node_modules", "@donkeylabs", "server", "docs"),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  // Return first path even if not found (will show appropriate error later)
  return possiblePaths[0];
}

const DOCS_DIR = findDocsDir();

const RESOURCES = [
  {
    uri: "donkeylabs://docs/database",
    name: "Database (Kysely)",
    description: "Kysely queries, CRUD operations, joins, transactions, migrations",
    mimeType: "text/markdown",
    docFile: "database.md",
  },
  {
    uri: "donkeylabs://docs/project-structure",
    name: "Project Structure",
    description: "Canonical directory layout, naming conventions, and organizational patterns",
    mimeType: "text/markdown",
    docFile: "project-structure.md",
  },
  {
    uri: "donkeylabs://docs/plugins",
    name: "Plugins Guide",
    description: "Creating plugins with services, database schemas, middleware, and dependencies",
    mimeType: "text/markdown",
    docFile: "plugins.md",
  },
  {
    uri: "donkeylabs://docs/router",
    name: "Router & Routes",
    description: "Route definitions, handlers (typed, raw, class-based), middleware chaining",
    mimeType: "text/markdown",
    docFile: "router.md",
  },
  {
    uri: "donkeylabs://docs/handlers",
    name: "Custom Handlers",
    description: "Creating custom request handlers for specialized processing",
    mimeType: "text/markdown",
    docFile: "handlers.md",
  },
  {
    uri: "donkeylabs://docs/middleware",
    name: "Middleware",
    description: "Creating and using middleware for cross-cutting concerns",
    mimeType: "text/markdown",
    docFile: "middleware.md",
  },
  {
    uri: "donkeylabs://docs/core-services",
    name: "Core Services Overview",
    description: "Overview of all built-in core services",
    mimeType: "text/markdown",
    docFile: "core-services.md",
  },
  {
    uri: "donkeylabs://docs/logger",
    name: "Logger Service",
    description: "Structured logging with child loggers and context",
    mimeType: "text/markdown",
    docFile: "logger.md",
  },
  {
    uri: "donkeylabs://docs/cache",
    name: "Cache Service",
    description: "In-memory caching with TTL support",
    mimeType: "text/markdown",
    docFile: "cache.md",
  },
  {
    uri: "donkeylabs://docs/events",
    name: "Events Service",
    description: "Pub/sub event system with pattern matching",
    mimeType: "text/markdown",
    docFile: "events.md",
  },
  {
    uri: "donkeylabs://docs/cron",
    name: "Cron Service",
    description: "Scheduled task execution with cron expressions",
    mimeType: "text/markdown",
    docFile: "cron.md",
  },
  {
    uri: "donkeylabs://docs/jobs",
    name: "Jobs Service",
    description: "Background job queue with retries and scheduling",
    mimeType: "text/markdown",
    docFile: "jobs.md",
  },
  {
    uri: "donkeylabs://docs/sse",
    name: "SSE Service",
    description: "Server-Sent Events for real-time updates",
    mimeType: "text/markdown",
    docFile: "sse.md",
  },
  {
    uri: "donkeylabs://docs/rate-limiter",
    name: "Rate Limiter",
    description: "Per-key request rate limiting",
    mimeType: "text/markdown",
    docFile: "rate-limiter.md",
  },
  {
    uri: "donkeylabs://docs/errors",
    name: "Error Handling",
    description: "HTTP errors and custom error types",
    mimeType: "text/markdown",
    docFile: "errors.md",
  },
  {
    uri: "donkeylabs://docs/cli",
    name: "CLI Commands",
    description: "Command-line interface for code generation and project management",
    mimeType: "text/markdown",
    docFile: "cli.md",
  },
  {
    uri: "donkeylabs://docs/api-client",
    name: "API Client Generation",
    description: "Type-safe client generation from route definitions",
    mimeType: "text/markdown",
    docFile: "api-client.md",
  },
  {
    uri: "donkeylabs://project/current",
    name: "Current Project Analysis",
    description: "Dynamic analysis of the current project structure",
    mimeType: "text/markdown",
    dynamic: true,
  },
];

async function readResource(uri: string): Promise<string> {
  const resource = RESOURCES.find((r) => r.uri === uri);
  if (!resource) {
    return `Resource not found: ${uri}`;
  }

  // Dynamic resources
  if (resource.dynamic) {
    if (uri === "donkeylabs://project/current") {
      return await generateProjectAnalysis();
    }
  }

  // Static doc files
  if (resource.docFile) {
    const docPath = join(DOCS_DIR, resource.docFile);
    if (existsSync(docPath)) {
      return readFileSync(docPath, "utf-8");
    }
    return `Documentation file not found: ${resource.docFile}`;
  }

  return `Resource content not available: ${uri}`;
}

async function generateProjectAnalysis(): Promise<string> {
  const validation = validateProjectExists();
  if (!validation.valid) {
    return formatError(validation.error!, undefined, validation.suggestion);
  }

  let analysis = `# Project Analysis: ${basename(projectRoot)}\n\n`;

  // Config
  const configPath = join(projectRoot, "donkeylabs.config.ts");
  analysis += `## Configuration\n`;
  if (existsSync(configPath)) {
    analysis += `- Config file: donkeylabs.config.ts\n`;
    if (projectConfig.adapter) {
      analysis += `- Adapter: ${projectConfig.adapter}\n`;
    }
    analysis += `- Plugins directory: ${projectConfig.pluginsDir}/\n`;
    analysis += `- Routes directory: ${projectConfig.routesDir}/\n`;
    if (projectConfig.clientOutput) {
      analysis += `- Client output: ${projectConfig.clientOutput}\n`;
    }
  } else {
    analysis += `- No donkeylabs.config.ts found\n`;
  }

  // Plugins
  const plugins = listAvailablePlugins();
  analysis += `\n## Plugins (${plugins.length})\n`;
  if (plugins.length === 0) {
    analysis += `No plugins found. Create one with \`create_plugin\` tool.\n`;
  } else {
    for (const plugin of plugins) {
      const pluginPath = join(projectRoot, projectConfig.pluginsDir, plugin, "index.ts");
      const content = readFileSync(pluginPath, "utf-8");

      const hasMigrations = existsSync(join(projectRoot, projectConfig.pluginsDir, plugin, "migrations"));
      const hasSchema = existsSync(join(projectRoot, projectConfig.pluginsDir, plugin, "schema.ts"));
      const depsMatch = content.match(/dependencies:\s*\[([^\]]*)\]/);

      analysis += `\n### ${plugin}\n`;
      analysis += `- Path: ${projectConfig.pluginsDir}/${plugin}/\n`;
      analysis += `- Database: ${hasSchema || hasMigrations ? "yes" : "no"}\n`;
      if (depsMatch && depsMatch[1].trim()) {
        analysis += `- Dependencies: ${depsMatch[1].trim()}\n`;
      }

      // Extract service methods
      const serviceMatch = content.match(/service:\s*async\s*\([^)]*\)\s*=>\s*\({([^}]+)\}/s);
      if (serviceMatch) {
        const methods = [...serviceMatch[1].matchAll(/(\w+):\s*(?:async\s*)?\(/g)].map(m => m[1]);
        if (methods.length > 0) {
          analysis += `- Methods: ${methods.join(", ")}\n`;
        }
      }
    }
  }

  // Routes
  const routers = listAvailableRouters();
  analysis += `\n## Routes (${routers.length} files)\n`;
  if (routers.length === 0) {
    analysis += `No route files found. Create one with \`create_router\` tool.\n`;
  } else {
    for (const router of routers.slice(0, 10)) {
      analysis += `- ${router}\n`;
    }
    if (routers.length > 10) {
      analysis += `- ... and ${routers.length - 10} more\n`;
    }
  }

  // Generated types
  const genDir = join(projectRoot, ".@donkeylabs/server");
  analysis += `\n## Generated Types\n`;
  if (existsSync(genDir)) {
    analysis += `- Output: .@donkeylabs/server/\n`;
    analysis += `- Run \`donkeylabs generate\` to regenerate after changes\n`;
  } else {
    analysis += `- Not generated yet. Run \`donkeylabs generate\` after adding plugins/routes.\n`;
  }

  // Generated API Client
  const clientPath = projectConfig.clientOutput || (projectConfig.adapter === "sveltekit" ? "src/lib/api.ts" : null);
  if (clientPath) {
    const fullClientPath = join(projectRoot, clientPath);
    analysis += `\n## Generated API Client\n`;
    if (existsSync(fullClientPath)) {
      analysis += `- Path: ${clientPath}\n`;

      // Extract available methods from the client
      const clientContent = readFileSync(fullClientPath, "utf-8");

      // Find namespace properties (e.g., "health = {" or "users = {")
      const namespaceMatches = [...clientContent.matchAll(/^\s+(\w+)\s*=\s*\{/gm)];
      const namespaces: string[] = [];
      for (const match of namespaceMatches) {
        if (match[1] && !["sse", "constructor"].includes(match[1])) {
          namespaces.push(match[1]);
        }
      }

      if (namespaces.length > 0) {
        analysis += `- Available namespaces: ${namespaces.join(", ")}\n`;
      }

      // Extract route type namespaces from "export namespace Routes {"
      const routeTypesMatch = clientContent.match(/export namespace Routes \{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s);
      if (routeTypesMatch) {
        const typeNamespaces = [...routeTypesMatch[1].matchAll(/export namespace (\w+)/g)].map(m => m[1]);
        if (typeNamespaces.length > 0) {
          analysis += `- Route types: Routes.${typeNamespaces.join(", Routes.")}\n`;
        }
      }

      // SvelteKit-specific usage
      if (projectConfig.adapter === "sveltekit") {
        const importPath = clientPath.startsWith("src/lib/") ? "$lib/" + clientPath.slice(8).replace(/\.ts$/, "") : clientPath.replace(/\.ts$/, "");
        analysis += `\n### Usage in SvelteKit\n`;
        analysis += `\`\`\`typescript\n`;
        analysis += `// +page.server.ts (SSR - direct calls, no HTTP)\n`;
        analysis += `import { createApi } from '${importPath}';\n`;
        analysis += `export const load = async ({ locals }) => {\n`;
        analysis += `  const api = createApi({ locals });\n`;
        analysis += `  const data = await api.${namespaces[0] || "namespace"}.methodName({});\n`;
        analysis += `  return { data };\n`;
        analysis += `};\n`;
        analysis += `\`\`\`\n`;
        analysis += `\n\`\`\`svelte\n`;
        analysis += `<!-- +page.svelte (Browser - HTTP calls) -->\n`;
        analysis += `<script>\n`;
        analysis += `  import { createApi } from '${importPath}';\n`;
        analysis += `  const api = createApi();\n`;
        analysis += `</script>\n`;
        analysis += `\`\`\`\n`;
      }
    } else {
      analysis += `- Path: ${clientPath} (not generated yet)\n`;
      analysis += `- Run \`donkeylabs generate\` to create the client\n`;
    }
  }

  return analysis;
}

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

const tools = [
  {
    name: "get_project_info",
    description: "Get current project structure, plugins, and routes. Run this first to understand the project.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_architecture_guidance",
    description: "Get step-by-step guidance for implementing a feature. Describes which tools to use in what order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "What you want to accomplish (e.g., 'add user authentication', 'create CRUD for products')",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "create_plugin",
    description: `Create a new plugin with correct directory structure.

**Plugins can implement:**
- **service**: Business logic methods (ctx.plugins.name.method())
- **init hook**: Cron jobs, event listeners, job registration
- **customErrors**: Typed error definitions
- **events**: Typed event schemas for SSE/pub-sub
- **middleware**: Request middleware (auth, rate limiting, etc.)
- **handlers**: Custom request handlers (beyond typed/raw)

**Plugin modifiers:**
- withSchema<T>(): Add typed database access
- withConfig<T>(): Make plugin configurable at registration`,
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Plugin name in camelCase (e.g., 'auth', 'users', 'orders')",
        },
        hasSchema: {
          type: "boolean",
          description: "Whether the plugin needs database schema (creates migrations folder and uses withSchema<>())",
          default: false,
        },
        hasConfig: {
          type: "boolean",
          description: "Whether the plugin accepts configuration at registration (uses withConfig<>())",
          default: false,
        },
        configFields: {
          type: "string",
          description: "If hasConfig=true, TypeScript interface fields for config (e.g., 'apiKey: string; sandbox?: boolean')",
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
    name: "add_service_method",
    description: "Add a method to a plugin's service. Service methods contain business logic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginName: {
          type: "string",
          description: "Name of the plugin",
        },
        methodName: {
          type: "string",
          description: "Name of the method (camelCase)",
        },
        params: {
          type: "string",
          description: "Method parameters (e.g., 'userId: string, data: { name: string }')",
        },
        returnType: {
          type: "string",
          description: "Return type (e.g., 'Promise<User>', '{ id: string }')",
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
    name: "add_migration",
    description: "Create a numbered Kysely migration file for a plugin's database schema. Use Kysely schema builder - NOT raw SQL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginName: {
          type: "string",
          description: "Name of the plugin",
        },
        migrationName: {
          type: "string",
          description: "Descriptive name (e.g., 'create_users', 'add_email_column')",
        },
        upCode: {
          type: "string",
          description: "Kysely schema builder code for up migration. Example: 'await db.schema.createTable(\"users\").addColumn(\"id\", \"text\", (col) => col.primaryKey()).addColumn(\"email\", \"text\", (col) => col.notNull().unique()).execute();'",
        },
        downCode: {
          type: "string",
          description: "Kysely schema builder code for down migration. Example: 'await db.schema.dropTable(\"users\").execute();'",
        },
      },
      required: ["pluginName", "migrationName", "upCode"],
    },
  },
  {
    name: "create_router",
    description: "Create a new router file with proper structure. Routers group related routes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        routerPath: {
          type: "string",
          description: "Path for new router (e.g., 'src/routes/users/index.ts')",
        },
        routerName: {
          type: "string",
          description: "Export name for router (e.g., 'usersRouter')",
        },
        prefix: {
          type: "string",
          description: "Route prefix - routes will be named 'prefix.routeName' (e.g., 'users')",
        },
      },
      required: ["routerPath", "routerName", "prefix"],
    },
  },
  {
    name: "add_route",
    description: "Add a new route to an existing router. Creates a class-based handler by default.",
    inputSchema: {
      type: "object" as const,
      properties: {
        routerFile: {
          type: "string",
          description: "Path to the router file (relative to project root)",
        },
        routeName: {
          type: "string",
          description: "Route name (e.g., 'list', 'get', 'create')",
        },
        inputSchema: {
          type: "string",
          description: "Zod schema for input validation (e.g., 'z.object({ id: z.string() })')",
        },
        outputType: {
          type: "string",
          description: "Zod schema for output validation (optional)",
        },
        handler: {
          type: "string",
          description: "Handler implementation code (the body of the handle method)",
        },
        useClassHandler: {
          type: "boolean",
          description: "Generate a class-based handler in handlers/ directory (recommended)",
          default: true,
        },
      },
      required: ["routerFile", "routeName", "handler"],
    },
  },
  {
    name: "add_handler_to_router",
    description: "Register an existing handler class to a router (when handler already exists).",
    inputSchema: {
      type: "object" as const,
      properties: {
        routerFile: {
          type: "string",
          description: "Path to router file",
        },
        handlerName: {
          type: "string",
          description: "Handler class name to import",
        },
        handlerPath: {
          type: "string",
          description: "Relative import path for handler (e.g., './handlers/create-user')",
        },
        routeName: {
          type: "string",
          description: "Route name",
        },
        inputSchema: {
          type: "string",
          description: "Zod input schema",
        },
        outputSchema: {
          type: "string",
          description: "Zod output schema (optional)",
        },
      },
      required: ["routerFile", "handlerName", "handlerPath", "routeName"],
    },
  },
  {
    name: "extend_plugin",
    description: `Add custom errors, events, middleware, or handlers to an existing plugin.

**Extension types:**
- **error**: Custom error type (e.g., UserNotFound with status 404)
- **event**: Typed event for SSE/pub-sub
- **middleware**: Request middleware (auth, rate limiting, etc.)
- **handler**: Custom request handler (beyond typed/raw)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginName: {
          type: "string",
          description: "Name of the plugin",
        },
        extensionType: {
          type: "string",
          enum: ["error", "event", "middleware", "handler"],
          description: "Type of extension to add",
        },
        name: {
          type: "string",
          description: "Name of the extension (e.g., 'UserNotFound' for error, 'user.created' for event, 'xml' for handler)",
        },
        params: {
          type: "object",
          description: "Extension-specific parameters",
          properties: {
            code: { type: "string", description: "Error code (for errors)" },
            status: { type: "number", description: "HTTP status code (for errors)" },
            message: { type: "string", description: "Default message (for errors)" },
            schema: { type: "string", description: "Zod schema (for events)" },
            implementation: { type: "string", description: "Middleware or handler implementation code" },
            handlerSignature: { type: "string", description: "TypeScript type for handler function (for handlers)" },
          },
        },
      },
      required: ["pluginName", "extensionType", "name"],
    },
  },
  {
    name: "add_cron",
    description: "Schedule a new cron job in a plugin's init hook.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginName: {
          type: "string",
          description: "Plugin to add the cron job to",
        },
        name: {
          type: "string",
          description: "Cron job name (for logging/identification)",
        },
        schedule: {
          type: "string",
          description: "Cron schedule expression (e.g., '0 * * * *' for hourly, '0 0 * * *' for daily)",
        },
        implementation: {
          type: "string",
          description: "Task implementation code",
        },
      },
      required: ["pluginName", "name", "schedule", "implementation"],
    },
  },
  {
    name: "add_event",
    description: "Register a new event type with its schema in a plugin.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginName: {
          type: "string",
          description: "Plugin to register the event in",
        },
        name: {
          type: "string",
          description: "Event name (e.g., 'user.created', 'order.completed')",
        },
        schema: {
          type: "string",
          description: "Zod schema for event data (e.g., 'z.object({ userId: z.string() })')",
        },
      },
      required: ["pluginName", "name", "schema"],
    },
  },
  {
    name: "add_async_job",
    description: "Register a new background job handler in a plugin.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginName: {
          type: "string",
          description: "Plugin to register the job in",
        },
        name: {
          type: "string",
          description: "Job name (e.g., 'send-email', 'process-payment')",
        },
        implementation: {
          type: "string",
          description: "Job handler implementation code",
        },
      },
      required: ["pluginName", "name", "implementation"],
    },
  },
  {
    name: "add_sse_route",
    description: "Add a Server-Sent Events (SSE) route for real-time updates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        routerFile: {
          type: "string",
          description: "Path to router file",
        },
        routeName: {
          type: "string",
          description: "Route name for SSE endpoint",
        },
        channel: {
          type: "string",
          description: "SSE channel name to subscribe to",
        },
      },
      required: ["routerFile", "routeName", "channel"],
    },
  },
  {
    name: "list_plugins",
    description: "List all plugins with their service methods and dependencies.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "generate_types",
    description: "Run type generation to update registry and context types after making changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          enum: ["all", "registry", "context", "client"],
          description: "What to generate (default: all)",
          default: "all",
        },
      },
    },
  },
  {
    name: "run_codegen",
    description: "Run CLI codegen commands (generate, generate-client).",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          enum: ["generate", "generate-client", "generate-types"],
          description: "Which codegen command to run",
        },
        outputPath: {
          type: "string",
          description: "Output path for generated files (optional)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "generate_client",
    description: "Generate a fully-typed API client from routes. For SvelteKit projects, generates a unified client that supports SSR direct calls (no HTTP overhead) and browser HTTP calls.",
    inputSchema: {
      type: "object" as const,
      properties: {
        outputPath: {
          type: "string",
          description: "Output path for generated client (e.g., 'src/lib/api.ts' for SvelteKit, './client' for standalone)",
        },
      },
    },
  },
];

// =============================================================================
// TOOL IMPLEMENTATIONS
// =============================================================================

async function getProjectInfo(): Promise<string> {
  return await generateProjectAnalysis();
}

async function getArchitectureGuidance(args: { task: string }): Promise<string> {
  const { task } = args;
  const taskLower = task.toLowerCase();

  const plugins = listAvailablePlugins();
  const routers = listAvailableRouters();

  let guidance = `# Architecture Guidance\n\n**Task:** ${task}\n\n`;

  // Always include the Plugin vs Route decision guidance
  guidance += `## When to Create a Plugin vs Route\n\n`;
  guidance += `**Core Principle:** Plugins = Reusable Business Logic | Routes = App-Specific API Endpoints\n\n`;
  guidance += `### Create a Plugin when:\n`;
  guidance += `- The logic could be **reused** across multiple routes or apps (auth, email, payments)\n`;
  guidance += `- You need **database tables** for a domain concept (users, orders, products)\n`;
  guidance += `- The functionality is **self-contained** with its own data and operations\n`;
  guidance += `- You're building **cross-cutting concerns** like middleware\n\n`;
  guidance += `### Create a Route when:\n`;
  guidance += `- **Exposing plugin functionality** via HTTP (thin wrapper calling plugin methods)\n`;
  guidance += `- **Combining multiple plugins** for a specific use case\n`;
  guidance += `- Building **app-specific endpoints** that don't need reuse\n`;
  guidance += `- **Simple operations** that don't warrant a full plugin\n\n`;
  guidance += `### Workflow:\n`;
  guidance += `1. Identify reusable domains → Create plugins with business logic\n`;
  guidance += `2. Create routes that use plugins to expose functionality\n`;
  guidance += `3. Keep routes thin - delegate to plugin service methods\n\n`;
  guidance += `---\n\n`;

  // Pattern matching for common tasks
  if (taskLower.includes("auth") || taskLower.includes("login") || taskLower.includes("user")) {
    guidance += `## Recommended Approach: Authentication System\n\n`;
    guidance += `### Step 1: Create Auth Plugin\n`;
    guidance += `\`\`\`\nTool: create_plugin\n  name: "auth"\n  hasSchema: true\n\`\`\`\n\n`;

    guidance += `### Step 2: Add Database Migration\n`;
    guidance += `\`\`\`\nTool: add_migration\n  pluginName: "auth"\n  migrationName: "create_users"\n  upCode: 'await db.schema.createTable("users").addColumn("id", "integer", (col) => col.primaryKey().autoIncrement()).addColumn("email", "text", (col) => col.notNull().unique()).addColumn("password_hash", "text", (col) => col.notNull()).addColumn("created_at", "text", (col) => col.defaultTo("CURRENT_TIMESTAMP")).execute();'\n  downCode: 'await db.schema.dropTable("users").execute();'\n\`\`\`\n\n`;

    guidance += `### Step 3: Add Service Methods\n`;
    guidance += `Add these methods using \`add_service_method\`:\n`;
    guidance += `- \`createUser(email, password)\` - Create new user\n`;
    guidance += `- \`validateCredentials(email, password)\` - Check login\n`;
    guidance += `- \`generateToken(userId)\` - Create JWT/session\n`;
    guidance += `- \`validateToken(token)\` - Verify token\n\n`;

    guidance += `### Step 4: Add Auth Middleware\n`;
    guidance += `\`\`\`\nTool: extend_plugin\n  pluginName: "auth"\n  extensionType: "middleware"\n  name: "authRequired"\n\`\`\`\n\n`;

    guidance += `### Step 5: Create Auth Routes\n`;
    guidance += `\`\`\`\nTool: create_router\n  routerPath: "${projectConfig.routesDir}/auth/index.ts"\n  routerName: "authRouter"\n  prefix: "auth"\n\`\`\`\n\n`;
    guidance += `Then add routes: login, register, logout, me\n\n`;

  } else if (taskLower.includes("crud") || taskLower.includes("api") || taskLower.includes("resource")) {
    const resourceName = extractResourceName(task);

    guidance += `## Recommended Approach: CRUD API for "${resourceName}"\n\n`;

    guidance += `### Step 1: Create Plugin (Business Logic)\n`;
    guidance += `\`\`\`\nTool: create_plugin\n  name: "${resourceName}"\n  hasSchema: true\n\`\`\`\n\n`;

    guidance += `### Step 2: Add Database Migration\n`;
    guidance += `\`\`\`\nTool: add_migration\n  pluginName: "${resourceName}"\n  migrationName: "create_${resourceName}"\n\`\`\`\n\n`;

    guidance += `### Step 3: Add Service Methods\n`;
    guidance += `Using \`add_service_method\`, add:\n`;
    guidance += `- \`list(options)\` - List with pagination/filtering\n`;
    guidance += `- \`getById(id)\` - Get single item\n`;
    guidance += `- \`create(data)\` - Create new item\n`;
    guidance += `- \`update(id, data)\` - Update existing\n`;
    guidance += `- \`delete(id)\` - Delete item\n\n`;

    guidance += `### Step 4: Create Router\n`;
    guidance += `\`\`\`\nTool: create_router\n  routerPath: "${projectConfig.routesDir}/${toKebabCase(resourceName)}/index.ts"\n  routerName: "${resourceName}Router"\n  prefix: "${resourceName}"\n\`\`\`\n\n`;

    guidance += `### Step 5: Add Routes\n`;
    guidance += `Using \`add_route\`, add these routes:\n`;
    guidance += `- list (GET all)\n- get (GET by ID)\n- create (POST)\n- update (PUT)\n- delete (DELETE)\n\n`;

  } else if (taskLower.includes("realtime") || taskLower.includes("sse") || taskLower.includes("live")) {
    guidance += `## Recommended Approach: Real-time Updates with SSE\n\n`;

    guidance += `### Step 1: Create Plugin for State Management\n`;
    guidance += `\`\`\`\nTool: create_plugin\n  name: "realtime"\n\`\`\`\n\n`;

    guidance += `### Step 2: Add Event Types\n`;
    guidance += `\`\`\`\nTool: add_event\n  pluginName: "realtime"\n  name: "update"\n  schema: "z.object({ type: z.string(), data: z.any() })"\n\`\`\`\n\n`;

    guidance += `### Step 3: Add SSE Route\n`;
    guidance += `\`\`\`\nTool: add_sse_route\n  routerFile: "${projectConfig.routesDir}/realtime/index.ts"\n  routeName: "subscribe"\n  channel: "updates"\n\`\`\`\n\n`;

    guidance += `### Step 4: Broadcast Updates\n`;
    guidance += `In your service methods, use:\n`;
    guidance += `\`\`\`typescript\nctx.core.sse.broadcast("updates", "event-name", { data });\n\`\`\`\n\n`;

  } else if (taskLower.includes("cron") || taskLower.includes("schedule") || taskLower.includes("periodic")) {
    guidance += `## Recommended Approach: Scheduled Tasks\n\n`;

    guidance += `### Step 1: Add to Existing Plugin or Create New One\n`;
    guidance += `Cron jobs should belong to a plugin that owns the related business logic.\n\n`;

    guidance += `### Step 2: Add Cron Job\n`;
    guidance += `\`\`\`\nTool: add_cron\n  pluginName: "<your-plugin>"\n  name: "daily-cleanup"\n  schedule: "0 0 * * *"  // Daily at midnight\n  implementation: "// Your task code"\n\`\`\`\n\n`;

    guidance += `### Common Cron Schedules:\n`;
    guidance += `- \`* * * * *\` - Every minute\n`;
    guidance += `- \`0 * * * *\` - Every hour\n`;
    guidance += `- \`0 0 * * *\` - Daily at midnight\n`;
    guidance += `- \`0 0 * * 0\` - Weekly on Sunday\n`;
    guidance += `- \`0 0 1 * *\` - Monthly on 1st\n\n`;

  } else if (taskLower.includes("job") || taskLower.includes("background") || taskLower.includes("queue")) {
    guidance += `## Recommended Approach: Background Jobs\n\n`;

    guidance += `### Step 1: Register Job Handler in Plugin\n`;
    guidance += `\`\`\`\nTool: add_async_job\n  pluginName: "<your-plugin>"\n  name: "process-order"\n  implementation: "// Job handler code"\n\`\`\`\n\n`;

    guidance += `### Step 2: Enqueue Jobs from Service Methods\n`;
    guidance += `\`\`\`typescript\nawait ctx.core.jobs.enqueue("process-order", { orderId: "123" });\n\`\`\`\n\n`;

    guidance += `### Features:\n`;
    guidance += `- Automatic retries with configurable attempts\n`;
    guidance += `- Delayed execution with scheduling\n`;
    guidance += `- Job status tracking\n`;
    guidance += `- Event emission on completion/failure\n\n`;

  } else {
    guidance += `## General Approach\n\n`;
    guidance += `1. **Identify the domain** - What entity/concept are you working with?\n`;
    guidance += `2. **Create a plugin** for business logic using \`create_plugin\`\n`;
    guidance += `3. **Add database schema** if needed using \`add_migration\`\n`;
    guidance += `4. **Add service methods** for business logic using \`add_service_method\`\n`;
    guidance += `5. **Create routes** to expose the functionality using \`create_router\` and \`add_route\`\n`;
    guidance += `6. **Run type generation** using \`generate_types\`\n`;
    guidance += `7. **Generate API client** using \`generate_client\` for typed frontend calls\n\n`;
  }

  // Current project state
  guidance += `## Current Project State\n\n`;
  guidance += `- **Plugins:** ${plugins.length > 0 ? plugins.join(", ") : "none"}\n`;
  guidance += `- **Router files:** ${routers.length}\n`;
  if (projectConfig.adapter) {
    guidance += `- **Adapter:** ${projectConfig.adapter}\n`;
  }

  // Warnings
  if (taskLower.includes("protected") || taskLower.includes("secure")) {
    if (!plugins.includes("auth")) {
      guidance += `\n### Warning\n`;
      guidance += `No auth plugin detected. Create one first if you need protected routes.\n`;
    }
  }

  // Client generation reminder
  guidance += `\n## Final Step: Generate API Client\n`;
  guidance += `After creating routes, generate a typed client:\n`;
  guidance += `\`\`\`\nTool: generate_client\n\`\`\`\n`;
  if (projectConfig.adapter === "sveltekit") {
    guidance += `\n**SvelteKit Benefit:** The generated client supports:\n`;
    guidance += `- **SSR:** Direct calls via \`locals\` (no HTTP overhead!)\n`;
    guidance += `- **Browser:** HTTP calls automatically\n`;
  }

  // Common mistakes section
  guidance += `\n## ⚠️ Common Mistakes to Avoid\n\n`;

  guidance += `### Database Queries\n`;
  guidance += `- ❌ **NEVER use raw SQL** - always use Kysely query builder\n`;
  guidance += `- ❌ \`db.execute(sql\\\`SELECT * FROM users\\\`)\` - WRONG\n`;
  guidance += `- ✅ \`db.selectFrom("users").selectAll().execute()\` - CORRECT\n\n`;

  guidance += `### After Making Changes\n`;
  guidance += `- ❌ Forgetting to run \`generate_types\` after adding migrations\n`;
  guidance += `- ❌ Forgetting to run \`generate_client\` after adding routes\n`;
  guidance += `- ✅ Always regenerate types after schema/route changes\n\n`;

  guidance += `### Plugin Registration\n`;
  guidance += `- ❌ Creating a plugin but not registering it with \`server.registerPlugin()\`\n`;
  guidance += `- ❌ Creating routes but not adding router with \`server.use()\`\n`;
  guidance += `- ✅ Check server entry file to ensure plugin/router is registered\n\n`;

  if (projectConfig.adapter === "sveltekit") {
    guidance += `### SvelteKit-Specific\n`;
    guidance += `- ❌ \`createApi()\` in +page.server.ts - WRONG (won't use direct calls)\n`;
    guidance += `- ✅ \`createApi({ locals })\` in +page.server.ts - CORRECT\n`;
    guidance += `- ❌ Importing from relative path instead of \`$lib/api\`\n`;
    guidance += `- ✅ \`import { createApi } from '$lib/api'\`\n\n`;
  }

  guidance += `### Route Handlers\n`;
  guidance += `- ❌ Putting business logic directly in route handlers\n`;
  guidance += `- ✅ Delegate to plugin service methods, keep routes thin\n`;
  guidance += `- ❌ Returning raw data without proper typing\n`;
  guidance += `- ✅ Define output schema with Zod for type safety\n\n`;

  guidance += `## 🛑 When to Stop and Ask the User\n\n`;
  guidance += `**IMPORTANT:** If you're unsure about any of the following, STOP and ask the user before proceeding:\n\n`;
  guidance += `- **Architecture decisions** - "Should this be a plugin or just a route?"\n`;
  guidance += `- **Database schema design** - "What columns/relations do you need?"\n`;
  guidance += `- **Naming conventions** - "What should this entity/route be called?"\n`;
  guidance += `- **Business logic** - "How should this calculation/validation work?"\n`;
  guidance += `- **Integration patterns** - "How does this connect to existing code?"\n`;
  guidance += `- **Something doesn't work** - Don't keep trying different things, ask for help\n\n`;
  guidance += `It's better to ask ONE clarifying question than to build something wrong and have to redo it.\n\n`;

  guidance += `\n## Documentation Resources\n`;
  guidance += `- \`donkeylabs://docs/database\` - Kysely queries, CRUD, joins, transactions\n`;
  guidance += `- \`donkeylabs://docs/plugins\` - Plugin patterns & When to Create a Plugin vs Route\n`;
  guidance += `- \`donkeylabs://docs/router\` - Route patterns & best practices\n`;
  guidance += `- \`donkeylabs://docs/api-client\` - Generated client usage\n`;
  guidance += `- \`donkeylabs://docs/handlers\` - Class-based handlers\n`;

  return guidance;
}

function extractResourceName(task: string): string {
  // Try to extract a resource name from the task description
  const patterns = [
    /crud\s+(?:for\s+)?(\w+)/i,
    /api\s+(?:for\s+)?(\w+)/i,
    /(\w+)\s+api/i,
    /(\w+)\s+crud/i,
    /manage\s+(\w+)/i,
    /(\w+)\s+management/i,
  ];

  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return "items";
}

async function createPlugin(args: {
  name: string;
  hasSchema?: boolean;
  hasConfig?: boolean;
  configFields?: string;
  dependencies?: string[];
}): Promise<string> {
  const { name, hasSchema = false, hasConfig = false, configFields = "", dependencies = [] } = args;

  // Validation
  const projectValid = validateProjectExists();
  if (!projectValid.valid) {
    return formatError(projectValid.error!, undefined, projectValid.suggestion);
  }

  const nameValid = validatePluginName(name);
  if (!nameValid.valid) {
    return formatError(nameValid.error!, undefined, nameValid.suggestion);
  }

  const pluginDir = join(projectRoot, projectConfig.pluginsDir, name);
  if (existsSync(pluginDir)) {
    const existingContent = readFileSync(join(pluginDir, "index.ts"), "utf-8");
    const methods = [...existingContent.matchAll(/(\w+):\s*(?:async\s*)?\(/g)].map(m => m[1]);

    return formatError(
      `Plugin "${name}" already exists`,
      `Location: ${projectConfig.pluginsDir}/${name}/\nExisting methods: ${methods.join(", ") || "none"}`,
      `To add to this plugin:\n- Use \`add_service_method\` to add methods\n- Use \`extend_plugin\` to add errors/events/middleware\n- Use \`add_migration\` to add database changes`,
      "add_service_method"
    );
  }

  // Validate dependencies exist
  for (const dep of dependencies) {
    const depValid = validatePluginExists(dep);
    if (!depValid.valid) {
      return formatError(
        `Dependency plugin "${dep}" not found`,
        undefined,
        `Create the dependency plugin first, or remove it from dependencies.`,
        "create_plugin"
      );
    }
  }

  mkdirSync(pluginDir, { recursive: true });

  // Build the createPlugin chain
  let createPluginChain = "createPlugin";
  if (hasSchema) {
    // Note: DB type is auto-generated by kysely-codegen from migrations
    // Use {} until `donkeylabs generate` creates schema.ts, then change to DB
    createPluginChain += `\n  .withSchema<{}>() // Change to <DB> after running \`donkeylabs generate\``;
  }
  if (hasConfig) {
    createPluginChain += `\n  .withConfig<${toPascalCase(name)}Config>()`;
  }
  createPluginChain += "\n  .define";

  // Generate imports
  let imports = `import { createPlugin } from "@donkeylabs/server";\n`;
  imports += `import { z } from "zod";\n`;
  // Note: dependencies are just string names, no imports needed
  if (hasSchema) {
    // Note: schema.ts is auto-generated after running `donkeylabs generate`
    // Once generated, uncomment this import:
    imports += `// import type { DB } from "./schema"; // Uncomment after running \`donkeylabs generate\`\n`;
  }

  // Generate config interface if needed
  let configInterface = "";
  if (hasConfig) {
    const fields = configFields || "  // Add your config fields here\n  // apiKey: string;\n  // sandbox?: boolean;";
    configInterface = `\nexport interface ${toPascalCase(name)}Config {\n  ${fields}\n}\n`;
  }

  const depsArray = dependencies.length > 0
    ? `\n  dependencies: [${dependencies.map(d => `"${d}"`).join(", ")}] as const,`
    : "";

  // Build the service context comment based on what's available
  let ctxComment = "    // ctx.plugins - access other plugin services";
  if (hasSchema) {
    ctxComment += "\n    // ctx.db - typed database access (Kysely)";
  }
  if (hasConfig) {
    ctxComment += "\n    // ctx.config - your plugin configuration";
  }
  if (dependencies.length > 0) {
    ctxComment += `\n    // ctx.deps - dependency services: ${dependencies.join(", ")}`;
  }

  const indexContent = `${imports}${configInterface}
export const ${name}Plugin = ${createPluginChain}({
  name: "${name}",${depsArray}

  service: async (ctx) => {
${ctxComment}
    // ctx.core - logger, cache, events, cron, jobs, sse, rateLimiter

    return {
      // Service methods are available via ctx.plugins.${name}
      hello: () => "Hello from ${name} plugin!",
    };
  },

  // Uncomment to add initialization logic (crons, event listeners, jobs)
  // init: (ctx, service) => {
  //   // Register cron jobs
  //   // ctx.core.cron.schedule("0 * * * *", async () => { ... }, { name: "hourly-task" });
  //
  //   // Register async jobs
  //   // ctx.core.jobs.register("job-name", async (data) => { ... });
  //
  //   // Listen for events
  //   // ctx.core.events.on("user.created", async (data) => { ... });
  //
  //   ctx.core.logger.info("${name} plugin initialized");
  // },
});
`;

  await Bun.write(join(pluginDir, "index.ts"), indexContent);

  // Create migrations folder if plugin has schema
  // Note: schema.ts is auto-generated by `donkeylabs generate` from migrations
  // No initial migration is created - use add_migration tool to add migrations
  if (hasSchema) {
    mkdirSync(join(pluginDir, "migrations"), { recursive: true });
  }

  // Build registration example based on plugin type
  let registrationExample = "";
  if (hasConfig) {
    registrationExample = `\`\`\`typescript
// server.ts
server.registerPlugin(${name}Plugin({
  // Your config here
}));
\`\`\``;
  } else {
    registrationExample = `\`\`\`typescript
// server.ts
server.registerPlugin(${name}Plugin);
\`\`\``;
  }

  return `## Plugin Created: ${name}

**Location:** ${projectConfig.pluginsDir}/${name}/
**Files created:**
- index.ts (plugin definition)${hasSchema ? "\n- migrations/ (empty - use add_migration to add)" : ""}

**Plugin features:**
${hasSchema ? "- ✅ Database schema (withSchema<>)\n" : ""}${hasConfig ? "- ✅ Configurable (withConfig<>)\n" : ""}- Service with ctx.core (logger, cache, events, cron, jobs, sse, rateLimiter)
- Init hook for startup logic (crons, jobs, event listeners)

### Register Plugin

${registrationExample}

### Next Steps

1. ${hasSchema ? "Use \\`add_migration\\` to create your database schema" : "Add service methods using `add_service_method`"}
2. ${hasSchema ? "**IMPORTANT:** Run \\`donkeylabs generate\\` after migrations to generate schema types" : "Register the plugin in your server"}
3. ${hasSchema ? "Update plugin to use generated DB type: \\`.withSchema<DB>()\\` and import from ./schema" : "Use \\`extend_plugin\\` to add errors, events, or middleware"}

### Example Usage

\`\`\`typescript
// In your route handler:
const result = ctx.plugins.${name}.hello();
\`\`\`

### ⚠️ Reminders
- **Don't forget** to register the plugin in your server entry file
- **Use Kysely** for all database queries, never raw SQL
- **Ask the user** if you're unsure about the schema design or business logic
`;
}

async function addServiceMethod(args: {
  pluginName: string;
  methodName: string;
  params?: string;
  returnType?: string;
  implementation: string;
}): Promise<string> {
  const { pluginName, methodName, params = "", returnType = "void", implementation } = args;

  const pluginValid = validatePluginExists(pluginName);
  if (!pluginValid.valid) {
    return formatError(pluginValid.error!, undefined, pluginValid.suggestion, "create_plugin");
  }

  const pluginFile = join(projectRoot, projectConfig.pluginsDir, pluginName, "index.ts");
  const content = await Bun.file(pluginFile).text();

  // Check if method already exists
  if (content.includes(`${methodName}:`)) {
    return formatError(
      `Method "${methodName}" already exists in ${pluginName} plugin`,
      undefined,
      "Choose a different method name or edit the existing method directly."
    );
  }

  // Find the service return object
  const serviceMatch = content.match(/service:\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?return\s*\{/);
  if (!serviceMatch) {
    // Try simpler pattern for arrow function style
    const simpleMatch = content.match(/service:\s*async\s*\([^)]*\)\s*=>\s*\(\{/);
    if (!simpleMatch) {
      return formatError(
        "Could not find service definition",
        `File: ${projectConfig.pluginsDir}/${pluginName}/index.ts`,
        "Make sure the plugin has a service property with a return statement."
      );
    }

    const insertPoint = simpleMatch.index! + simpleMatch[0].length;
    const methodDef = `
      ${methodName}: ${params ? `async (${params})` : "async ()"}: ${returnType.includes("Promise") ? returnType : `Promise<${returnType}>`} => {
        ${implementation}
      },`;

    const newContent = content.slice(0, insertPoint) + methodDef + content.slice(insertPoint);
    await Bun.write(pluginFile, newContent);
  } else {
    const insertPoint = serviceMatch.index! + serviceMatch[0].length;
    const methodDef = `
        ${methodName}: ${params ? `async (${params})` : "async ()"}: ${returnType.includes("Promise") ? returnType : `Promise<${returnType}>`} => {
          ${implementation}
        },`;

    const newContent = content.slice(0, insertPoint) + methodDef + content.slice(insertPoint);
    await Bun.write(pluginFile, newContent);
  }

  return `## Method Added: ${methodName}

**Plugin:** ${pluginName}
**Signature:** \`${methodName}(${params}): ${returnType}\`

### Usage

\`\`\`typescript
// In route handlers or other plugins:
const result = await ctx.plugins.${pluginName}.${methodName}(${params ? "..." : ""});
\`\`\`

**Reminder:** Run \`donkeylabs generate\` to update types.
`;
}

async function addMigration(args: {
  pluginName: string;
  migrationName: string;
  upCode: string;
  downCode?: string;
}): Promise<string> {
  const { pluginName, migrationName, upCode, downCode = "" } = args;

  const pluginValid = validatePluginExists(pluginName);
  if (!pluginValid.valid) {
    return formatError(pluginValid.error!, undefined, pluginValid.suggestion, "create_plugin");
  }

  const migrationsDir = join(projectRoot, projectConfig.pluginsDir, pluginName, "migrations");

  if (!existsSync(migrationsDir)) {
    mkdirSync(migrationsDir, { recursive: true });
  }

  // Find next migration number
  const existing = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => parseInt(f.split("_")[0], 10))
    .filter((n) => !isNaN(n));

  const nextNum = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  const numStr = String(nextNum).padStart(3, "0");
  const filename = `${numStr}_${migrationName}.ts`;

  const content = `import { Kysely } from "kysely";

/**
 * Migration: ${numStr}_${migrationName}
 * Created: ${new Date().toISOString()}
 * Plugin: ${pluginName}
 */

export async function up(db: Kysely<any>): Promise<void> {
  ${upCode}
}

export async function down(db: Kysely<any>): Promise<void> {
  ${downCode || "// Add rollback logic here"}
}
`;

  await Bun.write(join(migrationsDir, filename), content);

  return `## Migration Created: ${filename}

**Plugin:** ${pluginName}
**Path:** ${projectConfig.pluginsDir}/${pluginName}/migrations/${filename}

### ⚠️ REQUIRED: Run Codegen

After creating/editing migrations, you MUST run:
\`\`\`bash
donkeylabs generate
\`\`\`

This generates \`${pluginName}/schema.ts\` with typed DB interfaces.

### After Codegen

Update the plugin to use the generated types:
\`\`\`typescript
import type { DB } from "./schema";

export const ${pluginName}Plugin = createPlugin
  .withSchema<DB>()
  .define({ ... });
\`\`\`

The migration will run automatically on server start.

### ⚠️ Reminders
- **Use Kysely schema builder** - never raw SQL in migrations
- **Ask the user** if unsure about column types, relations, or schema design
- **Test migrations** by running the server and checking for errors
`;
}

async function createRouter(args: {
  routerPath: string;
  routerName: string;
  prefix: string;
}): Promise<string> {
  const { routerPath, routerName, prefix } = args;

  const projectValid = validateProjectExists();
  if (!projectValid.valid) {
    return formatError(projectValid.error!, undefined, projectValid.suggestion);
  }

  // Validate path - must be in the configured routes directory
  if (!routerPath.includes(projectConfig.routesDir)) {
    return formatError(
      "Invalid router path",
      `Path: ${routerPath}`,
      `Router files should be in ${projectConfig.routesDir}/ directory.\nSuggested path: ${projectConfig.routesDir}/${prefix}/index.ts`
    );
  }

  const fullPath = join(projectRoot, routerPath);

  if (existsSync(fullPath)) {
    return formatError(
      `Router file already exists`,
      `Path: ${routerPath}`,
      "Use add_route to add routes to the existing router.",
      "add_route"
    );
  }

  // Create directory if needed
  const routerDir = dirname(fullPath);
  if (!existsSync(routerDir)) {
    mkdirSync(routerDir, { recursive: true });
  }

  const content = `import { createRouter } from "@donkeylabs/server";
import { z } from "zod";

export const ${routerName} = createRouter("${prefix}");

// Add routes using the add_route tool or manually:
// ${routerName}.route("list").typed({
//   input: z.object({ page: z.number().default(1) }),
//   handle: async (input, ctx) => {
//     return { items: [], page: input.page };
//   },
// });
`;

  await Bun.write(fullPath, content);

  return `## Router Created: ${routerName}

**Path:** ${routerPath}
**Prefix:** ${prefix} (routes will be named "${prefix}.routeName")

### Next Steps

1. Use \`add_route\` to add routes to this router
2. Register the router in your server entry point:

\`\`\`typescript
import { ${routerName} } from "./${relative(join(projectRoot, "src"), fullPath).replace(/\.ts$/, "")}";
server.use(${routerName});
\`\`\`

### Route Naming

Routes added to this router will be named \`${prefix}.<routeName>\`:
- ${prefix}.list
- ${prefix}.get
- ${prefix}.create

### ⚠️ Reminders
- **Don't forget** to register the router with \`server.use()\` in your server entry
- **Run \`generate_client\`** after adding routes to update the typed client
- **Keep routes thin** - delegate business logic to plugin service methods
`;
}

async function addRoute(args: {
  routerFile: string;
  routeName: string;
  inputSchema?: string;
  outputType?: string;
  handler: string;
  useClassHandler?: boolean;
}): Promise<string> {
  const { routerFile, routeName, inputSchema, outputType, handler, useClassHandler = true } = args;

  const routerValid = validateRouterExists(routerFile);
  if (!routerValid.valid) {
    return formatError(routerValid.error!, undefined, routerValid.suggestion, "create_router");
  }

  const fullPath = join(projectRoot, routerFile);
  const content = await Bun.file(fullPath).text();

  // Check if route already exists
  if (content.includes(`.route("${routeName}")`)) {
    return formatError(
      `Route "${routeName}" already exists`,
      `File: ${routerFile}`,
      "Choose a different route name or edit the existing route directly."
    );
  }

  const routerMatch = content.match(/createRouter\([^)]+\)/);
  if (!routerMatch) {
    return formatError(
      "Could not find createRouter() in file",
      `File: ${routerFile}`,
      "Make sure this is a valid router file with createRouter()."
    );
  }

  let finalHandlerCode = "";
  let importStatement = "";
  let handlerFilePath = "";

  if (useClassHandler) {
    const handlerName = toPascalCase(routeName);
    const handlerClassName = `${handlerName}Handler`;
    const handlerFileName = toKebabCase(routeName);

    const routerDir = dirname(fullPath);
    const handlersDir = join(routerDir, "handlers");

    if (!existsSync(handlersDir)) {
      mkdirSync(handlersDir, { recursive: true });
    }

    // Extract router prefix for proper type path
    const prefixMatch = content.match(/createRouter\(["']([^"']+)["']\)/);
    const prefix = prefixMatch ? toPascalCase(prefixMatch[1]) : "Api";

    // Determine import path based on project type
    const apiImportPath = projectConfig.adapter === "sveltekit" ? "$lib/api" : "@/api";

    const handlerFileContent = `import type { Handler, AppContext, Routes } from "${apiImportPath}";

/**
 * Handler for ${routeName} route
 */
export class ${handlerClassName} implements Handler<Routes.${prefix}.${handlerName}> {
  ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async handle(input: Routes.${prefix}.${handlerName}.Input): Promise<Routes.${prefix}.${handlerName}.Output> {
    ${handler}
  }
}
`;

    handlerFilePath = join(handlersDir, `${handlerFileName}.ts`);

    if (existsSync(handlerFilePath)) {
      return formatError(
        `Handler file already exists`,
        `Path: handlers/${handlerFileName}.ts`,
        "Use a different route name or use add_handler_to_router for existing handlers.",
        "add_handler_to_router"
      );
    }

    await Bun.write(handlerFilePath, handlerFileContent);

    finalHandlerCode = handlerClassName;
    importStatement = `import { ${handlerClassName} } from "./handlers/${handlerFileName}";\n`;
  } else {
    finalHandlerCode = `async (input, ctx) => {
    ${handler}
  }`;
  }

  const newRoute = inputSchema
    ? `\n  .route("${routeName}").typed({
    input: ${inputSchema},${outputType ? `\n    output: ${outputType},` : ""}
    handle: ${finalHandlerCode},
  })`
    : `\n  .route("${routeName}").typed({
    handle: ${finalHandlerCode},
  })`;

  // Update content
  let updatedContent = content;

  if (useClassHandler) {
    const lastImportIdx = updatedContent.lastIndexOf("import ");
    if (lastImportIdx !== -1) {
      const endOfLine = updatedContent.indexOf("\n", lastImportIdx);
      if (endOfLine !== -1) {
        updatedContent = updatedContent.slice(0, endOfLine + 1) + importStatement + updatedContent.slice(endOfLine + 1);
      }
    } else {
      updatedContent = importStatement + updatedContent;
    }
  }

  // Find the last semicolon or closing of router chain
  const insertPoint = updatedContent.lastIndexOf(";");
  if (insertPoint !== -1) {
    updatedContent = updatedContent.slice(0, insertPoint) + newRoute + updatedContent.slice(insertPoint);
  }

  await Bun.write(fullPath, updatedContent);

  return `## Route Added: ${routeName}

**Router:** ${routerFile}${useClassHandler ? `\n**Handler:** handlers/${toKebabCase(routeName)}.ts` : ""}

### Usage

This route is now available at: \`POST /<prefix>.${routeName}\`

${inputSchema ? `**Input:** ${inputSchema}` : "**Input:** none"}
${outputType ? `\n**Output:** ${outputType}` : ""}

### Next Steps

1. ${useClassHandler ? "Implement the handler logic in the handler file" : "The route is ready to use"}
2. Run \`donkeylabs generate\` to update types and regenerate the API client
3. Test the route

### ⚠️ Reminders
- **Run \`generate_client\`** to update the typed API client after adding routes
- **Keep handler thin** - call plugin service methods for business logic
- **Use Kysely** for database queries in your service methods, never raw SQL
${projectConfig.adapter === "sveltekit" ? "- **SvelteKit:** Use \\`createApi({ locals })\\` in +page.server.ts for direct calls" : ""}
`;
}

async function addHandlerToRouter(args: {
  routerFile: string;
  handlerName: string;
  handlerPath: string;
  routeName: string;
  inputSchema?: string;
  outputSchema?: string;
}): Promise<string> {
  const { routerFile, handlerName, handlerPath, routeName, inputSchema, outputSchema } = args;

  const routerValid = validateRouterExists(routerFile);
  if (!routerValid.valid) {
    return formatError(routerValid.error!, undefined, routerValid.suggestion, "create_router");
  }

  const fullPath = join(projectRoot, routerFile);
  let content = await Bun.file(fullPath).text();

  // Add import
  const importStatement = `import { ${handlerName} } from "${handlerPath}";\n`;

  if (!content.includes(importStatement)) {
    const lastImportIdx = content.lastIndexOf("import ");
    if (lastImportIdx !== -1) {
      const endOfLine = content.indexOf("\n", lastImportIdx);
      if (endOfLine !== -1) {
        content = content.slice(0, endOfLine + 1) + importStatement + content.slice(endOfLine + 1);
      }
    } else {
      content = importStatement + content;
    }
  }

  // Add route
  const routeDef = inputSchema
    ? `\n  .route("${routeName}").typed({
    input: ${inputSchema},${outputSchema ? `\n    output: ${outputSchema},` : ""}
    handle: ${handlerName},
  })`
    : `\n  .route("${routeName}").typed({
    handle: ${handlerName},
  })`;

  const insertPoint = content.lastIndexOf(";");
  if (insertPoint !== -1) {
    content = content.slice(0, insertPoint) + routeDef + content.slice(insertPoint);
  }

  await Bun.write(fullPath, content);

  return `## Handler Registered: ${handlerName}

**Route:** ${routeName}
**Router:** ${routerFile}
**Handler import:** ${handlerPath}

Run \`donkeylabs generate\` to update types.
`;
}

async function extendPlugin(args: {
  pluginName: string;
  extensionType: "error" | "event" | "middleware" | "handler";
  name: string;
  params?: {
    code?: string;
    status?: number;
    message?: string;
    schema?: string;
    implementation?: string;
    handlerSignature?: string;
  };
}): Promise<string> {
  const { pluginName, extensionType, name, params = {} } = args;

  const pluginValid = validatePluginExists(pluginName);
  if (!pluginValid.valid) {
    return formatError(pluginValid.error!, undefined, pluginValid.suggestion, "create_plugin");
  }

  const pluginFile = join(projectRoot, projectConfig.pluginsDir, pluginName, "index.ts");
  let content = await Bun.file(pluginFile).text();

  if (extensionType === "error") {
    const { code = name.toUpperCase().replace(/([a-z])([A-Z])/g, "$1_$2"), status = 400, message } = params;

    // Check if customErrors already exists
    if (content.includes("customErrors:")) {
      // Add to existing customErrors
      const errorsMatch = content.match(/customErrors:\s*\{/);
      if (errorsMatch) {
        const insertPoint = errorsMatch.index! + errorsMatch[0].length;
        const errorDef = `\n    ${name}: { status: ${status}, code: "${code}"${message ? `, defaultMessage: "${message}"` : ""} },`;
        content = content.slice(0, insertPoint) + errorDef + content.slice(insertPoint);
      }
    } else {
      // Add customErrors property
      const defineMatch = content.match(/\.define\(\{/);
      if (defineMatch) {
        const insertPoint = defineMatch.index! + defineMatch[0].length;
        const errorsDef = `\n  customErrors: {\n    ${name}: { status: ${status}, code: "${code}"${message ? `, defaultMessage: "${message}"` : ""} },\n  },`;
        content = content.slice(0, insertPoint) + errorsDef + content.slice(insertPoint);
      }
    }

    await Bun.write(pluginFile, content);

    return `## Custom Error Added: ${name}

**Plugin:** ${pluginName}
**Code:** ${code}
**Status:** ${status}

### Usage

\`\`\`typescript
throw ctx.errors.${name}("Error message");
\`\`\`

Run \`donkeylabs generate\` to update types.
`;
  }

  if (extensionType === "event") {
    const { schema = "z.object({})" } = params;

    // Check if events already exists
    if (content.includes("events:")) {
      const eventsMatch = content.match(/events:\s*\{/);
      if (eventsMatch) {
        const insertPoint = eventsMatch.index! + eventsMatch[0].length;
        const eventDef = `\n    "${name}": ${schema},`;
        content = content.slice(0, insertPoint) + eventDef + content.slice(insertPoint);
      }
    } else {
      const defineMatch = content.match(/\.define\(\{/);
      if (defineMatch) {
        const insertPoint = defineMatch.index! + defineMatch[0].length;
        const eventsDef = `\n  events: {\n    "${name}": ${schema},\n  },`;
        content = content.slice(0, insertPoint) + eventsDef + content.slice(insertPoint);
      }
    }

    await Bun.write(pluginFile, content);

    return `## Event Added: ${name}

**Plugin:** ${pluginName}
**Schema:** ${schema}

### Usage

\`\`\`typescript
// Emit event
await ctx.core.events.emit("${name}", { /* data */ });

// Listen for event (in init hook)
ctx.core.events.on("${name}", (data) => { /* handler */ });
\`\`\`

Run \`donkeylabs generate\` to update types.
`;
  }

  if (extensionType === "middleware") {
    const { implementation = "return next();" } = params;

    // Check if middleware function already exists
    if (content.includes("middleware:")) {
      const middlewareMatch = content.match(/middleware:\s*\([^)]*\)\s*=>\s*\(\{/);
      if (middlewareMatch) {
        const insertPoint = middlewareMatch.index! + middlewareMatch[0].length;
        const middlewareDef = `\n    ${name}: createMiddleware(async (req, ctx, next, config) => {
      ${implementation}
    }),`;
        content = content.slice(0, insertPoint) + middlewareDef + content.slice(insertPoint);
      }
    } else {
      // Add middleware property after service
      const serviceEndMatch = content.match(/service:[\s\S]*?\}\),/);
      if (serviceEndMatch) {
        const insertPoint = serviceEndMatch.index! + serviceEndMatch[0].length;
        const middlewareDef = `\n\n  middleware: (ctx, service) => ({
    ${name}: createMiddleware(async (req, reqCtx, next, config) => {
      ${implementation}
    }),
  }),`;
        content = content.slice(0, insertPoint) + middlewareDef + content.slice(insertPoint);

        // Add createMiddleware import if not present
        if (!content.includes("createMiddleware")) {
          content = content.replace(
            /import \{ createPlugin \} from/,
            "import { createPlugin, createMiddleware } from"
          );
        }
      }
    }

    await Bun.write(pluginFile, content);

    return `## Middleware Added: ${name}

**Plugin:** ${pluginName}

### Usage

\`\`\`typescript
// In router
router.middleware.${name}({ /* config */ }).route("protected").typed({ ... });
\`\`\`

Run \`donkeylabs generate\` to update types.
`;
  }

  if (extensionType === "handler") {
    const { implementation = "return new Response('OK');", handlerSignature = "(body: any, ctx: ServerContext) => Promise<Response>" } = params;

    // Check if handlers already exists
    if (content.includes("handlers:")) {
      const handlersMatch = content.match(/handlers:\s*\{/);
      if (handlersMatch) {
        const insertPoint = handlersMatch.index! + handlersMatch[0].length;
        content = content.slice(0, insertPoint) + `\n    ${name}: createHandler<${handlerSignature}>(async (req, def, handle, ctx) => {\n      ${implementation}\n    }),` + content.slice(insertPoint);
      }
    } else {
      // Add handlers property before service
      const serviceMatch = content.match(/service:\s*async/);
      if (serviceMatch) {
        const insertPoint = serviceMatch.index!;
        const handlerDef = `handlers: {\n    ${name}: createHandler<${handlerSignature}>(async (req, def, handle, ctx) => {\n      ${implementation}\n    }),\n  },\n\n  `;
        content = content.slice(0, insertPoint) + handlerDef + content.slice(insertPoint);
      }
    }

    // Add createHandler import if not present
    if (!content.includes("createHandler")) {
      content = content.replace(
        /import \{ createPlugin/,
        "import { createPlugin, createHandler"
      );
    }

    await Bun.write(pluginFile, content);

    return `## Custom Handler Added: ${name}

**Plugin:** ${pluginName}

### Usage

After running \`donkeylabs generate\`, use in routes:
\`\`\`typescript
router.route("myRoute").${name}({
  handle: async (body, ctx) => {
    // Your handler logic
    return new Response("Result");
  }
});
\`\`\`

Run \`donkeylabs generate\` to update types.
`;
  }

  return `Unknown extension type: ${extensionType}`;
}

async function addCron(args: {
  pluginName: string;
  name: string;
  schedule: string;
  implementation: string;
}): Promise<string> {
  const { pluginName, name, schedule, implementation } = args;

  const pluginValid = validatePluginExists(pluginName);
  if (!pluginValid.valid) {
    return formatError(pluginValid.error!, undefined, pluginValid.suggestion, "create_plugin");
  }

  const pluginFile = join(projectRoot, projectConfig.pluginsDir, pluginName, "index.ts");
  let content = await Bun.file(pluginFile).text();

  const cronCode = `ctx.core.cron.schedule("${schedule}", async () => {
      ${implementation}
    }, { name: "${name}" });`;

  // Check if init hook exists
  if (content.includes("init:")) {
    // Add to existing init
    const initMatch = content.match(/init:\s*\([^)]*\)\s*=>\s*\{/);
    if (initMatch) {
      const insertPoint = initMatch.index! + initMatch[0].length;
      content = content.slice(0, insertPoint) + `\n    ${cronCode}\n` + content.slice(insertPoint);
    }
  } else {
    // Add init hook
    const serviceEndMatch = content.match(/service:[\s\S]*?\}\),/);
    if (serviceEndMatch) {
      const insertPoint = serviceEndMatch.index! + serviceEndMatch[0].length;
      const initDef = `\n\n  init: (ctx, service) => {\n    ${cronCode}\n  },`;
      content = content.slice(0, insertPoint) + initDef + content.slice(insertPoint);
    }
  }

  await Bun.write(pluginFile, content);

  return `## Cron Job Added: ${name}

**Plugin:** ${pluginName}
**Schedule:** ${schedule}

### Schedule Reference

- \`* * * * *\` - Every minute
- \`0 * * * *\` - Every hour
- \`0 0 * * *\` - Daily at midnight
- \`0 0 * * 0\` - Weekly on Sunday
- \`0 0 1 * *\` - Monthly on 1st

The cron job will start when the server starts.
`;
}

async function addEvent(args: {
  pluginName: string;
  name: string;
  schema: string;
}): Promise<string> {
  return await extendPlugin({
    pluginName: args.pluginName,
    extensionType: "event",
    name: args.name,
    params: { schema: args.schema },
  });
}

async function addAsyncJob(args: {
  pluginName: string;
  name: string;
  implementation: string;
}): Promise<string> {
  const { pluginName, name, implementation } = args;

  const pluginValid = validatePluginExists(pluginName);
  if (!pluginValid.valid) {
    return formatError(pluginValid.error!, undefined, pluginValid.suggestion, "create_plugin");
  }

  const pluginFile = join(projectRoot, projectConfig.pluginsDir, pluginName, "index.ts");
  let content = await Bun.file(pluginFile).text();

  const jobCode = `ctx.core.jobs.register("${name}", async (data) => {
      ${implementation}
    });`;

  // Check if init hook exists
  if (content.includes("init:")) {
    const initMatch = content.match(/init:\s*\([^)]*\)\s*=>\s*\{/);
    if (initMatch) {
      const insertPoint = initMatch.index! + initMatch[0].length;
      content = content.slice(0, insertPoint) + `\n    ${jobCode}\n` + content.slice(insertPoint);
    }
  } else {
    const serviceEndMatch = content.match(/service:[\s\S]*?\}\),/);
    if (serviceEndMatch) {
      const insertPoint = serviceEndMatch.index! + serviceEndMatch[0].length;
      const initDef = `\n\n  init: (ctx, service) => {\n    ${jobCode}\n  },`;
      content = content.slice(0, insertPoint) + initDef + content.slice(insertPoint);
    }
  }

  await Bun.write(pluginFile, content);

  return `## Background Job Added: ${name}

**Plugin:** ${pluginName}

### Usage

\`\`\`typescript
// Enqueue a job
await ctx.core.jobs.enqueue("${name}", { /* data */ });

// Schedule for later
await ctx.core.jobs.schedule("${name}", { data }, new Date(Date.now() + 3600000));
\`\`\`

Jobs are processed automatically with retries.
`;
}

async function addSSERoute(args: {
  routerFile: string;
  routeName: string;
  channel: string;
}): Promise<string> {
  const { routerFile, routeName, channel } = args;

  const routerValid = validateRouterExists(routerFile);
  if (!routerValid.valid) {
    return formatError(routerValid.error!, undefined, routerValid.suggestion, "create_router");
  }

  const fullPath = join(projectRoot, routerFile);
  let content = await Bun.file(fullPath).text();

  const sseDef = `\n  .route("${routeName}").raw({
    handle: async (req, ctx) => {
      const { client, response } = ctx.core.sse.addClient();
      ctx.core.sse.subscribe(client.id, "${channel}");
      return response;
    },
  })`;

  const insertPoint = content.lastIndexOf(";");
  if (insertPoint !== -1) {
    content = content.slice(0, insertPoint) + sseDef + content.slice(insertPoint);
  }

  await Bun.write(fullPath, content);

  return `## SSE Route Added: ${routeName}

**Router:** ${routerFile}
**Channel:** ${channel}

### Client Usage

\`\`\`javascript
const eventSource = new EventSource("/<prefix>.${routeName}");
eventSource.onmessage = (event) => {
  console.log("Received:", event.data);
};
\`\`\`

### Server Broadcasting

\`\`\`typescript
ctx.core.sse.broadcast("${channel}", "event-name", { data });
\`\`\`
`;
}

async function listPlugins(): Promise<string> {
  const pluginsDir = join(projectRoot, projectConfig.pluginsDir);

  if (!existsSync(pluginsDir)) {
    return `No plugins directory found at ${projectConfig.pluginsDir}/. Create a plugin using \`create_plugin\` tool.`;
  }

  const plugins: string[] = [];

  for (const entry of readdirSync(pluginsDir)) {
    const pluginPath = join(pluginsDir, entry);
    if (!statSync(pluginPath).isDirectory()) continue;

    const indexPath = join(pluginPath, "index.ts");
    if (!existsSync(indexPath)) continue;

    const content = await Bun.file(indexPath).text();

    // Extract service methods - look for method patterns like `methodName: async (...` or `methodName: (...`
    const methods: string[] = [];

    // Find the return statement in service
    const serviceReturnMatch = content.match(/service:\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?return\s*\{([\s\S]*?)\};?\s*\},/);
    if (serviceReturnMatch) {
      // Extract method names from return object
      const returnBlock = serviceReturnMatch[1];
      const methodMatches = returnBlock.matchAll(/(\w+):\s*(?:async\s*)?\(/g);
      for (const m of methodMatches) {
        if (!methods.includes(m[1])) {
          methods.push(m[1]);
        }
      }
    } else {
      // Try arrow function style: service: async (ctx) => ({...})
      const arrowMatch = content.match(/service:\s*async\s*\([^)]*\)\s*=>\s*\(\{([\s\S]*?)\}\)/);
      if (arrowMatch) {
        const returnBlock = arrowMatch[1];
        const methodMatches = returnBlock.matchAll(/(\w+):\s*(?:async\s*)?\(/g);
        for (const m of methodMatches) {
          if (!methods.includes(m[1])) {
            methods.push(m[1]);
          }
        }
      }
    }

    const depsMatch = content.match(/dependencies:\s*\[([^\]]*)\]/);
    const deps = depsMatch ? depsMatch[1].trim() : "";

    const hasSchema = existsSync(join(pluginPath, "schema.ts"));
    const hasMigrations = existsSync(join(pluginPath, "migrations"));

    plugins.push(`### ${entry}
- **Methods:** ${methods.length > 0 ? methods.join(", ") : "none"}
- **Dependencies:** ${deps || "none"}
- **Database:** ${hasSchema || hasMigrations ? "yes" : "no"}
- **Path:** ${projectConfig.pluginsDir}/${entry}/`);
  }

  if (plugins.length === 0) {
    return "No plugins found. Use `create_plugin` to create one.";
  }

  return `# Plugins (${plugins.length})\n\n${plugins.join("\n\n")}`;
}

async function generateTypes(args: { target?: string }): Promise<string> {
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
      return formatError(
        "Type generation failed",
        error || output,
        "Check that your project is properly configured and all plugins are valid."
      );
    }

    return `## Types Generated Successfully

${output}

Types are now up-to-date. Your IDE should recognize the new types.
`;
  } catch (e) {
    return formatError(
      "Error running generation",
      String(e),
      "Make sure the donkeylabs CLI is installed: `bun add @donkeylabs/cli`"
    );
  }
}

async function runCodegen(args: { command: string; outputPath?: string }): Promise<string> {
  const { command, outputPath } = args;

  try {
    const cmdArgs = ["run", "donkeylabs", command];
    if (outputPath) {
      cmdArgs.push("--output", outputPath);
    }

    const proc = Bun.spawn(["bun", ...cmdArgs], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();

    await proc.exited;

    if (proc.exitCode !== 0) {
      return formatError(
        `Command 'donkeylabs ${command}' failed`,
        error || output,
        "Check the error message and fix any issues."
      );
    }

    return `## Command Completed: donkeylabs ${command}

${output}
`;
  } catch (e) {
    return formatError(
      "Error running command",
      String(e),
      "Make sure the donkeylabs CLI is installed."
    );
  }
}

async function generateClient(args: { outputPath?: string }): Promise<string> {
  const { outputPath } = args;

  // Determine default output path based on project type
  const defaultOutput = projectConfig.adapter === "sveltekit"
    ? projectConfig.clientOutput || "src/lib/api.ts"
    : projectConfig.clientOutput || "./client/index.ts";

  const finalOutput = outputPath || defaultOutput;

  try {
    const cmdArgs = ["run", "donkeylabs", "generate"];

    const proc = Bun.spawn(["bun", ...cmdArgs], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();

    await proc.exited;

    if (proc.exitCode !== 0) {
      return formatError(
        "Client generation failed",
        error || output,
        "Check that your routes are properly defined and the project is configured."
      );
    }

    // Build usage instructions based on project type
    let usage = "";
    if (projectConfig.adapter === "sveltekit") {
      const importPath = finalOutput.startsWith("src/lib/") ? "$lib/" + finalOutput.slice(8).replace(/\.ts$/, "") : finalOutput.replace(/\.ts$/, "");
      usage = `### SvelteKit Usage

**SSR (server-side, +page.server.ts):**
\`\`\`typescript
import { createApi } from '${importPath}';

export const load = async ({ locals }) => {
  const api = createApi({ locals }); // Direct calls, no HTTP!
  const data = await api.myRoute.get({});
  return { data };
};
\`\`\`

**Browser (+page.svelte):**
\`\`\`svelte
<script>
  import { createApi } from '${importPath}';
  const api = createApi(); // HTTP calls
  let data = $state(null);
  async function load() {
    data = await api.myRoute.get({});
  }
</script>
\`\`\`

**Key Benefit:** SSR calls go directly to your route handlers without HTTP overhead!

### Using Route Types

Import types for forms, validation, or custom components:
\`\`\`typescript
import { type Routes } from '${importPath}';

// Use route types directly
type UserInput = Routes.Users.Create.Input;
type UserOutput = Routes.Users.Create.Output;

// Example: Form component
function UserForm(props: { onSubmit: (data: UserInput) => void }) {
  // Fully typed input
}
\`\`\``;
    } else {
      usage = `### Usage

\`\`\`typescript
import { createApiClient } from '${finalOutput.replace(/\.ts$/, "")}';

const api = createApiClient({ baseUrl: 'http://localhost:3000' });

// Typed route calls
const result = await api.myRoute.get({ id: 1 });

// SSE events
api.connect();
api.on('events.new', (data) => console.log(data));
\`\`\`

### Using Route Types

Import types for your frontend code:
\`\`\`typescript
import { type Routes } from '${finalOutput.replace(/\.ts$/, "")}';

// Access route input/output types
type UserInput = Routes.Users.Create.Input;
type UserOutput = Routes.Users.Create.Output;
\`\`\``;
    }

    return `## API Client Generated

**Output:** ${finalOutput}
**Type:** ${projectConfig.adapter === "sveltekit" ? "SvelteKit Unified Client (SSR + Browser)" : "Standard HTTP Client"}

${usage}

### When to Regenerate
Run \`generate_client\` again when you:
- Add new routes
- Modify route input/output schemas
- Add plugin events

${output}
`;
  } catch (e) {
    return formatError(
      "Error generating client",
      String(e),
      "Make sure the donkeylabs CLI is installed: `bun add @donkeylabs/cli`"
    );
  }
}

// =============================================================================
// SERVER SETUP
// =============================================================================

const server = new Server(
  {
    name: "donkeylabs-mcp",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Resource handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({
    uri,
    name,
    description,
    mimeType,
  })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const content = await readResource(uri);

  return {
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text: content,
      },
    ],
  };
});

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "get_project_info":
        result = await getProjectInfo();
        break;
      case "get_architecture_guidance":
        result = await getArchitectureGuidance(args as { task: string });
        break;
      case "create_plugin":
        result = await createPlugin(args as Parameters<typeof createPlugin>[0]);
        break;
      case "add_service_method":
        result = await addServiceMethod(args as Parameters<typeof addServiceMethod>[0]);
        break;
      case "add_migration":
        result = await addMigration(args as Parameters<typeof addMigration>[0]);
        break;
      case "create_router":
        result = await createRouter(args as Parameters<typeof createRouter>[0]);
        break;
      case "add_route":
        result = await addRoute(args as Parameters<typeof addRoute>[0]);
        break;
      case "add_handler_to_router":
        result = await addHandlerToRouter(args as Parameters<typeof addHandlerToRouter>[0]);
        break;
      case "extend_plugin":
        result = await extendPlugin(args as Parameters<typeof extendPlugin>[0]);
        break;
      case "add_cron":
        result = await addCron(args as Parameters<typeof addCron>[0]);
        break;
      case "add_event":
        result = await addEvent(args as Parameters<typeof addEvent>[0]);
        break;
      case "add_async_job":
        result = await addAsyncJob(args as Parameters<typeof addAsyncJob>[0]);
        break;
      case "add_sse_route":
        result = await addSSERoute(args as Parameters<typeof addSSERoute>[0]);
        break;
      case "list_plugins":
        result = await listPlugins();
        break;
      case "generate_types":
        result = await generateTypes(args as { target?: string });
        break;
      case "run_codegen":
        result = await runCodegen(args as Parameters<typeof runCodegen>[0]);
        break;
      case "generate_client":
        result = await generateClient(args as { outputPath?: string });
        break;
      default:
        result = formatError(
          `Unknown tool: ${name}`,
          undefined,
          `Available tools: ${tools.map(t => t.name).join(", ")}`
        );
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: formatError(
            error instanceof Error ? error.message : String(error),
            undefined,
            "This may be a bug. Please report it."
          ),
        },
      ],
      isError: true,
    };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
