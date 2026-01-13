/**
 * Generate Command
 *
 * Generate types based on donkeylabs.config.ts
 */

import { readdir, writeFile, readFile, stat, mkdir } from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import { existsSync } from "node:fs";
import pc from "picocolors";
import { glob } from "node:fs/promises";

interface DonkeylabsConfig {
  plugins: string[];
  outDir?: string;
  client?: {
    output: string;
  };
}

async function loadConfig(): Promise<DonkeylabsConfig> {
  const configPath = join(process.cwd(), "donkeylabs.config.ts");

  if (!existsSync(configPath)) {
    throw new Error(
      "donkeylabs.config.ts not found. Run 'donkeylabs init' first."
    );
  }

  const config = await import(configPath);
  return config.default;
}

// Extract plugin export name from file
async function getPluginExportName(pluginPath: string): Promise<string | null> {
  try {
    const content = await readFile(pluginPath, "utf-8");
    // Match: export const xxxPlugin = createPlugin
    const match = content.match(/export\s+const\s+(\w+Plugin)\s*=/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// Extract handler names from plugin
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

// Extract middleware names from plugin
async function extractMiddlewareNames(pluginPath: string): Promise<string[]> {
  try {
    const content = await readFile(pluginPath, "utf-8");
    const middlewareMatch = content.match(/middleware:\s*\{([^}]+)\}/);
    if (!middlewareMatch?.[1]) return [];

    const middlewareBlock = middlewareMatch[1];
    return [...middlewareBlock.matchAll(/(\w+)\s*:/g)]
      .map((m) => m[1])
      .filter((name): name is string => !!name);
  } catch {
    return [];
  }
}

// Find plugins matching glob patterns
async function findPlugins(
  patterns: string[]
): Promise<{ name: string; path: string; exportName: string }[]> {
  const plugins: { name: string; path: string; exportName: string }[] = [];

  for (const pattern of patterns) {
    // Simple glob implementation - find matching files
    const baseDir = pattern.includes("**")
      ? pattern.split("**")[0] || "."
      : dirname(pattern);

    const targetDir = join(process.cwd(), baseDir);
    if (!existsSync(targetDir)) continue;

    async function scanDir(dir: string) {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.name === "index.ts") {
          const exportName = await getPluginExportName(fullPath);
          if (exportName) {
            // Get plugin name from directory
            const pluginName = dirname(fullPath).split("/").pop()!;
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

export async function generateCommand(args: string[]) {
  console.log(pc.bold("\nGenerating types...\n"));

  const config = await loadConfig();
  const outDir = config.outDir || ".@donkeylabs/server";
  const outPath = join(process.cwd(), outDir);

  // Ensure output directory exists
  await mkdir(outPath, { recursive: true });

  // Find all plugins
  const plugins = await findPlugins(config.plugins);

  if (plugins.length === 0) {
    console.log(
      pc.yellow("No plugins found matching patterns:"),
      config.plugins.join(", ")
    );
    return;
  }

  console.log(pc.dim(`Found ${plugins.length} plugin(s):`));
  for (const p of plugins) {
    console.log(pc.dim(`  - ${p.name} (${p.exportName})`));
  }
  console.log();

  // Generate registry.d.ts
  await generateRegistry(plugins, outPath);

  // Generate context.d.ts
  await generateContext(plugins, outPath);

  console.log(pc.green("\nTypes generated successfully!"));
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

  const middlewareBuilderMethods = allMiddleware
    .map(
      ({ plugin, middleware }) => `    /** Middleware from ${plugin} */
    ${middleware}(config?: InferMiddleware<typeof ${plugin}>["${middleware}"]["__config"]): this;`
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
  console.log(pc.green("  Generated:"), `${outPath}/registry.d.ts`);
}

async function generateContext(
  plugins: { name: string; path: string; exportName: string }[],
  outPath: string
) {
  const schemaIntersection =
    plugins.map((p) => `PluginRegistry["${p.name}"]["schema"]`).join(" & ") ||
    "{}";

  const content = `// Auto-generated by donkeylabs generate

/// <reference path="./registry.d.ts" />
import type { PluginRegistry, CoreServices, Errors } from "@donkeylabs/server";
import type { Kysely } from "kysely";

type DatabaseSchema = ${schemaIntersection};

export interface GlobalContext {
  db: Kysely<DatabaseSchema>;
  plugins: {
    [K in keyof PluginRegistry]: PluginRegistry[K]["service"];
  };
  core: CoreServices;
  errors: Errors;
  ip: string;
  requestId?: string;
  user?: any;
}
`;

  await writeFile(join(outPath, "context.d.ts"), content);
  console.log(pc.green("  Generated:"), `${outPath}/context.d.ts`);
}
