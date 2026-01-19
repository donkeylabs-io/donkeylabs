import { readdir, writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { Kysely, Migrator, FileMigrationProvider } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { generate, KyselyBunSqliteDialect } from "kysely-codegen";

interface DonkeylabsConfig {
  plugins: string[];
  outDir?: string;
  client?: {
    output: string;
  };
  routes?: string; // Route files pattern, default: "./src/routes/**/handler.ts"
  entry?: string; // Server entry file for extracting routes, default: "./src/index.ts"
  adapter?: string; // Adapter package for framework-specific generation, e.g., "@donkeylabs/adapter-sveltekit"
}

async function loadConfig(): Promise<DonkeylabsConfig> {
  const configPath = join(process.cwd(), "donkeylabs.config.ts");

  if (!existsSync(configPath)) {
    throw new Error("donkeylabs.config.ts not found. Run 'donkeylabs init' first.");
  }

  const config = await import(configPath);
  return config.default;
}

async function getPluginExportName(pluginPath: string): Promise<string | null> {
  try {
    const content = await readFile(pluginPath, "utf-8");
    const match = content.match(/export\s+const\s+(\w+Plugin)\s*=/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function getPluginDefinedName(pluginPath: string): Promise<string | null> {
  try {
    const content = await readFile(pluginPath, "utf-8");
    // Match name: "pluginName" or name: 'pluginName' in createPlugin.define({ name: "..." })
    const match = content.match(/createPlugin(?:\.[\w<>(),\s]+)*\.define\s*\(\s*\{[^}]*name:\s*["'](\w+)["']/s);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function extractHandlerNames(pluginPath: string): Promise<string[]> {
  try {
    const content = await readFile(pluginPath, "utf-8");
    const handlersMatch = content.match(/handlers:\s*\{([^}]+)\}/);
    if (!handlersMatch?.[1]) return [];

    const handlersBlock = handlersMatch[1];
    return [...handlersBlock.matchAll(/(\w+)\s*:/g)]
      .map((m) => m[1])
      .filter((name): name is string => !!name);
  } catch {
    return [];
  }
}

async function extractMiddlewareNames(pluginPath: string): Promise<string[]> {
  try {
    const content = await readFile(pluginPath, "utf-8");

    // Look for middleware definitions: `name: createMiddleware(...)`
    // This works for both old `middleware: { timing: createMiddleware(...) }`
    // and new `middleware: (ctx) => ({ timing: createMiddleware(...) })`
    const middlewareNames = [...content.matchAll(/(\w+)\s*:\s*createMiddleware\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => !!name);

    return middlewareNames;
  } catch {
    return [];
  }
}

interface ExtractedRoute {
  name: string;
  handler: string;
}

interface RouteInfo {
  name: string;
  prefix: string;
  routeName: string;
  handler: "typed" | "raw" | string;
  inputSource?: string;
  outputSource?: string;
}

/**
 * Extract a balanced block from source code starting at a given position
 */
function extractBalancedBlock(source: string, startPos: number, open = "{", close = "}"): string {
  let depth = 0;
  let start = -1;
  let end = -1;

  for (let i = startPos; i < source.length; i++) {
    if (source[i] === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (source[i] === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (start !== -1 && end !== -1) {
    return source.slice(start, end + 1);
  }
  return "";
}

/**
 * Extract Zod schema from input/output definition
 */
function extractZodSchema(configBlock: string, key: "input" | "output"): string | undefined {
  // Find where the key starts
  const keyPattern = new RegExp(`${key}\\s*:\\s*`);
  const match = configBlock.match(keyPattern);
  if (!match || match.index === undefined) return undefined;

  const startPos = match.index + match[0].length;

  // Check if it starts with z.
  const afterKey = configBlock.slice(startPos);
  if (!afterKey.startsWith("z.")) return undefined;

  // Find the end of the Zod expression by tracking parentheses
  let depth = 0;
  let endPos = 0;
  let inParen = false;

  for (let i = 0; i < afterKey.length; i++) {
    const char = afterKey[i];

    if (char === "(") {
      depth++;
      inParen = true;
    } else if (char === ")") {
      depth--;
      if (depth === 0 && inParen) {
        endPos = i + 1;
        // Check for chained methods like .optional()
        const rest = afterKey.slice(endPos);
        const chainMatch = rest.match(/^\s*\.\w+\(\)/);
        if (chainMatch) {
          endPos += chainMatch[0].length;
        }
        break;
      }
    } else if (depth === 0 && inParen) {
      break;
    }
  }

  if (endPos > 0) {
    return afterKey.slice(0, endPos).trim();
  }
  return undefined;
}

/**
 * Extract routes from a server/router source file by parsing the code
 */
async function extractRoutesFromSource(filePath: string): Promise<RouteInfo[]> {
  const fullPath = join(process.cwd(), filePath);

  if (!existsSync(fullPath)) {
    console.warn(pc.yellow(`Entry file not found: ${filePath}, skipping route extraction`));
    return [];
  }

  const content = await readFile(fullPath, "utf-8");
  const routes: RouteInfo[] = [];

  // Find all createRouter calls with their positions
  const routerPattern = /createRouter\s*\(\s*["']([^"']+)["']\s*\)/g;
  const routerPositions: { prefix: string; pos: number }[] = [];

  let routerMatch;
  while ((routerMatch = routerPattern.exec(content)) !== null) {
    routerPositions.push({
      prefix: routerMatch[1] || "",
      pos: routerMatch.index,
    });
  }

  // Sort by position
  routerPositions.sort((a, b) => a.pos - b.pos);

  // Find all route definitions with their positions
  const routePattern = /\.route\s*\(\s*["']([^"']+)["']\s*\)\s*\.(typed|raw|[\w]+)\s*\(/g;

  let routeMatch;
  while ((routeMatch = routePattern.exec(content)) !== null) {
    const routeName = routeMatch[1] || "";
    const handler = routeMatch[2] || "typed";
    const routePos = routeMatch.index;

    // Find which router this route belongs to (most recent one before this position)
    let currentPrefix = "";
    for (const router of routerPositions) {
      if (router.pos < routePos) {
        currentPrefix = router.prefix;
      } else {
        break;
      }
    }

    // Extract the config block
    const configStartPos = routeMatch.index + routeMatch[0].length - 1; // Position of the (
    const configBlock = extractBalancedBlock(content, configStartPos, "(", ")");

    // Remove outer parens and the inner braces wrapper
    let innerConfig = configBlock.slice(1, -1).trim(); // Remove ( and )
    if (innerConfig.startsWith("{") && innerConfig.endsWith("}")) {
      innerConfig = innerConfig.slice(1, -1); // Remove { and }
    }

    // Extract input and output schemas
    const inputSource = extractZodSchema(innerConfig, "input");
    const outputSource = extractZodSchema(innerConfig, "output");

    routes.push({
      name: currentPrefix ? `${currentPrefix}.${routeName}` : routeName,
      prefix: currentPrefix,
      routeName,
      handler,
      inputSource,
      outputSource,
    });
  }

  return routes;
}


async function findPlugins(
  patterns: string[]
): Promise<{ name: string; path: string; exportName: string }[]> {
  const plugins: { name: string; path: string; exportName: string }[] = [];

  for (const pattern of patterns) {
    const baseDir = pattern.includes("**")
      ? pattern.split("**")[0] || "."
      : dirname(pattern);

    const targetDir = join(process.cwd(), baseDir);
    if (!existsSync(targetDir)) continue;

    async function scanDir(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.name === "index.ts") {
          const exportName = await getPluginExportName(fullPath);
          if (exportName) {
            // Get the actual plugin name from the define() call, fall back to directory name
            const definedName = await getPluginDefinedName(fullPath);
            const pluginName = definedName || dirname(fullPath).split("/").pop()!;
            plugins.push({
              name: pluginName,
              path: relative(process.cwd(), fullPath),
              exportName,
            });
          }
        }
      }
    }

    await scanDir(targetDir);
  }

  return plugins;
}

async function findRouteFiles(pattern: string): Promise<string[]> {
  const files: string[] = [];
  const baseDir = pattern.includes("**")
    ? pattern.split("**")[0] || "."
    : dirname(pattern);
  const fileName = basename(pattern.replace("**/", ""));

  const targetDir = join(process.cwd(), baseDir);
  if (!existsSync(targetDir)) return files;

  async function scanDir(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(fullPath);
      } else if (entry.name === fileName) {
        files.push(relative(process.cwd(), fullPath));
      }
    }
  }

  await scanDir(targetDir);
  return files;
}

/**
 * Run the server entry file with DONKEYLABS_GENERATE=1 to get typed route metadata
 */
async function extractRoutesFromServer(entryPath: string): Promise<RouteInfo[]> {
  const fullPath = join(process.cwd(), entryPath);

  if (!existsSync(fullPath)) {
    console.warn(pc.yellow(`Entry file not found: ${entryPath}`));
    return [];
  }

  const TIMEOUT_MS = 10000; // 10 second timeout

  return new Promise((resolve) => {
    const child = spawn("bun", [fullPath], {
      env: { ...process.env, DONKEYLABS_GENERATE: "1" },
      stdio: ["inherit", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Timeout handler
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      console.warn(pc.yellow(`Route extraction timed out after ${TIMEOUT_MS / 1000}s`));
      console.warn(pc.dim("Make sure your entry file handles DONKEYLABS_GENERATE=1 and calls process.exit(0)"));
      resolve([]);
    }, TIMEOUT_MS);

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return; // Already resolved

      if (code !== 0) {
        console.warn(pc.yellow(`Failed to extract routes from server (exit code ${code})`));
        if (stderr) console.warn(pc.dim(stderr));
        resolve([]);
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        // Convert server output to RouteInfo format
        const routes: RouteInfo[] = (result.routes || []).map((r: any) => {
          const parts = r.name.split(".");
          return {
            name: r.name,
            prefix: parts.slice(0, -1).join("."),
            routeName: parts[parts.length - 1] || r.name,
            handler: r.handler || "typed",
            // Server outputs TypeScript strings directly now
            inputSource: r.inputType,
            outputSource: r.outputType,
          };
        });
        resolve(routes);
      } catch (e) {
        console.warn(pc.yellow("Failed to parse route data from server"));
        resolve([]);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      console.warn(pc.yellow(`Failed to run entry file: ${err.message}`));
      resolve([]);
    });
  });
}

/**
 * Generate schema.ts from plugin migrations using kysely-codegen
 */
async function generatePluginSchemas(
  plugins: { name: string; path: string; exportName: string }[]
): Promise<string[]> {
  const generated: string[] = [];

  for (const plugin of plugins) {
    const pluginDir = dirname(join(process.cwd(), plugin.path));
    const migrationsDir = join(pluginDir, "migrations");

    // Skip plugins without migrations folder
    if (!existsSync(migrationsDir)) {
      continue;
    }

    // Check if there are any migration files
    const migrationFiles = await readdir(migrationsDir);
    const hasMigrations = migrationFiles.some(
      (f) => f.endsWith(".ts") && !f.endsWith(".d.ts")
    );

    if (!hasMigrations) {
      continue;
    }

    console.log(pc.dim(`  Generating schema for ${plugin.name}...`));

    const dbPath = join(process.cwd(), `.temp_schema_${plugin.name}.db`);

    try {
      // Create temp SQLite database
      const db = new Kysely<any>({
        dialect: new BunSqliteDialect({
          database: new Database(dbPath),
        }),
      });

      // Run migrations using Kysely's FileMigrationProvider
      const migrator = new Migrator({
        db,
        provider: new FileMigrationProvider({
          fs: await import("node:fs/promises"),
          path: await import("node:path"),
          migrationFolder: migrationsDir,
        }),
      });

      const { error } = await migrator.migrateToLatest();

      if (error) {
        console.warn(
          pc.yellow(`  Warning: Migration failed for ${plugin.name}: ${error}`)
        );
        await db.destroy();
        try {
          await unlink(dbPath);
        } catch {}
        continue;
      }

      // Generate schema.ts using kysely-codegen
      const schemaPath = join(pluginDir, "schema.ts");

      await generate({
        db,
        outFile: schemaPath,
        dialect: new KyselyBunSqliteDialect(),
      });

      generated.push(plugin.name);

      // Cleanup
      await db.destroy();
      try {
        await unlink(dbPath);
      } catch {}
    } catch (err: any) {
      console.warn(
        pc.yellow(`  Warning: Schema generation failed for ${plugin.name}: ${err.message}`)
      );
      // Cleanup on error
      try {
        await unlink(dbPath);
      } catch {}
    }
  }

  return generated;
}

export async function generateCommand(_args: string[]): Promise<void> {
  const config = await loadConfig();
  const outDir = config.outDir || ".@donkeylabs/server";
  const outPath = join(process.cwd(), outDir);

  await mkdir(outPath, { recursive: true });

  const plugins = await findPlugins(config.plugins);
  const fileRoutes = await findRoutes(config.routes || "./src/routes/**/schema.ts");

  // Generate schema.ts from migrations for plugins that have them
  const schemaPlugins = await generatePluginSchemas(plugins);
  if (schemaPlugins.length > 0) {
    console.log(
      pc.green("Generated schemas:"),
      schemaPlugins.map((p) => pc.dim(p)).join(", ")
    );
  }

  // Extract routes by running the server with DONKEYLABS_GENERATE=1
  const entryPath = config.entry || "./src/index.ts";
  const serverRoutes = await extractRoutesFromServer(entryPath);

  // Generate all files
  await generateRegistry(plugins, outPath);
  await generateContext(plugins, outPath);
  await generateRouteTypes(fileRoutes, outPath);

  const generated = ["registry", "context", "routes"];

  // Determine client output path
  const clientOutput = config.client?.output || join(outPath, "client.ts");

  // Check if adapter provides a custom generator
  if (config.adapter) {
    try {
      // Resolve the adapter path from the project's node_modules
      const adapterPath = join(process.cwd(), "node_modules", config.adapter, "src/generator/index.ts");
      if (existsSync(adapterPath)) {
        const adapterModule = await import(adapterPath);
        if (adapterModule.generateClient) {
          await adapterModule.generateClient(config, serverRoutes, clientOutput);
          generated.push(`client (${config.adapter})`);
          console.log(pc.green("Generated:"), generated.map(g => pc.dim(g)).join(", "));
          return;
        }
      }
    } catch (e: any) {
      // Adapter doesn't provide generator or import failed, fall back to default
      console.log(pc.dim(`Note: Adapter ${config.adapter} has no custom generator, using default`));
      console.log(pc.dim(`Error: ${e.message}`));
    }
  }

  // Default client generation
  await generateClientFromRoutes(serverRoutes, clientOutput);
  generated.push("client");

  console.log(pc.green("Generated:"), generated.map(g => pc.dim(g)).join(", "));
}

async function generateRegistry(
  plugins: { name: string; path: string; exportName: string }[],
  outPath: string
) {
  const importLines = plugins
    .map((p) => {
      // Calculate relative path from outPath to plugin
      const pluginAbsPath = join(process.cwd(), p.path).replace(/\.ts$/, "");
      const relativePath = relative(outPath, pluginAbsPath);
      // Ensure path starts with ./ or ../
      const importPath = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
      return `import { ${p.exportName} } from "${importPath}";`;
    })
    .join("\n");

  const pluginRegistryEntries = plugins
    .map(
      (p) =>
        `    ${p.name}: Register<InferService<typeof ${p.exportName}>, InferSchema<typeof ${p.exportName}>, InferHandlers<typeof ${p.exportName}>, InferDependencies<typeof ${p.exportName}>, InferMiddleware<typeof ${p.exportName}>>;`
    )
    .join("\n");

  const handlerExtensions =
    plugins.map((p) => `InferHandlers<typeof ${p.exportName}>`).join(",\n    ") ||
    "{}";

  const middlewareExtensions =
    plugins
      .map((p) => `InferMiddleware<typeof ${p.exportName}>`)
      .join(",\n    ") || "{}";

  // Collect handlers and middleware from each plugin
  const allHandlers: { plugin: string; handler: string }[] = [];
  const allMiddleware: { plugin: string; middleware: string }[] = [];

  for (const p of plugins) {
    const handlers = await extractHandlerNames(join(process.cwd(), p.path));
    const middleware = await extractMiddlewareNames(join(process.cwd(), p.path));

    for (const h of handlers) {
      allHandlers.push({ plugin: p.exportName, handler: h });
    }
    for (const m of middleware) {
      allMiddleware.push({ plugin: p.exportName, middleware: m });
    }
  }

  const routeBuilderMethods = allHandlers
    .map(
      ({ plugin, handler }) => `    /** Custom handler from ${plugin} */
    ${handler}(config: {
      handle: InferHandlers<typeof ${plugin}>["${handler}"]["__signature"];
    }): TRouter;`
    )
    .join("\n");

  const handlerUnion =
    allHandlers.length > 0
      ? `"typed" | "raw" | ${allHandlers.map((h) => `"${h.handler}"`).join(" | ")}`
      : '"typed" | "raw"';

  const middlewareUnion =
    allMiddleware.length > 0
      ? allMiddleware.map((m) => `"${m.middleware}"`).join(" | ")
      : "never";

  // Router middleware methods (returns IRouter for chaining)
  const middlewareBuilderMethods = allMiddleware
    .map(
      ({ plugin, middleware }) => `    /** Middleware from ${plugin} */
    ${middleware}(config?: InferMiddleware<typeof ${plugin}>["${middleware}"]["__config"]): TRouter;`
    )
    .join("\n");

  const content = `// Auto-generated by donkeylabs generate
import { type Register, type InferService, type InferSchema, type InferHandlers, type InferMiddleware, type InferDependencies } from "@donkeylabs/server";
${importLines}

declare module "@donkeylabs/server" {
  export interface PluginRegistry {
${pluginRegistryEntries}
  }

  export interface PluginHandlerRegistry extends
    ${handlerExtensions}
  {}

  export interface PluginMiddlewareRegistry extends
    ${middlewareExtensions}
  {}
}

export type AvailableHandlers = ${handlerUnion};
export type AvailableMiddleware = ${middlewareUnion};

declare module "@donkeylabs/server" {
  export interface IRouteBuilder<TRouter> {
${routeBuilderMethods}
  }

  export interface IMiddlewareBuilder<TRouter> {
${middlewareBuilderMethods}
  }
}
`;

  await writeFile(join(outPath, "registry.d.ts"), content);
}

async function generateContext(
  plugins: { name: string; path: string; exportName: string }[],
  outPath: string
) {
  const schemaIntersection =
    plugins.map((p) => `PluginRegistry["${p.name}"]["schema"]`).join(" & ") ||
    "{}";

  const content = `// Auto-generated by donkeylabs generate
// App context - import as: import type { AppContext } from ".@donkeylabs/server/context";

/// <reference path="./registry.d.ts" />
import type { PluginRegistry, CoreServices, Errors } from "@donkeylabs/server";
import type { Kysely } from "kysely";

/** Merged database schema from all plugins */
export type DatabaseSchema = ${schemaIntersection};

/**
 * Fully typed application context.
 * Use this instead of ServerContext for typed plugin access.
 */
export interface AppContext {
  /** Database with merged schema from all plugins */
  db: Kysely<DatabaseSchema>;
  /** Typed plugin services */
  plugins: {
    [K in keyof PluginRegistry]: PluginRegistry[K]["service"];
  };
  /** Core services (logger, cache, events, etc.) */
  core: Omit<CoreServices, "db" | "config" | "errors">;
  /** Error factories (BadRequest, NotFound, etc.) */
  errors: Errors;
  /** Application config */
  config: Record<string, any>;
  /** Client IP address */
  ip: string;
  /** Unique request ID */
  requestId: string;
  /** Authenticated user (set by auth middleware) */
  user?: any;
}

// Re-export as GlobalContext for backwards compatibility
export type GlobalContext = AppContext;
`;

  await writeFile(join(outPath, "context.d.ts"), content);
}

// Route file structure: /src/routes/<namespace>/<route-name>/schema.ts
interface SchemaRouteInfo {
  namespace: string;
  name: string;
  schemaPath: string;
}

async function findRoutes(_pattern: string): Promise<SchemaRouteInfo[]> {
  const routes: SchemaRouteInfo[] = [];
  const routesDir = join(process.cwd(), "src/routes");

  if (!existsSync(routesDir)) {
    return routes;
  }

  // Scan routes directory structure: /routes/<namespace>/<route>/schema.ts
  const namespaces = await readdir(routesDir, { withFileTypes: true });

  for (const ns of namespaces) {
    if (!ns.isDirectory() || ns.name.startsWith(".")) continue;

    const namespaceDir = join(routesDir, ns.name);
    const routeDirs = await readdir(namespaceDir, { withFileTypes: true });

    for (const routeDir of routeDirs) {
      if (!routeDir.isDirectory() || routeDir.name.startsWith(".")) continue;

      const schemaPath = join(namespaceDir, routeDir.name, "schema.ts");

      if (!existsSync(schemaPath)) continue;

      routes.push({
        namespace: ns.name,
        name: routeDir.name,
        schemaPath: relative(process.cwd(), schemaPath),
      });
    }
  }

  return routes;
}

function toPascalCase(str: string): string {
  return str
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}

async function generateRouteTypes(routes: SchemaRouteInfo[], outPath: string): Promise<void> {
  // Group routes by namespace
  const byNamespace = new Map<string, SchemaRouteInfo[]>();
  for (const route of routes) {
    if (!byNamespace.has(route.namespace)) {
      byNamespace.set(route.namespace, []);
    }
    byNamespace.get(route.namespace)!.push(route);
  }

  // Generate imports for each route's schema (relative to outPath)
  const imports: string[] = [];
  for (const route of routes) {
    // Calculate relative path from .@donkeylabs/server/ to src/routes/.../schema
    const schemaAbsPath = join(process.cwd(), route.schemaPath).replace(/\.ts$/, "");
    const outAbsPath = outPath;
    const relativePath = relative(outAbsPath, schemaAbsPath);
    const alias = `${toPascalCase(route.namespace)}_${toPascalCase(route.name)}`;
    imports.push(`import { Input as ${alias}_Input, Output as ${alias}_Output } from "${relativePath}";`);
  }

  // Generate namespace declarations
  const namespaceBlocks: string[] = [];
  for (const [namespace, nsRoutes] of byNamespace) {
    const pascalNamespace = toPascalCase(namespace);

    const routeExports = nsRoutes.map((r) => {
      const pascalRoute = toPascalCase(r.name);
      const alias = `${pascalNamespace}_${pascalRoute}`;
      return `  export namespace ${pascalRoute} {
    /** Zod schema for input validation */
    export const Input = ${alias}_Input;
    /** Zod schema for output validation */
    export const Output = ${alias}_Output;
    /** TypeScript type for input data */
    export type Input = z.infer<typeof ${alias}_Input>;
    /** TypeScript type for output data */
    export type Output = z.infer<typeof ${alias}_Output>;
  }
  /** Route contract type - use with Route<${pascalNamespace}.${pascalRoute}> and Handler<${pascalNamespace}.${pascalRoute}> */
  export type ${pascalRoute} = { input: ${pascalRoute}.Input; output: ${pascalRoute}.Output };`;
    }).join("\n\n");

    namespaceBlocks.push(`export namespace ${pascalNamespace} {\n${routeExports}\n}`);
  }

  const content = `// Auto-generated by donkeylabs generate
// Route Input/Output types - import as: import { Health } from ".@donkeylabs/server/routes";

import { z } from "zod";
import type { AppContext } from "./context";
${imports.join("\n")}

${namespaceBlocks.join("\n\n")}
`;

  await writeFile(join(outPath, "routes.ts"), content);
}

async function generateClientFromRoutes(
  routes: ExtractedRoute[],
  outputPath: string
): Promise<void> {
  // Group routes by namespace (first part of route name)
  // e.g., "api.hello.test" -> namespace "api", sub "hello", method "test"
  const tree = new Map<string, Map<string, { method: string; fullName: string }[]>>();

  for (const route of routes) {
    const parts = route.name.split(".");
    if (parts.length < 2) {
      // Single-level route like "ping" -> namespace "", method "ping"
      const ns = "";
      if (!tree.has(ns)) tree.set(ns, new Map());
      const rootMethods = tree.get(ns)!;
      if (!rootMethods.has("")) rootMethods.set("", []);
      rootMethods.get("")!.push({ method: parts[0]!, fullName: route.name });
    } else if (parts.length === 2) {
      // Two-level route like "health.ping" -> namespace "health", method "ping"
      const [ns, method] = parts;
      if (!tree.has(ns!)) tree.set(ns!, new Map());
      const nsMethods = tree.get(ns!)!;
      if (!nsMethods.has("")) nsMethods.set("", []);
      nsMethods.get("")!.push({ method: method!, fullName: route.name });
    } else {
      // Multi-level route like "api.hello.test" -> namespace "api", sub "hello", method "test"
      const [ns, sub, ...rest] = parts;
      const method = rest.join(".");
      if (!tree.has(ns!)) tree.set(ns!, new Map());
      const nsMethods = tree.get(ns!)!;
      if (!nsMethods.has(sub!)) nsMethods.set(sub!, []);
      nsMethods.get(sub!)!.push({ method: method || sub!, fullName: route.name });
    }
  }

  // Generate method definitions
  const namespaceBlocks: string[] = [];

  for (const [namespace, subNamespaces] of tree) {
    if (namespace === "") {
      // Root-level methods
      const rootMethods = subNamespaces.get("");
      if (rootMethods && rootMethods.length > 0) {
        for (const { method, fullName } of rootMethods) {
          const methodName = method.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
          namespaceBlocks.push(`  ${methodName} = (input: any) => this.request("${fullName}", input);`);
        }
      }
      continue;
    }

    const subBlocks: string[] = [];
    for (const [sub, methods] of subNamespaces) {
      if (sub === "") {
        // Direct methods on namespace
        for (const { method, fullName } of methods) {
          const methodName = method.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
          subBlocks.push(`    ${methodName}: (input: any) => this.request("${fullName}", input)`);
        }
      } else {
        // Sub-namespace methods
        const subMethods = methods.map(({ method, fullName }) => {
          const methodName = method.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
          return `      ${methodName}: (input: any) => this.request("${fullName}", input)`;
        });
        subBlocks.push(`    ${sub}: {\n${subMethods.join(",\n")}\n    }`);
      }
    }

    namespaceBlocks.push(`  ${namespace} = {\n${subBlocks.join(",\n")}\n  };`);
  }

  const content = `// Auto-generated by donkeylabs generate
// API Client

import { ApiClientBase, type ApiClientOptions } from "@donkeylabs/server/client";

export class ApiClient extends ApiClientBase<{}> {
  constructor(baseUrl: string, options?: ApiClientOptions) {
    super(baseUrl, options);
  }

${namespaceBlocks.join("\n\n") || "  // No routes defined"}
}

export function createApiClient(baseUrl: string, options?: ApiClientOptions) {
  return new ApiClient(baseUrl, options);
}
`;

  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, content);
}
