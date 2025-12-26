import type { ServerWebSocket } from "bun";
import type {
  LogEntry,
  StreamFilters,
  ClientMessage,
  ServerMessage,
  LogLevel,
} from "../shared/types";
import { ClientMessageSchema, LOG_LEVEL_PRIORITY } from "../shared/types";

// ============================================================================
// Types
// ============================================================================

export interface ConnectionData {
  connectionId: string;
  userId: number;
  connectedAt: number;
  filters: StreamFilters | null;
}

export interface WebSocketHubOptions {
  /** Maximum connections per user (default: 5) */
  maxConnectionsPerUser?: number;
  /** Rate limit: max messages per window (default: 100) */
  rateLimitMessages?: number;
  /** Rate limit window in milliseconds (default: 60000 = 1 minute) */
  rateLimitWindowMs?: number;
}

type AuditWebSocket = ServerWebSocket<ConnectionData>;

// ============================================================================
// WebSocket Hub
// ============================================================================

/** Default options for WebSocket hub */
const DEFAULT_OPTIONS: Required<WebSocketHubOptions> = {
  maxConnectionsPerUser: 5,
  rateLimitMessages: 100,
  rateLimitWindowMs: 60000,
};

export class WebSocketHub {
  private connections: Map<string, AuditWebSocket> = new Map();
  private userConnections: Map<number, Set<string>> = new Map();
  private messageRateLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private options: Required<WebSocketHubOptions>;

