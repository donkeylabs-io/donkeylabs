/**
 * SvelteKit-specific client generator
 *
 * This generator extends the core @donkeylabs/server generator
 * to produce clients that work with both SSR (direct calls) and browser (HTTP).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  generateClientCode,
  zodToTypeScript,
  toPascalCase,
  toCamelCase,
  type RouteInfo,
  type ExtractedRoute,
  type ClientGeneratorOptions,
} from "@donkeylabs/server/generator";

/**
 * Type guard to check if a route is a full RouteInfo (with prefix and routeName)
 */
function isRouteInfo(route: RouteInfo | ExtractedRoute): route is RouteInfo {
  return (
    typeof route === "object" &&
    route !== null &&
    "prefix" in route &&
    "routeName" in route &&
    typeof (route as RouteInfo).prefix === "string"
  );
}

/** SvelteKit-specific generator options */
export const svelteKitGeneratorOptions: ClientGeneratorOptions = {
  baseImport:
    'import { UnifiedApiClientBase, type ClientOptions } from "@donkeylabs/adapter-sveltekit/client";',
  baseClass: "UnifiedApiClientBase",
  constructorSignature: "options?: ClientOptions",
  constructorBody: "super(options);",
  factoryFunction: `/**
 * Create an API client instance
 *
 * @param options.locals - Pass SvelteKit locals for SSR direct calls (no HTTP overhead)
 * @param options.baseUrl - Override the base URL for HTTP calls
 *
 * @example SSR usage in +page.server.ts:
 * \`\`\`ts
 * export const load = async ({ locals }) => {
 *   const api = createApi({ locals });
 *   const data = await api.myRoute.get({}); // Direct call, no HTTP!
 *   return { data };
 * };
 * \`\`\`
 *
 * @example Browser usage in +page.svelte:
 * \`\`\`svelte
 * <script>
 *   import { createApi } from '$lib/api';
 *   const api = createApi(); // HTTP calls
 *   let data = $state(null);
 *   async function load() {
 *     data = await api.myRoute.get({});
 *   }
 * </script>
 * \`\`\`
 */
export function createApi(options?: ClientOptions) {
  return new ApiClient(options);
}`,
};

/**
 * Generate a fully-typed SvelteKit-compatible API client
 */
