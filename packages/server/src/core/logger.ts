// Core Logger Service
// Structured logging with levels, tags, and child loggers

import pc from "picocolors";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  tags?: string[];
  data?: Record<string, any>;
  context?: Record<string, any>;
}

export interface LogTransport {
  log(entry: LogEntry): void;
}

export interface LoggerConfig {
  level?: LogLevel;
  transports?: LogTransport[];
  format?: "json" | "pretty";
}

export interface Logger {
  debug(message: string, data?: Record<string, any>): void;
  info(message: string, data?: Record<string, any>): void;
  warn(message: string, data?: Record<string, any>): void;
  error(message: string, data?: Record<string, any>): void;
  child(context: Record<string, any>): Logger;
  /** Create a tagged child logger with colored prefix */
  tag(name: string): Logger;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Tag color palette - cycles through these for auto-assigned colors
const TAG_COLORS: ((s: string) => string)[] = [
  pc.cyan,
  pc.magenta,
  pc.green,
  pc.yellow,
  pc.blue,
  pc.red,
];

// Cache for consistent tag colors across the app
const tagColorCache = new Map<string, (s: string) => string>();
let colorIndex = 0;

/**
 * Get a consistent color for a tag name.
 * Same tag always gets the same color within a process.
 */
function getTagColor(tag: string): (s: string) => string {
  if (!tagColorCache.has(tag)) {
    tagColorCache.set(tag, TAG_COLORS[colorIndex % TAG_COLORS.length]!);
    colorIndex++;
  }
  return tagColorCache.get(tag)!;
}

// Level colors using picocolors
const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: pc.gray,
  info: pc.blue,
  warn: pc.yellow,
  error: pc.red,
};

// Console transport with pretty or JSON formatting
export class ConsoleTransport implements LogTransport {
  constructor(private format: "json" | "pretty" = "pretty") {}

  log(entry: LogEntry): void {
    if (this.format === "json") {
      console.log(JSON.stringify({
        timestamp: entry.timestamp.toISOString(),
        level: entry.level,
        message: entry.message,
        tags: entry.tags,
        ...entry.data,
        ...entry.context,
      }));
    } else {
      const levelColor = LEVEL_COLORS[entry.level];
      const time = pc.dim(entry.timestamp.toISOString().slice(11, 23));
      const level = levelColor(entry.level.toUpperCase().padEnd(5));

      // Build tag prefix with colors
      let tagPrefix = "";
      if (entry.tags && entry.tags.length > 0) {
        const tagParts = entry.tags.map(tag => {
          const colorFn = getTagColor(tag);
          return colorFn(`[${tag}]`);
        });
        tagPrefix = tagParts.join(" ") + " ";
      }

      let output = `${time} ${level} ${tagPrefix}${entry.message}`;

      const extra = { ...entry.data, ...entry.context };
      if (Object.keys(extra).length > 0) {
        output += ` ${pc.dim(JSON.stringify(extra))}`;
      }

      console.log(output);
    }
  }
}

class LoggerImpl implements Logger {
  private minLevel: number;
  private transports: LogTransport[];
  private context: Record<string, any>;
  private tags: string[];

  constructor(
    config: LoggerConfig = {},
    context: Record<string, any> = {},
    tags: string[] = []
  ) {
    this.minLevel = LOG_LEVELS[config.level ?? "info"];
    this.transports = config.transports ?? [new ConsoleTransport(config.format ?? "pretty")];
    this.context = context;
    this.tags = tags;
  }

  private log(level: LogLevel, message: string, data?: Record<string, any>): void {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      tags: this.tags.length > 0 ? this.tags : undefined,
      data,
      context: Object.keys(this.context).length > 0 ? this.context : undefined,
    };

    for (const transport of this.transports) {
      transport.log(entry);
    }
  }

  debug(message: string, data?: Record<string, any>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, any>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, any>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, any>): void {
    this.log("error", message, data);
  }

  child(context: Record<string, any>): Logger {
    const levelKey = Object.keys(LOG_LEVELS).find(
      k => LOG_LEVELS[k as LogLevel] === this.minLevel
    ) as LogLevel;
    return new LoggerImpl(
      { level: levelKey, transports: this.transports },
      { ...this.context, ...context },
      [...this.tags]
    );
  }

  tag(name: string): Logger {
    const levelKey = Object.keys(LOG_LEVELS).find(
      k => LOG_LEVELS[k as LogLevel] === this.minLevel
    ) as LogLevel;
    return new LoggerImpl(
      { level: levelKey, transports: this.transports },
      { ...this.context },
      [...this.tags, name]
    );
  }
}

export function createLogger(config?: LoggerConfig): Logger {
  return new LoggerImpl(config);
}
