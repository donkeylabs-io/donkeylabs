#!/usr/bin/env bun
/**
 * Generate API Client Script
 *
 * Generates a fully-typed API client from router definitions and plugin events.
 *
 * Usage:
 *   bun scripts/generate-client.ts [options] [server-files...]
 *
 * Options:
 *   --output <path>     Output directory (default: ./client)
 *   --name <name>       Client filename (default: index.ts)
 *   --base-url <url>    Default base URL (default: empty)
 *
 * Examples:
 *   bun scripts/generate-client.ts server.ts
 *   bun scripts/generate-client.ts --output ./src/api index.ts app.ts
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname, basename, relative } from "node:path";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";

// ==========================================
// Types
// ==========================================

interface RouteInfo {
  name: string;
  prefix: string;
  routeName: string;
  handler: "typed" | "raw" | string;
  inputSource?: string;  // Original Zod source
  outputSource?: string; // Original Zod source
}

interface EventInfo {
  name: string;         // Full event name (e.g., "notifications.new")
  plugin: string;
  schemaSource: string; // Zod schema source
}

interface ClientConfigInfo {
  plugin: string;
  credentials?: "include" | "same-origin" | "omit";
}

interface GenerationContext {
  routes: RouteInfo[];
  events: EventInfo[];
  clientConfigs: ClientConfigInfo[];
}

// ==========================================
// Source Parsing Utilities
// ==========================================

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
 * Extract routes from a server/router file
 */
async function extractRoutes(filePath: string): Promise<RouteInfo[]> {
  const content = await readFile(filePath, "utf-8");
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

/**
 * Extract events and client config from plugin files
 */
async function extractPluginInfo(pluginPath: string): Promise<{
  events: EventInfo[];
  clientConfig?: ClientConfigInfo;
  pluginName: string;
}> {
  const indexPath = join(pluginPath, "index.ts");
  if (!existsSync(indexPath)) {
    return { events: [], pluginName: "" };
  }

  const content = await readFile(indexPath, "utf-8");
  const events: EventInfo[] = [];
  let clientConfig: ClientConfigInfo | undefined;

  // Extract plugin name
  const nameMatch = content.match(/name:\s*["']([^"']+)["']/);
  const pluginName = nameMatch?.[1] || basename(pluginPath);

  // Extract events: { eventName: z.object({ ... }), ... }
  const eventsBlockMatch = content.match(
    /events\s*:\s*\{([^}]*(?:\{[^}]*(?:\{[^}]*\}[^}]*)*\}[^}]*)*)\}/s
  );

  if (eventsBlockMatch?.[1]) {
    const eventsBlock = eventsBlockMatch[1];
    // Match individual event definitions
    const eventPattern = /(\w+)\s*:\s*(z\.[^,\n}]+(?:\([^)]*(?:\([^)]*\)[^)]*)*\))?)/gs;

    for (const match of eventsBlock.matchAll(eventPattern)) {
      const eventName = match[1];
      const schemaSource = match[2];
      if (eventName && schemaSource) {
        events.push({
          name: `${pluginName}.${eventName}`,
          plugin: pluginName,
          schemaSource: schemaSource.trim(),
        });
      }
    }
  }

  // Extract client config
  const clientMatch = content.match(
    /client\s*:\s*\{([^}]+)\}/
  );

  if (clientMatch?.[1]) {
    const clientBlock = clientMatch[1];
    const credMatch = clientBlock.match(
      /credentials\s*:\s*["']?(include|same-origin|omit)["']?/
    );

    clientConfig = {
      plugin: pluginName,
      credentials: credMatch?.[1] as "include" | "same-origin" | "omit" | undefined,
    };
  }

  return { events, clientConfig, pluginName };
}

// ==========================================
// Code Generation
// ==========================================

/**
 * Extract content between balanced parentheses starting at a given position
 */