function generateTypedSvelteKitClient(routes: RouteInfo[]): string {
  const opts = svelteKitGeneratorOptions;

  // Check if all routes share a common prefix (e.g., "api.") - if so, strip it
  let routesToProcess = routes;
  let commonPrefix = "";
  if (routes.length > 0) {
    const firstPart = routes[0]?.name.split(".")[0];
    const allSharePrefix = firstPart && routes.every(r => r.name.startsWith(firstPart + "."));
    if (allSharePrefix && firstPart) {
      commonPrefix = firstPart;
      // Strip the common prefix from route names for client generation
      routesToProcess = routes.map(r => ({
        ...r,
        name: r.name.slice(firstPart.length + 1), // Remove "api." prefix
        prefix: r.prefix === firstPart ? "" : r.prefix.slice(firstPart.length + 1),
      }));
    }
  }

  // Group routes by namespace
  const groups = new Map<string, RouteInfo[]>();
  for (const route of routesToProcess) {
    const parts = route.name.split(".");
    const namespace = parts.length > 1 ? parts[0]! : "_root";
    if (!groups.has(namespace)) {
      groups.set(namespace, []);
    }
    groups.get(namespace)!.push({
      ...route,
      routeName: parts.length > 1 ? parts.slice(1).join(".") : parts[0]!,
    });
  }

  // Generate type definitions
  const typeBlocks: string[] = [];
  const methodBlocks: string[] = [];

  for (const [namespace, nsRoutes] of groups) {
    const pascalNs = namespace === "_root" ? "Root" : toPascalCase(namespace);
    const methodNs = namespace === "_root" ? "_root" : namespace;

    // Generate types for this namespace
    const typeEntries = nsRoutes
      .filter(r => r.handler === "typed")
      .map(r => {
        const pascalRoute = toPascalCase(r.routeName);
        const inputType = r.inputSource ? zodToTypeScript(r.inputSource) : "Record<string, never>";
        const outputType = r.outputSource ? zodToTypeScript(r.outputSource) : "unknown";
        return `    export type ${pascalRoute}Input = Expand<${inputType}>;
    export type ${pascalRoute}Output = Expand<${outputType}>;`;
      });

    if (typeEntries.length > 0) {
      typeBlocks.push(`  export namespace ${pascalNs} {\n${typeEntries.join("\n\n")}\n  }`);
    }

    // Generate methods for this namespace
    const methodEntries = nsRoutes
      .filter(r => r.handler === "typed")
      .map(r => {
        const methodName = toCamelCase(r.routeName);
        const pascalRoute = toPascalCase(r.routeName);
        const inputType = `Routes.${pascalNs}.${pascalRoute}Input`;
        const outputType = `Routes.${pascalNs}.${pascalRoute}Output`;
        // Use original route name with prefix for the request
        const fullRouteName = commonPrefix ? `${commonPrefix}.${r.name}` : r.name;
        return `    ${methodName}: (input: ${inputType}): Promise<${outputType}> => this.request("${fullRouteName}", input)`;
      });

    const rawMethodEntries = nsRoutes
      .filter(r => r.handler === "raw")
      .map(r => {
        const methodName = toCamelCase(r.routeName);
        const fullRouteName = commonPrefix ? `${commonPrefix}.${r.name}` : r.name;
        return `    ${methodName}: (init?: RequestInit): Promise<Response> => this.rawRequest("${fullRouteName}", init)`;
      });

    const allMethods = [...methodEntries, ...rawMethodEntries];
    if (allMethods.length > 0) {
      if (namespace === "_root") {
        // Root-level methods go directly on the class
        for (const method of allMethods) {
          methodBlocks.push(method.replace(/^    /, "  "));
        }
      } else {
        methodBlocks.push(`  ${methodNs} = {\n${allMethods.join(",\n")}\n  };`);
      }
    }
  }

  return `// Auto-generated by donkeylabs generate
// DO NOT EDIT MANUALLY

${opts.baseImport}

// Utility type that forces TypeScript to expand types on hover
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

// ============================================
// Route Types
// ============================================

export namespace Routes {
${typeBlocks.join("\n\n") || "  // No typed routes found"}
}

// ============================================
// API Client
// ============================================

export class ApiClient extends ${opts.baseClass} {
  constructor(${opts.constructorSignature}) {
    ${opts.constructorBody}
  }

${methodBlocks.join("\n\n") || "  // No routes defined"}
}

${opts.factoryFunction}
`;
}

/**
 * Generate a SvelteKit-compatible API client
 *
 * This is called by the donkeylabs CLI when adapter is set to "@donkeylabs/adapter-sveltekit"
 */
export async function generateClient(
  _config: Record<string, unknown>,
  routes: RouteInfo[] | ExtractedRoute[],
  outputPath: string
): Promise<void> {
  let code: string;

  // Always try typed generation if we have routes
  if (routes.length > 0 && isRouteInfo(routes[0])) {
    // Full RouteInfo - generate typed client
    code = generateTypedSvelteKitClient(routes as RouteInfo[]);
  } else if (routes.length > 0) {
    // Convert ExtractedRoute to RouteInfo for typed generation
    const routeInfos: RouteInfo[] = (routes as ExtractedRoute[]).map((r) => {
      const parts = r.name.split(".");
      return {
        name: r.name,
        prefix: parts.slice(0, -1).join("."),
        routeName: parts[parts.length - 1] || r.name,
        handler: (r.handler || "typed") as "typed" | "raw",
        inputSource: undefined,
        outputSource: undefined,
      };
    });
    code = generateTypedSvelteKitClient(routeInfos);
  } else {
    // Empty routes - generate minimal client
    code = generateTypedSvelteKitClient([]);
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });

  // Write the generated client
  await writeFile(outputPath, code);
}

// Re-export building blocks for advanced usage
export {
  generateClientCode,
  zodToTypeScript,
  toPascalCase,
  toCamelCase,
  type RouteInfo,
  type ExtractedRoute,
  type ClientGeneratorOptions,
} from "@donkeylabs/server/generator";
