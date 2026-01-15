// Re-export GlobalContext from core for backwards compatibility
// The actual definition is in src/core.ts, next to PluginRegistry,
// so that declaration merging on "@donkeylabs/server" works correctly.

export type { GlobalContext } from "./src/core";

/**
 * @deprecated Import GlobalContext from "@donkeylabs/server" instead
 */
export interface GlobalContextPlugins {}
