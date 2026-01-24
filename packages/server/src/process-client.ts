/**
 * Process Client Entry Point
 *
 * Import this in your wrapper scripts:
 * ```ts
 * import { ProcessClient } from "@donkeylabs/server/process-client";
 *
 * const client = await ProcessClient.connect();
 * client.emit("progress", { percent: 50 });
 * ```
 */

export {
  ProcessClient,
  type ProcessClient as ProcessClientType,
  type ProcessClientConfig,
  connect,
  createProcessClient,
} from "./core/process-client";