  constructor(options: WebSocketHubOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Generate unique connection ID
   */
  private generateConnectionId(): string {
    return `conn_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
  }

  /**
   * Send message to a specific connection
   */
  private send(ws: AuditWebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Connection might be closed
      this.handleClose(ws);
    }
  }

  /**
   * Check if a user has reached their connection limit
   */
  private hasReachedConnectionLimit(userId: number): boolean {
    const userConns = this.userConnections.get(userId);
    if (!userConns) return false;
    return userConns.size >= this.options.maxConnectionsPerUser;
  }

  /**
   * Check rate limit for a connection
   * @returns true if within rate limit, false if exceeded
   */
  private checkRateLimit(connectionId: string): boolean {
    const now = Date.now();
    const limit = this.messageRateLimits.get(connectionId);

    if (!limit || now >= limit.resetAt) {
      // New window or window expired
      this.messageRateLimits.set(connectionId, {
        count: 1,
        resetAt: now + this.options.rateLimitWindowMs,
      });
      return true;
    }

    if (limit.count >= this.options.rateLimitMessages) {
      return false; // Rate limit exceeded
    }

    limit.count++;
    return true;
  }

  /**
   * Handle new WebSocket connection
   * @returns true if connection was accepted, false if rejected
   */
  handleOpen(ws: AuditWebSocket): boolean {
    const userId = ws.data.userId;

    // Check connection limit per user
    if (userId && this.hasReachedConnectionLimit(userId)) {
      this.send(ws, {
        type: "error",
        message: `Connection limit exceeded. Maximum ${this.options.maxConnectionsPerUser} connections per user.`,
      });
      return false;
    }

    const connectionId = this.generateConnectionId();
    ws.data.connectionId = connectionId;
    ws.data.connectedAt = Date.now();
    ws.data.filters = null;

    this.connections.set(connectionId, ws);

    // Track user connections
    if (userId) {
      if (!this.userConnections.has(userId)) {
        this.userConnections.set(userId, new Set());
      }
      this.userConnections.get(userId)!.add(connectionId);
    }

    // Send connected message
    this.send(ws, { type: "connected", connectionId });
    return true;
  }

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(ws: AuditWebSocket, message: string | Buffer): void {
    // Check rate limit
    if (!this.checkRateLimit(ws.data.connectionId)) {
      this.send(ws, {
        type: "error",
        message: `Rate limit exceeded. Maximum ${this.options.rateLimitMessages} messages per ${Math.round(this.options.rateLimitWindowMs / 1000)} seconds.`,
      });
      return;
    }

    try {
      const msgString = typeof message === "string" ? message : message.toString();
      const parsed = JSON.parse(msgString);
      const result = ClientMessageSchema.safeParse(parsed);

      if (!result.success) {
        this.send(ws, { type: "error", message: "Invalid message format" });
        return;
      }

      const clientMessage: ClientMessage = result.data;

      switch (clientMessage.type) {
        case "subscribe":
          ws.data.filters = clientMessage.filters;
          this.send(ws, { type: "subscribed", filters: clientMessage.filters });
          break;

        case "unsubscribe":
          ws.data.filters = null;
          this.send(ws, { type: "subscribed", filters: {} });
          break;

        case "ping":
          this.send(ws, { type: "pong" });
          break;
      }
    } catch {
      this.send(ws, { type: "error", message: "Failed to parse message" });
    }
  }

  /**
   * Handle WebSocket connection close
   */
  handleClose(ws: AuditWebSocket): void {
    const connectionId = ws.data.connectionId;
    const userId = ws.data.userId;

    this.connections.delete(connectionId);
    this.messageRateLimits.delete(connectionId);

    // Remove from user connections
    if (userId) {
      const userConns = this.userConnections.get(userId);
      if (userConns) {
        userConns.delete(connectionId);
        if (userConns.size === 0) {
          this.userConnections.delete(userId);
        }
      }
    }
  }

  /**
   * Check if a log entry matches subscription filters
   */
  private matchesFilters(entry: LogEntry, filters: StreamFilters): boolean {
    // User filter
    if (filters.userId !== undefined && entry.userId !== filters.userId) {
      return false;
    }

    // Company filter
    if (filters.companyId !== undefined && entry.companyId !== filters.companyId) {
      return false;
    }

    // Level filters
    if (filters.levels && filters.levels.length > 0) {
      if (!filters.levels.includes(entry.level)) {
        return false;
      }
    }

    // Min level filter
    if (filters.minLevel) {
      const minPriority = LOG_LEVEL_PRIORITY[filters.minLevel];
      const entryPriority = LOG_LEVEL_PRIORITY[entry.level];
      if (entryPriority < minPriority) {
        return false;
      }
    }

    // Event patterns (glob-style matching)
    if (filters.events && filters.events.length > 0) {
      const matches = filters.events.some((pattern) => {
        if (pattern.endsWith("*")) {
          const prefix = pattern.slice(0, -1);
          return entry.event.startsWith(prefix);
        }
        if (pattern.startsWith("*")) {
          const suffix = pattern.slice(1);
          return entry.event.endsWith(suffix);
        }
        if (pattern.includes("*")) {
          // Convert glob to regex
          const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
          return regex.test(entry.event);
        }
        return entry.event === pattern;
      });
      if (!matches) {
        return false;
      }
    }

    return true;
  }

  /**
   * Broadcast a log entry to all matching subscribers
   */
  broadcast(entry: LogEntry): void {
    for (const [, ws] of this.connections) {
      const filters = ws.data.filters;

      // If no filters set, send all logs (admin watching everything)
      if (!filters || this.matchesFilters(entry, filters)) {
        this.send(ws, { type: "log", entry });
      }
    }
  }

  /**
   * Send a log entry to a specific user (all their connections)
   */
  sendToUser(userId: number, entry: LogEntry): void {
    const userConns = this.userConnections.get(userId);
    if (!userConns) return;

    for (const connectionId of userConns) {
      const ws = this.connections.get(connectionId);
      if (ws) {
        const filters = ws.data.filters;
        if (!filters || this.matchesFilters(entry, filters)) {
          this.send(ws, { type: "log", entry });
        }
      }
    }
  }

  /**
   * Get connection count statistics
   */
  getStats(): { totalConnections: number; uniqueUsers: number } {
    return {
      totalConnections: this.connections.size,
      uniqueUsers: this.userConnections.size,
    };
  }

  /**
   * Check if a user is currently connected
   */
  isUserConnected(userId: number): boolean {
    return this.userConnections.has(userId) && this.userConnections.get(userId)!.size > 0;
  }

  /**
   * Get all connection IDs for a user
   */
  getUserConnections(userId: number): string[] {
    const conns = this.userConnections.get(userId);
    return conns ? Array.from(conns) : [];
  }
}
