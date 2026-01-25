/**
 * Process Client Entry Point
 *
 * Import this in your wrapper scripts:
 * ```ts
 * import { ProcessClient } from "@donkeylabs/server/process-client";
 *
 * const client = await ProcessClient.connect();
 * client.emit("progress", { percent: 50 });
 *
 * // With stats emission
 * const client = await ProcessClient.connect({
 *   stats: { enabled: true, interval: 2000 }
 * });
 * ```
 */

export {
  ProcessClient,
  type ProcessClient as ProcessClientType,
  type ProcessClientConfig,
  type StatsConfig,
  type ProcessStats,
  connect,
  createProcessClient,
} from "./core/process-client";