function extractParenContent(source: string, startPos: number): string {
  let depth = 0;
  let start = -1;
  let end = -1;

  for (let i = startPos; i < source.length; i++) {
    if (source[i] === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (source[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (start !== -1 && end !== -1) {
    return source.slice(start + 1, end); // Content without outer parens
  }
  return "";
}

/**
 * Convert Zod schema source to TypeScript type string
 * This is a simplified conversion - handles common cases
 */
function zodToTypeScript(zodSource: string | undefined): string {
  if (!zodSource) return "unknown";

  // Simple mappings
  const typeMap: Record<string, string> = {
    "z.string()": "string",
    "z.number()": "number",
    "z.boolean()": "boolean",
    "z.null()": "null",
    "z.undefined()": "undefined",
    "z.void()": "void",
    "z.any()": "any",
    "z.unknown()": "unknown",
    "z.never()": "never",
    "z.date()": "Date",
    "z.bigint()": "bigint",
  };

  // Direct match
  if (typeMap[zodSource]) return typeMap[zodSource];

  // Handle .optional() and .nullable()
  let source = zodSource;
  let suffix = "";

  if (source.endsWith(".optional()")) {
    source = source.slice(0, -".optional()".length);
    suffix = " | undefined";
  } else if (source.endsWith(".nullable()")) {
    source = source.slice(0, -".nullable()".length);
    suffix = " | null";
  }

  // z.object({ ... }) - use balanced brace extraction
  if (source.startsWith("z.object(")) {
    const innerContent = extractParenContent(source, 8); // Start after "z.object"
    // Remove outer { } if present
    const trimmed = innerContent.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const propsSource = trimmed.slice(1, -1).trim();
      const props = parseObjectProps(propsSource);
      const typeProps = props
        .map((p) => `  ${p.name}${p.optional ? "?" : ""}: ${zodToTypeScript(p.schema)};`)
        .join("\n");
      return `{\n${typeProps}\n}${suffix}`;
    }
  }

  // z.array(...) - use balanced parenthesis extraction
  if (source.startsWith("z.array(")) {
    const innerContent = extractParenContent(source, 7); // Start after "z.array"
    if (innerContent) {
      return `${zodToTypeScript(innerContent.trim())}[]${suffix}`;
    }
  }

  // z.enum([...])
  const enumMatch = source.match(/z\.enum\s*\(\s*\[([^\]]+)\]\s*\)/);
  if (enumMatch?.[1]) {
    const values = enumMatch[1]
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return values.join(" | ") + suffix;
  }

  // z.literal(...)
  const literalMatch = source.match(/z\.literal\s*\(\s*([^)]+)\s*\)/);
  if (literalMatch?.[1]) {
    return literalMatch[1].trim() + suffix;
  }

  // z.union([...])
  const unionMatch = source.match(/z\.union\s*\(\s*\[([^\]]+)\]\s*\)/);
  if (unionMatch?.[1]) {
    const schemas = splitTopLevel(unionMatch[1], ",");
    return schemas.map((s) => zodToTypeScript(s.trim())).join(" | ") + suffix;
  }

  // z.record(...)
  const recordMatch = source.match(/z\.record\s*\(\s*([^)]+)\s*\)/);
  if (recordMatch?.[1]) {
    const parts = splitTopLevel(recordMatch[1], ",");
    if (parts.length === 2) {
      return `Record<${zodToTypeScript(parts[0]?.trim())}, ${zodToTypeScript(parts[1]?.trim())}>${suffix}`;
    }
    return `Record<string, ${zodToTypeScript(recordMatch[1].trim())}>${suffix}`;
  }

  // z.tuple([...])
  const tupleMatch = source.match(/z\.tuple\s*\(\s*\[([^\]]+)\]\s*\)/);
  if (tupleMatch?.[1]) {
    const schemas = splitTopLevel(tupleMatch[1], ",");
    return `[${schemas.map((s) => zodToTypeScript(s.trim())).join(", ")}]${suffix}`;
  }

  // z.string().min/max/email/etc - just string
  if (source.startsWith("z.string()")) return "string" + suffix;
  if (source.startsWith("z.number()")) return "number" + suffix;

  // Default fallback
  return "unknown" + suffix;
}

/**
 * Parse object property definitions from Zod source
 */
function parseObjectProps(
  propsSource: string
): { name: string; schema: string; optional: boolean }[] {
  const props: { name: string; schema: string; optional: boolean }[] = [];

  // Split by top-level commas
  const entries = splitTopLevel(propsSource, ",");

  for (const entry of entries) {
    const colonIndex = entry.indexOf(":");
    if (colonIndex === -1) continue;

    const name = entry.slice(0, colonIndex).trim();
    let schema = entry.slice(colonIndex + 1).trim();

    // Check for optional
    const optional = schema.endsWith(".optional()");
    if (optional) {
      schema = schema.slice(0, -".optional()".length);
    }

    props.push({ name, schema, optional });
  }

  return props;
}

/**
 * Split string by delimiter, respecting nested brackets
 */
