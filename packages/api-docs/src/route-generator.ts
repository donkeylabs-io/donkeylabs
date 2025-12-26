/**
 * Route Documentation Generator
 * Extracts documentation from RouterDefinition and RouteDefinition objects
 */

import { isVersionedRouteDefinition, type RouteDefinition, type AnyRouteDefinition } from "@donkeylabs/core/src/interfaces";
import type { RouterDefinition } from "@donkeylabs/core/src/interfaces/server/router";
import type { RateLimitConfig } from "@donkeylabs/core/src/interfaces/server/rate-limit";
import { parseZodSchema, generateExampleValue } from "./schema-parser";
import { generateSdkExample } from "./code-generator";
import type { RouteDoc, RouterDoc, RateLimitDoc, ApiDocs } from "./types";

/**
 * Generate documentation for a single route
 */
export function generateRouteDoc(
  routerName: string,
  routeName: string,
  route: RouteDefinition<unknown, unknown>,
  version?: string
): RouteDoc {
  const requestSchema = parseZodSchema(route.requestSchema);
  const responseSchema = parseZodSchema(route.responseSchema);

  // Generate example input for SDK example
  const exampleInput = generateExampleValue(requestSchema);

  return {
    routerName,
    routeName,
    version,
    path: route.path,
    method: route.method as RouteDoc["method"],
    permissions: route.permissions,
    rateLimit: route.rateLimit ? parseRateLimit(route.rateLimit) : undefined,
    request: requestSchema,
    response: responseSchema,
    sdkExample: generateSdkExample(routerName, routeName, exampleInput, version),
  };
}

/**
 * Generate documentation for a router
 */
export function generateRouterDoc(
  name: string,
  router: RouterDefinition<Record<string, string>, Record<string, AnyRouteDefinition>>
): RouterDoc {
  const routes: RouteDoc[] = [];

  for (const [routeName, route] of Object.entries(router.routes)) {
    if (isVersionedRouteDefinition(route as AnyRouteDefinition)) {
      for (const [version, versionedRoute] of Object.entries(route.versions)) {
        routes.push(
          generateRouteDoc(name, routeName, versionedRoute as RouteDefinition<unknown, unknown>, version),
        );
      }
      continue;
    }

    routes.push(generateRouteDoc(name, routeName, route as RouteDefinition<unknown, unknown>));
  }

  // Sort routes alphabetically by name
  routes.sort((a, b) => a.routeName.localeCompare(b.routeName));

  return {
    name: router.routeName,
    permissions: router.permissions,
    routes,
  };
}

/**
 * Generate documentation for the entire API
 */
export function generateApiDocs(
  api: Record<string, RouterDefinition<Record<string, string>, Record<string, AnyRouteDefinition>>>
): ApiDocs {
  const routers: RouterDoc[] = [];

  for (const [key, router] of Object.entries(api)) {
    routers.push(generateRouterDoc(key, router));
  }

  // Sort routers alphabetically
  routers.sort((a, b) => a.name.localeCompare(b.name));

  return {
    routers,
    generatedAt: new Date().toISOString(),
    version: "1.0.0",
  };
}

/**
 * Parse rate limit config into documentation format
 */
function parseRateLimit(config: RateLimitConfig): RateLimitDoc {
  return {
    maxAttempts: config.maxAttempts ?? 400,
    window: config.window ?? "1m",
    keyStrategy: config.keyStrategy ?? "ip",
    errorMessage: config.errorMessage,
  };
}

/**
 * Get a summary of all routes in the API
 */
export function getRouteSummary(docs: ApiDocs): {
  totalRouters: number;
  totalRoutes: number;
  routesByMethod: Record<string, number>;
} {
  const routesByMethod: Record<string, number> = {};
  let totalRoutes = 0;

  for (const router of docs.routers) {
    for (const route of router.routes) {
      totalRoutes++;
      routesByMethod[route.method] = (routesByMethod[route.method] || 0) + 1;
    }
  }

  return {
    totalRouters: docs.routers.length,
    totalRoutes,
    routesByMethod,
  };
}
