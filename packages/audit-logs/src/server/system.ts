import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { FileMigrationProvider, Migrator } from "kysely";
import * as path from "path";
import * as fs from "fs";

import type { AuditLogDB } from "./db";
import type {
  AuditLogSystemOptions,
  RetentionConfig,
  MiddlewareOptions,
  LogEntryInput,
  LogEntry,
} from "../shared/types";
import { DEFAULT_RETENTION } from "../shared/types";
import { AuditLogService } from "./service";
import { WebSocketHub, type ConnectionData } from "./hub";
import { Redactor } from "./redactor";
import { createAuditMiddleware, createRequestLogger } from "./middleware";
import { Logger } from "../logger";
import type { RequestHandler } from "express";
import type { ServerWebSocket } from "bun";
import jwt from "jsonwebtoken";

// ============================================================================
// AuditLogSystem - Main Orchestrator
// ============================================================================

/** Minimum JWT secret length for security (32 bytes = 256 bits) */
const MIN_JWT_SECRET_LENGTH = 32;

export class AuditLogSystem {
  public db: Kysely<AuditLogDB>;
  public service: AuditLogService;
  public hub: WebSocketHub;
  public requestLogger: ReturnType<typeof createRequestLogger>;

  private redactor: Redactor;
  private retention: RetentionConfig;
  private jwtSecret: string | undefined;
  private initialized: boolean = false;

  constructor(private options: AuditLogSystemOptions) {
    this.retention = options.retention ?? DEFAULT_RETENTION;
    this.jwtSecret = options.jwtSecret;

    // Validate JWT secret if provided
    if (this.jwtSecret !== undefined) {
      if (this.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
        console.warn(
          `[AuditLogs] JWT secret is too short (${this.jwtSecret.length} chars). ` +
          `Minimum recommended length is ${MIN_JWT_SECRET_LENGTH} characters for security.`
        );
      }
    }

    // Create redactor
    this.redactor = new Redactor(options.redactionPatterns);

    // Create database connection
    const sqlite = new Database(options.dbFile);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA synchronous = NORMAL");
    sqlite.exec("PRAGMA cache_size = 10000");

    this.db = new Kysely<AuditLogDB>({
      dialect: new BunSqliteDialect({ database: sqlite }),
    });

    // Create WebSocket hub with rate limiting and connection limits
    this.hub = new WebSocketHub(options.websocket);

    // Create service with callback to broadcast new logs
    this.service = new AuditLogService(this.db, this.redactor, this.retention, (entry) => {
      this.hub.broadcast(entry);
    });

    // Create request logger helper
    this.requestLogger = createRequestLogger(this.service);
  }

  /**
   * Initialize the system (run migrations if needed)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.options.runMigrations !== false) {
      await this.runMigrations();
    }

    this.initialized = true;
  }

  /**
   * Run database migrations
   */
  private async runMigrations(): Promise<void> {
    const migrationFolder = path.join(import.meta.dir, "migrations");

    // Check if migrations folder exists
    if (!fs.existsSync(migrationFolder)) {
      console.warn(`[AuditLogs] Migrations folder not found: ${migrationFolder}`);
      return;
    }

    const migrator = new Migrator({
      db: this.db,
      provider: new FileMigrationProvider({
        fs: {
          readdir: (p) => fs.promises.readdir(p),
        },
        path: {
          join: (...args) => path.join(...args),
        },
        migrationFolder,
      }),
    });

    const { error, results } = await migrator.migrateToLatest();

    if (results) {
      for (const result of results) {
        if (result.status === "Success") {
          console.log(`[AuditLogs] Migration "${result.migrationName}" executed successfully`);
        } else if (result.status === "Error") {
          console.error(`[AuditLogs] Migration "${result.migrationName}" failed`);
        }
      }
    }

    if (error) {
      console.error("[AuditLogs] Migration failed:", error);
      throw error;
    }
  }

  /**
   * Create Express middleware for automatic request logging
   */
  middleware(options?: MiddlewareOptions): RequestHandler {
    return createAuditMiddleware(this.service, options);
  }

  /**
   * Log an entry directly
   */
  async log(input: LogEntryInput): Promise<string> {
    return this.service.log(input);
  }

  /**
   * Cleanup old logs based on retention policy
   */
  async cleanup(): Promise<{ deleted: number; byLevel: Record<string, number> }> {
    return this.service.cleanupOldLogs();
  }

