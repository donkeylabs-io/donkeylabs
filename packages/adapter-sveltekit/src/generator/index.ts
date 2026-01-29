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
    'import { UnifiedApiClientBase, SSEConnection, type ClientOptions, type RequestOptions, type SSEConnectionOptions } from "@donkeylabs/adapter-sveltekit/client";',
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
 * Namespace tree node for building nested client structure
 */
interface NamespaceTreeNode {
  methods: { methodDef: string; typeDef: string }[];
  children: Map<string, NamespaceTreeNode>;
}

/**
 * Build a nested tree structure from routes
 * e.g., routes "api.counter.get", "api.cache.set" become:
 * api -> { counter -> { get }, cache -> { set } }
 */
function buildRouteTree(routes: RouteInfo[], commonPrefix: string): Map<string, NamespaceTreeNode> {
  const tree = new Map<string, NamespaceTreeNode>();

  for (const route of routes) {
    // Get the path parts for nesting (e.g., "api.counter.get" -> ["api", "counter", "get"])
    const parts = route.name.split(".");
    const methodName = parts[parts.length - 1]!; // Last part is the method
    const namespaceParts = parts.slice(0, -1); // Everything before is namespace path

    if (namespaceParts.length === 0) {
      // Root level method
      if (!tree.has("_root")) {
        tree.set("_root", { methods: [], children: new Map() });
      }
      tree.get("_root")!.methods.push(generateMethodAndType(route, methodName, "Root", commonPrefix));
      continue;
    }

    // Navigate/create the tree path
    let current = tree;
    for (let i = 0; i < namespaceParts.length; i++) {
      const part = namespaceParts[i]!;
      if (!current.has(part)) {
        current.set(part, { methods: [], children: new Map() });
      }

      if (i === namespaceParts.length - 1) {
        // At the final namespace level - add the method here
        const pascalNs = toPascalCase(namespaceParts.join("."));
        current.get(part)!.methods.push(generateMethodAndType(route, methodName, pascalNs, commonPrefix));
      } else {
        // Continue traversing
        current = current.get(part)!.children;
      }
    }
  }

  return tree;
}

/**
 * Generate method definition and type definition for a route
 */
function generateMethodAndType(
  route: RouteInfo,
  methodName: string,
  pascalNs: string,
  commonPrefix: string
): { methodDef: string; typeDef: string } {
  const camelMethod = toCamelCase(methodName);
  const pascalRoute = toPascalCase(methodName);
  const fullRouteName = route.name; // Already includes full path

  // Generate input type
  const inputType = route.inputSource
    ? (route.inputSource.trim().startsWith("z.") ? zodToTypeScript(route.inputSource) : route.inputSource)
    : "Record<string, never>";

  // Generate type definition
  let typeDef = "";
  let methodDef = "";

  if (route.handler === "stream" || route.handler === "html") {
    typeDef = `    export namespace ${pascalRoute} {
      export type Input = Expand<${inputType}>;
    }
    export type ${pascalRoute} = { Input: ${pascalRoute}.Input };`;

    if (route.handler === "stream") {
      methodDef = `${camelMethod}: {
      /** POST request with JSON body (programmatic) */
      fetch: (input: Routes.${pascalNs}.${pascalRoute}.Input, options?: RequestOptions): Promise<Response> => this.streamRequest("${fullRouteName}", input, options),
      /** GET URL for browser src attributes (video, img, download links) */
      url: (input: Routes.${pascalNs}.${pascalRoute}.Input): string => this.streamUrl("${fullRouteName}", input),
      /** GET request with query params */
      get: (input: Routes.${pascalNs}.${pascalRoute}.Input, options?: RequestOptions): Promise<Response> => this.streamGet("${fullRouteName}", input, options),
    }`;
    } else {
      const hasInput = route.inputSource;
      methodDef = `${camelMethod}: (${hasInput ? `input: Routes.${pascalNs}.${pascalRoute}.Input` : ""}): Promise<string> => this.htmlRequest("${fullRouteName}"${hasInput ? ", input" : ""})`;
    }
  } else if (route.handler === "sse") {
    const eventsEntries = route.eventsSource
      ? Object.entries(route.eventsSource).map(([eventName, eventSchema]) => {
          const eventType = eventSchema.trim().startsWith("z.")
            ? zodToTypeScript(eventSchema)
            : eventSchema;
          return `        "${eventName}": Expand<${eventType}>;`;
        })
      : [];
    const eventsType = eventsEntries.length > 0
      ? `{\n${eventsEntries.join("\n")}\n      }`
      : "Record<string, unknown>";

    typeDef = `    export namespace ${pascalRoute} {
      export type Input = Expand<${inputType}>;
      export type Events = ${eventsType};
    }
    export type ${pascalRoute} = { Input: ${pascalRoute}.Input; Events: ${pascalRoute}.Events };`;

    const hasInput = route.inputSource;
    if (hasInput) {
      methodDef = `${camelMethod}: (input: Routes.${pascalNs}.${pascalRoute}.Input, options?: SSEConnectionOptions): SSEConnection<Routes.${pascalNs}.${pascalRoute}.Events> => this.sseConnect("${fullRouteName}", input, options)`;
    } else {
      methodDef = `${camelMethod}: (options?: SSEConnectionOptions): SSEConnection<Routes.${pascalNs}.${pascalRoute}.Events> => this.sseConnect("${fullRouteName}", undefined, options)`;
    }
  } else if (route.handler === "raw") {
    typeDef = ""; // Raw routes don't have types
    methodDef = `${camelMethod}: (init?: RequestInit): Promise<Response> => this.rawRequest("${fullRouteName}", init)`;
  } else if (route.handler === "formData") {
    const outputType = route.outputSource
      ? (route.outputSource.trim().startsWith("z.") ? zodToTypeScript(route.outputSource) : route.outputSource)
      : "unknown";

    typeDef = `    export namespace ${pascalRoute} {
      export type Input = Expand<${inputType}>;
      export type Output = Expand<${outputType}>;
    }
    export type ${pascalRoute} = { Input: ${pascalRoute}.Input; Output: ${pascalRoute}.Output };`;

    methodDef = `${camelMethod}: (fields: Routes.${pascalNs}.${pascalRoute}.Input, files: File[]): Promise<Routes.${pascalNs}.${pascalRoute}.Output> => this.formDataRequest("${fullRouteName}", fields, files)`;
  } else {
    // typed handler (default)
    const outputType = route.outputSource
      ? (route.outputSource.trim().startsWith("z.") ? zodToTypeScript(route.outputSource) : route.outputSource)
      : "unknown";

    typeDef = `    export namespace ${pascalRoute} {
      export type Input = Expand<${inputType}>;
      export type Output = Expand<${outputType}>;
    }
    export type ${pascalRoute} = { Input: ${pascalRoute}.Input; Output: ${pascalRoute}.Output };`;

    methodDef = `${camelMethod}: (input: Routes.${pascalNs}.${pascalRoute}.Input, options?: RequestOptions): Promise<Routes.${pascalNs}.${pascalRoute}.Output> => this.request("${fullRouteName}", input, options)`;
  }

  return { methodDef, typeDef };
}

