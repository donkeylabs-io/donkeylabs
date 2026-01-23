/**
 * Generator Building Blocks
 *
 * This module exports reusable functions for generating API clients.
 * Adapters (like @donkeylabs/adapter-sveltekit) can import these functions
 * and compose them with custom options to generate framework-specific clients.
 */

// ==========================================
// Types
// ==========================================

export interface RouteInfo {
  name: string;
  prefix: string;
  routeName: string;
  handler: "typed" | "raw" | string;
  inputSource?: string;
  outputSource?: string;
  /** SSE event schemas (for sse handler) */
  eventsSource?: Record<string, string>;
}

export interface EventInfo {
  name: string;
  plugin: string;
  schemaSource: string;
}

export interface ClientConfigInfo {
  plugin: string;
  credentials?: "include" | "same-origin" | "omit";
}

export interface GeneratorConfig {
  routes: RouteInfo[] | ExtractedRoute[];
  events?: EventInfo[];
  clientConfigs?: ClientConfigInfo[];
}

export interface ExtractedRoute {
  name: string;
  handler: string;
}

export interface ClientGeneratorOptions {
  /** Import statement for base class */
  baseImport: string;
  /** Base class name to extend */
  baseClass: string;
  /** Constructor parameters signature */
  constructorSignature: string;
  /** Constructor body implementation */
  constructorBody: string;
  /** Additional imports to include */
  additionalImports?: string[];
  /** Custom factory function (replaces default) */
  factoryFunction?: string;
  /** Additional class members to include */
  additionalMembers?: string[];
}

/** Default options for standard HTTP-only client */
export const defaultGeneratorOptions: ClientGeneratorOptions = {
  baseImport: 'import { ApiClientBase, type ApiClientOptions } from "@donkeylabs/server/client";',
  baseClass: "ApiClientBase<{}>",
  constructorSignature: "baseUrl: string, options?: ApiClientOptions",
  constructorBody: "super(baseUrl, options);",
  factoryFunction: `export function createApiClient(baseUrl: string, options?: ApiClientOptions) {
  return new ApiClient(baseUrl, options);
}`,
};

// ==========================================
// Utility Functions
// ==========================================

