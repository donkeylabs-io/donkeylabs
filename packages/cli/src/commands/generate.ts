import { readdir, writeFile, readFile, mkdir } from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import pc from "picocolors";

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

async function extractRoutesFromServer(entryPath: string): Promise<ExtractedRoute[]> {
  const fullPath = join(process.cwd(), entryPath);

  if (!existsSync(fullPath)) {
    console.warn(pc.yellow(`Entry file not found: ${entryPath}, skipping route extraction`));
    return [];
  }

  return new Promise((resolve) => {
    const child = spawn("bun", [fullPath], {
      env: { ...process.env, DONKEYLABS_GENERATE: "1" },
      stdio: ["inherit", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(pc.yellow(`Failed to extract routes from server (exit code ${code})`));
        if (stderr) console.warn(pc.dim(stderr));
        resolve([]);
        return;
      }

      try {
        // Parse the JSON output from server
        const result = JSON.parse(stdout.trim());
        resolve(result.routes || []);
      } catch (e) {
        console.warn(pc.yellow("Failed to parse route data from server"));
        resolve([]);
      }
    });

    child.on("error", (err) => {
      console.warn(pc.yellow(`Failed to run entry file: ${err.message}`));
      resolve([]);
    });
  });
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

export async function generateCommand(_args: string[]): Promise<void> {
  const config = await loadConfig();
  const outDir = config.outDir || ".@donkeylabs/server";
  const outPath = join(process.cwd(), outDir);

  await mkdir(outPath, { recursive: true });

  const plugins = await findPlugins(config.plugins);
  const fileRoutes = await findRoutes(config.routes || "./src/routes/**/schema.ts");

  // Extract routes from server entry file
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
      // Dynamically import adapter's generator
      const adapterModule = await import(`${config.adapter}/generator`);
      if (adapterModule.generateClient) {
        await adapterModule.generateClient(config, serverRoutes, clientOutput);
        generated.push(`client (${config.adapter})`);
        console.log(pc.green("Generated:"), generated.map(g => pc.dim(g)).join(", "));
        return;
      }
    } catch (e) {
      // Adapter doesn't provide generator or import failed, fall back to default
      console.log(pc.dim(`Note: Adapter ${config.adapter} has no custom generator, using default`));
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
    .map(
      (p) =>
        `import { ${p.exportName} } from "${join(process.cwd(), p.path).replace(/\.ts$/, "")}";`
    )
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
interface RouteInfo {
  namespace: string;
  name: string;
  schemaPath: string;
}

async function findRoutes(_pattern: string): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = [];
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

async function generateRouteTypes(routes: RouteInfo[], outPath: string): Promise<void> {
  // Group routes by namespace
  const byNamespace = new Map<string, RouteInfo[]>();
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