function splitTopLevel(source: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of source) {
    if (char === "(" || char === "[" || char === "{") {
      depth++;
      current += char;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
      current += char;
    } else if (char === delimiter && depth === 0) {
      if (current.trim()) {
        result.push(current.trim());
      }
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

/**
 * Group routes by prefix
 */
function groupRoutesByPrefix(routes: RouteInfo[]): Map<string, RouteInfo[]> {
  const groups = new Map<string, RouteInfo[]>();

  for (const route of routes) {
    const prefix = route.prefix || "_root";
    if (!groups.has(prefix)) {
      groups.set(prefix, []);
    }
    groups.get(prefix)!.push(route);
  }

  return groups;
}

/**
 * Generate the API client code
 */
function generateClientCode(ctx: GenerationContext): string {
  const { routes, events, clientConfigs } = ctx;

  // Determine default credentials
  const defaultCredentials =
    clientConfigs.find((c) => c.credentials)?.credentials || "include";

  // Group routes by prefix
  const routeGroups = groupRoutesByPrefix(routes);

  // Generate route type definitions
  const routeTypeBlocks: string[] = [];
  const routeNamespaceBlocks: string[] = [];

  for (const [prefix, prefixRoutes] of routeGroups) {
    const namespaceName = prefix === "_root" ? "Root" : toPascalCase(prefix);
    const methodName = prefix === "_root" ? "_root" : prefix;

    // Generate type namespace
    const typeEntries = prefixRoutes
      .filter((r) => r.handler === "typed")
      .map((r) => {
        const inputType = zodToTypeScript(r.inputSource);
        const outputType = zodToTypeScript(r.outputSource);
        return `    export type ${toPascalCase(r.routeName)}Input = ${inputType};
    export type ${toPascalCase(r.routeName)}Output = ${outputType};`;
      });

    if (typeEntries.length > 0) {
      routeTypeBlocks.push(`  export namespace ${namespaceName} {
${typeEntries.join("\n\n")}
  }`);
    }

    // Generate route methods
    const methodEntries = prefixRoutes
      .filter((r) => r.handler === "typed")
      .map((r) => {
        const inputType = `Routes.${namespaceName}.${toPascalCase(r.routeName)}Input`;
        const outputType = `Routes.${namespaceName}.${toPascalCase(r.routeName)}Output`;
        return `    ${toCamelCase(r.routeName)}: (input: ${inputType}, options?: RequestOptions): Promise<${outputType}> =>
      this.request("${r.name}", input, options)`;
      });

    // Add raw routes as methods returning Response
    const rawMethodEntries = prefixRoutes
      .filter((r) => r.handler === "raw")
      .map((r) => {
        return `    ${toCamelCase(r.routeName)}: (init?: RequestInit): Promise<Response> =>
      this.rawRequest("${r.name}", init)`;
      });

    const allMethods = [...methodEntries, ...rawMethodEntries];

    if (allMethods.length > 0) {
      routeNamespaceBlocks.push(`  ${methodName} = {
${allMethods.join(",\n\n")}
  };`);
    }
  }

  // Generate event types
  const eventTypeEntries = events.map((e) => {
    const type = zodToTypeScript(e.schemaSource);
    return `  "${e.name}": ${type};`;
  });

  const eventTypesBlock =
    eventTypeEntries.length > 0
      ? `export interface SSEEvents {
${eventTypeEntries.join("\n")}
}`
      : `export interface SSEEvents {}`;

  // Generate the client class
  return `// Auto-generated by scripts/generate-client.ts
// DO NOT EDIT MANUALLY

import {
  ApiClientBase,
  ApiError,
  ValidationError,
  type RequestOptions,
  type ApiClientOptions,
  type SSEOptions,
} from "./base";

// ============================================
// Route Types
// ============================================

export namespace Routes {
${routeTypeBlocks.join("\n\n") || "  // No typed routes found"}
}

// ============================================
// SSE Event Types
// ============================================

${eventTypesBlock}

// ============================================
// API Client
// ============================================

export interface ApiClientConfig extends ApiClientOptions {
  /** Base URL of the API server */
  baseUrl: string;
}

/**
 * Typed API Client
 *
 * @example
 * \`\`\`ts
 * const api = createApiClient({ baseUrl: "http://localhost:3000" });
 *
 * // Typed route calls
 * const result = await api.users.get({ id: 1 });
 *
 * // SSE events
 * api.connect();
 * api.on("notifications.new", (data) => {
 *   console.log(data.message);
 * });
 * \`\`\`
 */
export class ApiClient extends ApiClientBase<SSEEvents> {
  constructor(config: ApiClientConfig) {
    super(config.baseUrl, {
      credentials: "${defaultCredentials}",
      ...config,
    });
  }

  // ==========================================
  // Route Namespaces
  // ==========================================

${routeNamespaceBlocks.join("\n\n") || "  // No routes defined"}
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a new API client instance
 *
 * @param config - Client configuration
 * @returns Typed API client
 *
 * @example
 * \`\`\`ts
 * const api = createApiClient({ baseUrl: "http://localhost:3000" });
 * const user = await api.users.get({ id: 1 });
 * \`\`\`
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
  return new ApiClient(config);
}

// Re-export base types for convenience
export { ApiError, ValidationError, type RequestOptions, type SSEOptions };
`;
}

// ==========================================
// Utility Functions
// ==========================================

function toPascalCase(str: string): string {
  return str
    .split(/[-_.]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ==========================================
// Main
// ==========================================

function printUsage() {
  console.log(`
Usage: bun scripts/generate-client.ts [options] [server-files...]

Options:
  --output <path>     Output directory (default: ./client)
  --name <name>       Client filename (default: index.ts)
  --help              Show this help message

Examples:
  bun scripts/generate-client.ts server.ts
  bun scripts/generate-client.ts --output ./src/api index.ts
  bun scripts/generate-client.ts                    # Scans for common server files
`);
}

async function findServerFiles(): Promise<string[]> {
  const cwd = process.cwd();
  const candidates = [
    "server.ts",
    "index.ts",
    "app.ts",
    "api.ts",
    "src/server.ts",
    "src/index.ts",
    "src/app.ts",
  ];

  const found: string[] = [];

  for (const candidate of candidates) {
    const fullPath = join(cwd, candidate);
    if (existsSync(fullPath)) {
      // Check if file contains createRouter
      const content = await readFile(fullPath, "utf-8");
      if (content.includes("createRouter")) {
        found.push(fullPath);
      }
    }
  }

  return found;
}

async function main() {
  const args = Bun.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  // Parse arguments
  const { values, positionals } = parseArgs({
    args,
    options: {
      output: { type: "string", default: "./client" },
      name: { type: "string", default: "index.ts" },
    },
    allowPositionals: true,
  });

  const outputDir = values.output!;
  const outputName = values.name!;

  // Determine server files to scan
  let serverFiles = positionals.map((p) => {
    // Handle both absolute and relative paths
    if (p.startsWith("/")) {
      return p; // Already absolute
    }
    return join(process.cwd(), p);
  });

  if (serverFiles.length === 0) {
    console.log("No server files specified, scanning for common patterns...");
    serverFiles = await findServerFiles();

    if (serverFiles.length === 0) {
      console.error(
        "Error: No server files found. Specify files or create a server file with createRouter."
      );
      process.exit(1);
    }
  }

  console.log(`Scanning server files: ${serverFiles.map((f) => relative(process.cwd(), f)).join(", ")}`);

  // Collect routes from server files
  const allRoutes: RouteInfo[] = [];
  for (const file of serverFiles) {
    if (!existsSync(file)) {
      console.warn(`Warning: File not found: ${file}`);
      continue;
    }
    const routes = await extractRoutes(file);
    allRoutes.push(...routes);
  }

  console.log(`Found ${allRoutes.length} routes`);

  // Collect events and client config from plugins
  const pluginsDir = join(process.cwd(), "plugins");
  const allEvents: EventInfo[] = [];
  const allClientConfigs: ClientConfigInfo[] = [];

  if (existsSync(pluginsDir)) {
    const pluginDirs = await readdir(pluginsDir);

    for (const pluginDir of pluginDirs) {
      const pluginPath = join(pluginsDir, pluginDir);
      const stats = await stat(pluginPath);

      if (stats.isDirectory()) {
        const { events, clientConfig } = await extractPluginInfo(pluginPath);
        allEvents.push(...events);
        if (clientConfig) {
          allClientConfigs.push(clientConfig);
        }
      }
    }
  }

  console.log(`Found ${allEvents.length} events from plugins`);

  // Generate client code
  const ctx: GenerationContext = {
    routes: allRoutes,
    events: allEvents,
    clientConfigs: allClientConfigs,
  };

  const clientCode = generateClientCode(ctx);

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  // Write client file
  const outputPath = join(outputDir, outputName);
  await writeFile(outputPath, clientCode);
  console.log(`Generated: ${relative(process.cwd(), outputPath)}`);

  // Copy base.ts if not already in output directory
  const basePath = join(outputDir, "base.ts");
  const sourceBasePath = join(process.cwd(), "src/client", "base.ts");

  if (existsSync(sourceBasePath) && outputDir !== join(process.cwd(), "client")) {
    const baseContent = await readFile(sourceBasePath, "utf-8");
    await writeFile(basePath, baseContent);
    console.log(`Copied: ${relative(process.cwd(), basePath)}`);
  }

  console.log(`
Client generated successfully!

Usage:
  import { createApiClient } from "./${relative(process.cwd(), outputDir)}";

  const api = createApiClient({ baseUrl: "http://localhost:3000" });

  // Typed routes
  const result = await api.${allRoutes[0]?.prefix || "api"}.${allRoutes[0]?.routeName || "method"}({ ... });

  // SSE events
  api.connect();
  api.on("eventName", (data) => { ... });
`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
