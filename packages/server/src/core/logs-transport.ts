/**
 * Persistent Transport
 *
 * Bridges the Logger to the Logs service.
 * Extracts source info from entry context and routes to the persistent logs service.
 */

import type { LogEntry, LogTransport, LogLevel } from "./logger";
import type { Logs, LogSource } from "./logs";

// Log level ordering
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Known source tags that map to LogSource types
const SOURCE_TAG_MAP: Record<string, LogSource> = {
  cron: "cron",
  job: "job",
  workflow: "workflow",
  plugin: "plugin",
  system: "system",
  route: "route",
};

export interface PersistentTransportConfig {
  /** Minimum level to persist (default: "info") */
  minLevel?: LogLevel;
}

export class PersistentTransport implements LogTransport {
  private logs: Logs;
  private minLevel: number;

  constructor(logs: Logs, config: PersistentTransportConfig = {}) {
    this.logs = logs;
    this.minLevel = LOG_LEVEL_VALUES[config.minLevel ?? "info"];
  }

  log(entry: LogEntry): void {
    // Check minimum level
    if (LOG_LEVEL_VALUES[entry.level] < this.minLevel) return;

    // Extract source from context (set by scoped loggers)
    let source: LogSource = "system";
    let sourceId: string | undefined;

    if (entry.context?.logSource) {
      const contextSource = entry.context.logSource as string;
      source = (SOURCE_TAG_MAP[contextSource] ?? "plugin") as LogSource;
      sourceId = entry.context.logSourceId as string | undefined;
    } else if (entry.tags && entry.tags.length > 0) {
      // Infer source from tags if no explicit context
      for (const tag of entry.tags) {
        const tagLower = tag.toLowerCase();
        if (SOURCE_TAG_MAP[tagLower]) {
          source = SOURCE_TAG_MAP[tagLower]!;
          break;
        }
      }
    }

    // Strip logSource/logSourceId from context before persisting
    let context = entry.context;
    if (context?.logSource || context?.logSourceId) {
      const { logSource, logSourceId, ...rest } = context;
      context = Object.keys(rest).length > 0 ? rest : undefined;
    }

    this.logs.write({
      level: entry.level,
      message: entry.message,
      source,
      sourceId,
      tags: entry.tags,
      data: entry.data,
      context,
    });
  }
}