/**
 * Generate nested object code from a tree node
 */
function generateNestedMethods(node: NamespaceTreeNode, indent: string = "    "): string {
  const parts: string[] = [];

  // Add methods at this level
  for (const { methodDef } of node.methods) {
    // Indent each line of the method definition
    const indented = methodDef.split("\n").map((line, i) =>
      i === 0 ? `${indent}${line}` : `${indent}${line}`
    ).join("\n");
    parts.push(indented);
  }

  // Add nested namespaces
  for (const [childName, childNode] of node.children) {
    const childContent = generateNestedMethods(childNode, indent + "  ");
    parts.push(`${indent}${childName}: {\n${childContent}\n${indent}}`);
  }

  return parts.join(",\n");
}

/**
 * Collect all type definitions from a tree
 */
function collectTypeDefs(tree: Map<string, NamespaceTreeNode>, prefix: string = ""): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const [name, node] of tree) {
    const nsPath = prefix ? `${prefix}.${name}` : name;
    const pascalNs = name === "_root" ? "Root" : toPascalCase(nsPath);

    // Collect types from this node's methods
    const typeDefs = node.methods
      .map(m => m.typeDef)
      .filter(t => t.length > 0);

    if (typeDefs.length > 0) {
      if (!result.has(pascalNs)) {
        result.set(pascalNs, []);
      }
      result.get(pascalNs)!.push(...typeDefs);
    }

    // Recursively collect from children
    const childTypes = collectTypeDefs(node.children, nsPath);
    for (const [childNs, childDefs] of childTypes) {
      if (!result.has(childNs)) {
        result.set(childNs, []);
      }
      result.get(childNs)!.push(...childDefs);
    }
  }

  return result;
}

/**
 * Generate a fully-typed SvelteKit-compatible API client
 */
function generateTypedSvelteKitClient(routes: RouteInfo[]): string {
  const opts = svelteKitGeneratorOptions;
  const commonPrefix = ""; // We don't strip prefixes anymore - nested structure handles it

  // Build nested tree structure from routes
  const tree = buildRouteTree(routes, commonPrefix);

  // Collect type definitions from tree
  const typesByNamespace = collectTypeDefs(tree);
  const typeBlocks: string[] = [];
  for (const [nsName, typeDefs] of typesByNamespace) {
    if (typeDefs.length > 0) {
      typeBlocks.push(`  export namespace ${nsName} {\n${typeDefs.join("\n\n")}\n  }`);
    }
  }

  // Generate method blocks from tree
  const methodBlocks: string[] = [];
  for (const [topLevel, node] of tree) {
    if (topLevel === "_root") {
      // Root level methods become direct class properties
      for (const { methodDef } of node.methods) {
        methodBlocks.push(`  ${methodDef};`);
      }
      continue;
    }

    const content = generateNestedMethods(node, "    ");
    methodBlocks.push(`  ${topLevel} = {\n${content}\n  };`);
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
