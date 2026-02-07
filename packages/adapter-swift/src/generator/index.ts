/**
 * Swift client generator
 *
 * Generates a typed Swift Package (SPM) from Donkeylabs route metadata.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  groupRoutesByPrefix,
  type RouteInfo,
  type ExtractedRoute,
} from "@donkeylabs/server/generator";
import {
  generatePackageSwift,
  generateRoutesNamespace,
  generateApiClient,
  generateApiClientExtensions,
  generateModelFile,
} from "./swift-codegen.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SwiftConfig {
  plugins?: string[];
  outDir?: string;
  client?: { output: string };
  routes?: string;
  entry?: string;
  adapter?: string;
  swift?: {
    packageName?: string;
    platforms?: Record<string, string>;
    apiVersion?: string;
  };
}

/**
 * Generate a Swift Package client from Donkeylabs routes.
 * Called by the CLI when adapter is set to "@donkeylabs/adapter-swift".
 */
export async function generateClient(
  config: SwiftConfig,
  routes: RouteInfo[] | ExtractedRoute[],
  outputPath: string
): Promise<void> {
  const packageName = config.swift?.packageName || "DonkeylabsApi";
  const platforms = config.swift?.platforms || { iOS: "15.0", macOS: "12.0" };
  const apiVersion = config.swift?.apiVersion;

  // outputPath for Swift is a directory, not a single file
  const outDir = outputPath.endsWith(".ts")
    ? dirname(outputPath)
    : outputPath;
  const packageDir = join(outDir, packageName);
  const sourcesDir = join(packageDir, "Sources", packageName);
  const modelsDir = join(sourcesDir, "Models");

  // Create directory structure
  await mkdir(modelsDir, { recursive: true });

  // Normalize routes to RouteInfo[]
  const routeInfos: RouteInfo[] = normalizeRoutes(routes);

  // 1. Copy runtime Swift files
  await copyRuntimeFiles(sourcesDir);

  // 2. Generate Package.swift
  await writeFile(
    join(packageDir, "Package.swift"),
    generatePackageSwift(packageName, platforms)
  );

  // 3. Generate models (one file per namespace group)
  const groups = groupRoutesByPrefix(routeInfos);
  for (const [prefix, prefixRoutes] of groups) {
    const modelResult = generateModelFile(prefix, prefixRoutes);
    if (modelResult) {
      await writeFile(join(modelsDir, modelResult.fileName), modelResult.content);
    }
  }

  // 4. Generate Routes.swift namespace scaffolding
  await writeFile(
    join(sourcesDir, "Routes.swift"),
    generateRoutesNamespace(routeInfos)
  );

  // 5. Generate ApiClient.swift + per-namespace extensions
  await writeFile(
    join(sourcesDir, "ApiClient.swift"),
    generateApiClient(packageName, apiVersion)
  );

  await writeFile(
    join(sourcesDir, "ApiClient+Routes.swift"),
    generateApiClientExtensions(routeInfos)
  );
}

function normalizeRoutes(routes: RouteInfo[] | ExtractedRoute[]): RouteInfo[] {
  if (routes.length === 0) return [];
  if ("prefix" in routes[0]) return routes as RouteInfo[];

  return (routes as ExtractedRoute[]).map((r) => {
    const parts = r.name.split(".");
    return {
      name: r.name,
      prefix: parts.slice(0, -1).join("."),
      routeName: parts[parts.length - 1] || r.name,
      handler: (r.handler || "typed") as "typed" | "raw",
    };
  });
}

async function copyRuntimeFiles(sourcesDir: string): Promise<void> {
  const runtimeDir = join(__dirname, "..", "runtime");
  const runtimeFiles = [
    "ApiClientBase.swift",
    "ApiError.swift",
    "SSEConnection.swift",
    "AnyCodable.swift",
  ];

  for (const file of runtimeFiles) {
    const content = await readFile(join(runtimeDir, file), "utf-8");
    await writeFile(join(sourcesDir, file), content);
  }
}

// Re-export building blocks for advanced usage
export {
  toPascalCase,
  toCamelCase,
  type RouteInfo,
  type ExtractedRoute,
} from "@donkeylabs/server/generator";
export { zodToSwift, type SwiftTypeContext, type SwiftDeclaration } from "./zod-to-swift.js";
export {
  generatePackageSwift,
  generateRoutesNamespace,
  generateApiClient,
  generateApiClientExtensions,
  generateModelFile,
} from "./swift-codegen.js";