  /**
   * Get current retention configuration (in months)
   */
  async getRetention(): Promise<RetentionConfig> {
    return this.service.getRetention();
  }

  /**
   * Update retention configuration (in months)
   */
  async setRetention(config: RetentionConfig): Promise<RetentionConfig> {
    return this.service.setRetention(config);
  }

  /**
   * Create a new Logger instance connected to this audit system
   *
   * @example
   * ```ts
   * const auditSystem = new AuditLogSystem({ dbFile: './audit.db' });
   * await auditSystem.initialize();
   *
   * // Create loggers that persist to audit
   * const serverLog = auditSystem.createLogger("Server");
   * const dbLog = auditSystem.createLogger("DB");
   *
   * serverLog.info("Server started"); // Console + audit DB
   * dbLog.warn("Slow query detected"); // Console + audit DB
   * ```
   */
  createLogger(prefix: string): Logger {
    return new Logger(prefix, { auditService: this.service });
  }


  /**
   * WebSocket handlers for Bun.serve
   */
  get websocketHandlers() {
    return {
      open: (ws: ServerWebSocket<ConnectionData>) => {
        this.hub.handleOpen(ws);
      },
      message: (ws: ServerWebSocket<ConnectionData>, message: string | Buffer) => {
        this.hub.handleMessage(ws, message);
      },
      close: (ws: ServerWebSocket<ConnectionData>) => {
        this.hub.handleClose(ws);
      },
    };
  }

  /**
   * Verify JWT token and extract user info for WebSocket upgrade
   */
  verifyToken(token: string): { userId: number; permissions?: string[] } | null {
    if (!this.jwtSecret) {
      console.warn("[AuditLogs] JWT secret not configured");
      return null;
    }

    try {
      const decoded = jwt.verify(token, this.jwtSecret) as {
        userId: number;
        permissions?: string[];
      };
      return decoded;
    } catch {
      return null;
    }
  }

  /**
   * Handle WebSocket upgrade request (for use with Bun.serve)
   *
   * Usage:
   * ```
   * Bun.serve({
   *   fetch(req, server) {
   *     if (url.pathname === "/ws/audit-logs") {
   *       return auditLogs.handleUpgrade(req, server);
   *     }
   *   },
   *   websocket: auditLogs.websocketHandlers,
   * });
   * ```
   */
  handleUpgrade(
    req: Request,
    server: {
      upgrade: (
        req: Request,
        options?: { data?: ConnectionData }
      ) => boolean;
    }
  ): Response | undefined {
    // Extract token from query string or header
    const url = new URL(req.url);
    const token =
      url.searchParams.get("token") ??
      req.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      return new Response("Unauthorized: No token provided", { status: 401 });
    }

    // Verify token
    const decoded = this.verifyToken(token);
    if (!decoded) {
      return new Response("Unauthorized: Invalid token", { status: 401 });
    }

    // Check for audit:read or admin:read permission if permissions are present
    if (decoded.permissions) {
      const hasPermission =
        decoded.permissions.includes("audit:read") ||
        decoded.permissions.includes("admin:read");
      if (!hasPermission) {
        return new Response("Forbidden: Missing audit:read or admin:read permission", { status: 403 });
      }
    }

    // Upgrade connection
    const upgraded = server.upgrade(req, {
      data: {
        connectionId: "",
        userId: decoded.userId,
        connectedAt: 0,
        filters: null,
      } satisfies ConnectionData,
    });

    if (upgraded) {
      return undefined; // Upgrade successful
    }

    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  /**
   * Get system statistics
   */
  async getStats(): Promise<{
    connections: { totalConnections: number; uniqueUsers: number };
    logs: { total: number; last24h: number };
  }> {
    const connectionStats = this.hub.getStats();

    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;

    const totalResult = await this.db
      .selectFrom("log_entry")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();

    const last24hResult = await this.db
      .selectFrom("log_entry")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("timestamp", ">=", last24h)
      .executeTakeFirst();

    return {
      connections: connectionStats,
      logs: {
        total: totalResult?.count ?? 0,
        last24h: last24hResult?.count ?? 0,
      },
    };
  }

  /**
   * Gracefully shutdown the system
   */
  async shutdown(): Promise<void> {
    await this.db.destroy();
  }
}
