// Core Logger Service
// Structured logging with levels and child loggers

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
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
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // gray
  info: "\x1b[36m",  // cyan
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};

const RESET = "\x1b[0m";

// Console transport with pretty or JSON formatting
export class ConsoleTransport implements LogTransport {
  constructor(private format: "json" | "pretty" = "pretty") {}

  log(entry: LogEntry): void {
    if (this.format === "json") {
      console.log(JSON.stringify({
        timestamp: entry.timestamp.toISOString(),
        level: entry.level,
        message: entry.message,
        ...entry.data,
        ...entry.context,
      }));
    } else {
      const color = LEVEL_COLORS[entry.level];
      const time = entry.timestamp.toISOString().slice(11, 23);
      const level = entry.level.toUpperCase().padEnd(5);

      let output = `${color}[${time}] ${level}${RESET} ${entry.message}`;

      const extra = { ...entry.data, ...entry.context };
      if (Object.keys(extra).length > 0) {
        output += ` ${"\x1b[90m"}${JSON.stringify(extra)}${RESET}`;
      }

      console.log(output);
    }
  }
}

class LoggerImpl implements Logger {
  private minLevel: number;
  private transports: LogTransport[];
  private context: Record<string, any>;

  constructor(config: LoggerConfig = {}, context: Record<string, any> = {}) {
    this.minLevel = LOG_LEVELS[config.level ?? "info"];
    this.transports = config.transports ?? [new ConsoleTransport(config.format ?? "pretty")];
    this.context = context;
  }

  private log(level: LogLevel, message: string, data?: Record<string, any>): void {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
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
    return new LoggerImpl(
      { level: Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k as LogLevel] === this.minLevel) as LogLevel, transports: this.transports },
      { ...this.context, ...context }
    );
  }
}

export function createLogger(config?: LoggerConfig): Logger {
  return new LoggerImpl(config);
}