export function toPascalCase(str: string): string {
  return str
    .split(/[-_.]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

export function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Split string by delimiter, respecting nested brackets
 */
export function splitTopLevel(source: string, delimiter: string): string[] {
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
 * Extract content between balanced parentheses starting at a given position
 */
export function extractParenContent(source: string, startPos: number): string {
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
    return source.slice(start + 1, end);
  }
  return "";
}

// ==========================================
// Zod to TypeScript Conversion
// ==========================================

/**
 * Parse object property definitions from Zod source
 */
function parseObjectProps(
  propsSource: string
): { name: string; schema: string; optional: boolean }[] {
  const props: { name: string; schema: string; optional: boolean }[] = [];
  const entries = splitTopLevel(propsSource, ",");

  for (const entry of entries) {
    const colonIndex = entry.indexOf(":");
    if (colonIndex === -1) continue;

    const name = entry.slice(0, colonIndex).trim();
    let schema = entry.slice(colonIndex + 1).trim();

    const optional = schema.endsWith(".optional()");
    if (optional) {
      schema = schema.slice(0, -".optional()".length);
    }

    props.push({ name, schema, optional });
  }

  return props;
}

/**
 * Convert Zod schema source to TypeScript type string
 */
export function zodToTypeScript(zodSource: string | undefined): string {
  if (!zodSource) return "unknown";

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

  if (typeMap[zodSource]) return typeMap[zodSource];

  let source = zodSource;
  let suffix = "";

  if (source.endsWith(".optional()")) {
    source = source.slice(0, -".optional()".length);
    suffix = " | undefined";
  } else if (source.endsWith(".nullable()")) {
    source = source.slice(0, -".nullable()".length);
    suffix = " | null";
  }

  // z.object({ ... })
  if (source.startsWith("z.object(")) {
    const innerContent = extractParenContent(source, 8);
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

  // z.array(...)
  if (source.startsWith("z.array(")) {
    const innerContent = extractParenContent(source, 7);
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

  // z.string().min/max/email/etc
  if (source.startsWith("z.string()")) return "string" + suffix;
  if (source.startsWith("z.number()")) return "number" + suffix;

  return "unknown" + suffix;
}

// ==========================================
// Route Grouping
// ==========================================

/**
 * Group routes by prefix for namespace organization
 */
export function groupRoutesByPrefix(routes: RouteInfo[]): Map<string, RouteInfo[]> {
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

// ==========================================
// Client Code Generation
// ==========================================

/**
 * Generate client code from extracted routes (simple format)
 * This is used by the CLI command which extracts routes by running the server
 */
export function generateClientFromRoutes(
  routes: ExtractedRoute[],
  options: Partial<ClientGeneratorOptions> = {}
): string {
  const opts = { ...defaultGeneratorOptions, ...options };

  // Check if all routes share a common prefix (e.g., "api.") - if so, skip it
  // Common prefix stripping is disabled to respect explicit router nesting
  const routesToProcess = routes;

  // Group routes by namespace
  const tree = new Map<string, Map<string, { method: string; fullName: string }[]>>();

  for (const route of routesToProcess) {
    // Find original route name for the actual request
    const originalRoute = routes.find(r => r.name.endsWith(route.name));
    const fullName = originalRoute?.name || route.name;

    const parts = route.name.split(".");
    if (parts.length < 2) {
      const ns = "";
      if (!tree.has(ns)) tree.set(ns, new Map());
      const rootMethods = tree.get(ns)!;
      if (!rootMethods.has("")) rootMethods.set("", []);
      rootMethods.get("")!.push({ method: parts[0]!, fullName });
    } else if (parts.length === 2) {
      const [ns, method] = parts;
      if (!tree.has(ns!)) tree.set(ns!, new Map());
      const nsMethods = tree.get(ns!)!;
      if (!nsMethods.has("")) nsMethods.set("", []);
      nsMethods.get("")!.push({ method: method!, fullName });
    } else {
      const [ns, sub, ...rest] = parts;
      const method = rest.join(".");
      if (!tree.has(ns!)) tree.set(ns!, new Map());
      const nsMethods = tree.get(ns!)!;
      if (!nsMethods.has(sub!)) nsMethods.set(sub!, []);
      nsMethods.get(sub!)!.push({ method: method || sub!, fullName });
    }
  }

  // Generate method definitions
  const namespaceBlocks: string[] = [];

  for (const [namespace, subNamespaces] of tree) {
    if (namespace === "") {
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
        for (const { method, fullName } of methods) {
          const methodName = method.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
          subBlocks.push(`    ${methodName}: (input: any) => this.request("${fullName}", input)`);
        }
      } else {
        const subMethods = methods.map(({ method, fullName }) => {
          const methodName = method.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
          return `      ${methodName}: (input: any) => this.request("${fullName}", input)`;
        });
        subBlocks.push(`    ${sub}: {\n${subMethods.join(",\n")}\n    }`);
      }
    }

    namespaceBlocks.push(`  ${namespace} = {\n${subBlocks.join(",\n")}\n  };`);
  }

  // Build additional imports
  const additionalImportsStr = opts.additionalImports?.length
    ? "\n" + opts.additionalImports.join("\n")
    : "";

  // Build additional members
  const additionalMembersStr = opts.additionalMembers?.length
    ? "\n\n" + opts.additionalMembers.join("\n\n")
    : "";

  return `// Auto-generated by donkeylabs generate
// DO NOT EDIT MANUALLY

${opts.baseImport}${additionalImportsStr}

export class ApiClient extends ${opts.baseClass} {
  constructor(${opts.constructorSignature}) {
    ${opts.constructorBody}
  }

${namespaceBlocks.join("\n\n") || "  // No routes defined"}${additionalMembersStr}
}

${opts.factoryFunction}
`;
}

/**
 * Generate fully-typed client code with route types (advanced format)
 * This is used by the standalone script which parses source files
 */
export function generateClientCode(
  ctx: GeneratorConfig,
  options: Partial<ClientGeneratorOptions> = {}
): string {
  const { routes, events = [], clientConfigs = [] } = ctx;
  const opts = { ...defaultGeneratorOptions, ...options };

  // Check if routes are simple ExtractedRoute format
  if (routes.length > 0 && !("prefix" in routes[0])) {
    return generateClientFromRoutes(routes as ExtractedRoute[], options);
  }

  const routeInfos = routes as RouteInfo[];
  const defaultCredentials =
    clientConfigs.find((c) => c.credentials)?.credentials || "include";

  const routeGroups = groupRoutesByPrefix(routeInfos);

  // Generate route type definitions
  const routeTypeBlocks: string[] = [];
  const routeNamespaceBlocks: string[] = [];

  for (const [prefix, prefixRoutes] of routeGroups) {
    const namespaceName = prefix === "_root" ? "Root" : toPascalCase(prefix);
    const methodName = prefix === "_root" ? "_root" : prefix;

    const typedTypeEntries = prefixRoutes
      .filter((r) => r.handler === "typed")
      .map((r) => {
        const inputType = zodToTypeScript(r.inputSource);
        const outputType = zodToTypeScript(r.outputSource);
        const routeNs = toPascalCase(r.routeName);
        return `    export namespace ${routeNs} {
      export type Input = ${inputType};
      export type Output = ${outputType};
    }
    export type ${routeNs} = { Input: ${routeNs}.Input; Output: ${routeNs}.Output };`;
      });

    const formDataTypeEntries = prefixRoutes
      .filter((r) => r.handler === "formData")
      .map((r) => {
        const inputType = zodToTypeScript(r.inputSource);
        const outputType = zodToTypeScript(r.outputSource);
        const routeNs = toPascalCase(r.routeName);
        return `    export namespace ${routeNs} {
      export type Input = ${inputType};
      export type Output = ${outputType};
    }
    export type ${routeNs} = { Input: ${routeNs}.Input; Output: ${routeNs}.Output };`;
      });

    const streamTypeEntries = prefixRoutes
      .filter((r) => r.handler === "stream" || r.handler === "html")
      .map((r) => {
        const inputType = zodToTypeScript(r.inputSource);
        const routeNs = toPascalCase(r.routeName);
        return `    export namespace ${routeNs} {
      export type Input = ${inputType};
    }
    export type ${routeNs} = { Input: ${routeNs}.Input };`;
      });

    const sseTypeEntries = prefixRoutes
      .filter((r) => r.handler === "sse")
      .map((r) => {
        const inputType = zodToTypeScript(r.inputSource);
        const routeNs = toPascalCase(r.routeName);
        // Generate Events type from eventsSource
        const eventsEntries = r.eventsSource
          ? Object.entries(r.eventsSource)
              .map(([eventName, eventType]) => `      "${eventName}": ${zodToTypeScript(eventType)};`)
              .join("\n")
          : "";
        const eventsType = eventsEntries ? `{\n${eventsEntries}\n    }` : "Record<string, unknown>";
        return `    export namespace ${routeNs} {
      export type Input = ${inputType};
      export type Events = ${eventsType};
    }
    export type ${routeNs} = { Input: ${routeNs}.Input; Events: ${routeNs}.Events };`;
      });

    const typeEntries = [...typedTypeEntries, ...formDataTypeEntries, ...streamTypeEntries, ...sseTypeEntries];

    if (typeEntries.length > 0) {
      routeTypeBlocks.push(`  export namespace ${namespaceName} {
${typeEntries.join("\n\n")}
  }`);
    }

    const methodEntries = prefixRoutes
      .filter((r) => r.handler === "typed")
      .map((r) => {
        const inputType = `Routes.${namespaceName}.${toPascalCase(r.routeName)}.Input`;
        const outputType = `Routes.${namespaceName}.${toPascalCase(r.routeName)}.Output`;
        return `    ${toCamelCase(r.routeName)}: (input: ${inputType}, options?: RequestOptions): Promise<${outputType}> =>
      this.request("${r.name}", input, options)`;
      });

    const rawMethodEntries = prefixRoutes
      .filter((r) => r.handler === "raw")
      .map((r) => {
        return `    ${toCamelCase(r.routeName)}: (init?: RequestInit): Promise<Response> =>
      this.rawRequest("${r.name}", init)`;
      });

    const sseMethodEntries = prefixRoutes
      .filter((r) => r.handler === "sse")
      .map((r) => {
        const inputType = r.inputSource
          ? `Routes.${namespaceName}.${toPascalCase(r.routeName)}.Input`
          : "Record<string, any>";
        const eventsType = `Routes.${namespaceName}.${toPascalCase(r.routeName)}.Events`;
        return `    ${toCamelCase(r.routeName)}: (input: ${inputType}, options?: Omit<SSEOptions, "endpoint" | "channels">): SSESubscription<${eventsType}> =>
      this.connectToSSERoute("${r.name}", input, options)`;
      });

    const streamMethodEntries = prefixRoutes
      .filter((r) => r.handler === "stream" || r.handler === "html")
      .map((r) => {
        const inputType = r.inputSource
          ? `Routes.${namespaceName}.${toPascalCase(r.routeName)}.Input`
          : "Record<string, any>";
        return `    ${toCamelCase(r.routeName)}: (input: ${inputType}): Promise<Response> =>
      this.streamRequest("${r.name}", input)`;
      });

    const formDataMethodEntries = prefixRoutes
      .filter((r) => r.handler === "formData")
      .map((r) => {
        const inputType = `Routes.${namespaceName}.${toPascalCase(r.routeName)}.Input`;
        const outputType = `Routes.${namespaceName}.${toPascalCase(r.routeName)}.Output`;
        return `    ${toCamelCase(r.routeName)}: (fields: ${inputType}, files?: File[]): Promise<${outputType}> =>
      this.uploadFormData("${r.name}", fields, files)`;
      });

    const allMethods = [...methodEntries, ...rawMethodEntries, ...sseMethodEntries, ...streamMethodEntries, ...formDataMethodEntries];

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

  // Build additional imports
  const additionalImportsStr = opts.additionalImports?.length
    ? "\n" + opts.additionalImports.join("\n")
    : "";

  return `// Auto-generated by scripts/generate-client.ts
// DO NOT EDIT MANUALLY

import {
  ApiClientBase,
  ApiError,
  ValidationError,
  type RequestOptions,
  type ApiClientOptions,
  type SSEOptions,
  type SSESubscription,
} from "./base";${additionalImportsStr}

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
  baseUrl: string;
}

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

export function createApiClient(config: ApiClientConfig): ApiClient {
  return new ApiClient(config);
}

// Re-export base types for convenience
export { ApiError, ValidationError, type RequestOptions, type SSEOptions, type SSESubscription };
`;
}

// Re-export runtime Zod to TypeScript converter
export { zodSchemaToTs } from "./zod-to-ts";
