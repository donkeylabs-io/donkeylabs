/**
 * SvelteKit-specific client generator
 *
 * This generator extends the core @donkeylabs/server generator
 * to produce clients that work with both SSR (direct calls) and browser (HTTP).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  generateClientFromRoutes,
  type ExtractedRoute,
  type ClientGeneratorOptions,
} from "@donkeylabs/server/generator";

/** SvelteKit-specific generator options */
export const svelteKitGeneratorOptions: ClientGeneratorOptions = {
  baseImport:
    'import { UnifiedApiClientBase, type ApiClientOptions } from "@donkeylabs/adapter-sveltekit/client";',
  baseClass: "UnifiedApiClientBase",
  constructorSignature: "options?: ApiClientOptions",
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
export function createApi(options?: ApiClientOptions) {
  return new ApiClient(options);
}`,
};

/**
 * Generate a SvelteKit-compatible API client
 *
 * This is called by the donkeylabs CLI when adapter is set to "@donkeylabs/adapter-sveltekit"
 */
export async function generateClient(
  _config: Record<string, unknown>,
  routes: ExtractedRoute[],
  outputPath: string
): Promise<void> {
  const code = generateClientFromRoutes(routes, svelteKitGeneratorOptions);

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });

  // Write the generated client
  await writeFile(outputPath, code);
}

// Re-export building blocks for advanced usage
export {
  generateClientFromRoutes,
  type ExtractedRoute,
  type ClientGeneratorOptions,
} from "@donkeylabs/server/generator";
