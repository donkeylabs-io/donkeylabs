import type {
  LogEntry,
  StreamFilters,
  ConnectionState,
  ServerMessage,
  ClientMessage,
} from "../shared/types";

// ============================================================================
// Types
// ============================================================================

export interface AuditLogClientOptions {
  wsUrl: string;
  reconnectMaxAttempts?: number;
  reconnectBaseDelay?: number;
  pingInterval?: number;
}

// ============================================================================
// AuditLogClient - Browser WebSocket Client
// ============================================================================

export class AuditLogClient {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private readonly wsUrl: string;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelay: number;
  private readonly pingInterval: number;

  public connectionId: string | null = null;
  public currentFilters: StreamFilters = {};

  // Event handlers
  public onLog: (entry: LogEntry) => void = () => {};
  public onConnectionChange: (state: ConnectionState) => void = () => {};
  public onError: (error: string) => void = () => {};

  constructor(options: AuditLogClientOptions) {
    this.wsUrl = options.wsUrl;
    this.maxReconnectAttempts = options.reconnectMaxAttempts ?? 10;
    this.reconnectBaseDelay = options.reconnectBaseDelay ?? 1000;
    this.pingInterval = options.pingInterval ?? 30000;
  }

  /**
   * Connect to the WebSocket server
   */
  connect(token: string): void {
    this.token = token;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  /**
   * Internal connection logic
   */
  private doConnect(): void {
    if (!this.token) return;

    this.onConnectionChange("connecting");

    // Clean up existing connection
    this.cleanup();

    // Build URL with token
    const url = new URL(this.wsUrl);
    url.searchParams.set("token", this.token);

    try {
      this.ws = new WebSocket(url.toString());

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.onConnectionChange("connected");
        this.startPing();

        // Resubscribe with current filters if any
        if (Object.keys(this.currentFilters).length > 0) {
          this.subscribe(this.currentFilters);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const message: ServerMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch {
          // Ignore invalid messages
        }
      };

      this.ws.onclose = () => {
        this.cleanup();
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // Error will be followed by close event
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  /**
   * Handle incoming server message
   */
  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "connected":
        this.connectionId = message.connectionId;
        break;

      case "log":
        this.onLog(message.entry);
        break;

      case "subscribed":
        this.currentFilters = message.filters;
        break;

      case "error":
        this.onError(message.message);
        break;

      case "pong":
        // Heartbeat acknowledged
        break;
    }
  }

  /**
   * Subscribe to log events with filters
   */
  subscribe(filters: StreamFilters): void {
    this.currentFilters = filters;
    this.send({ type: "subscribe", filters });
  }

  /**
   * Unsubscribe from log events
   */
  unsubscribe(): void {
    this.currentFilters = {};
    this.send({ type: "unsubscribe" });
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    this.token = null;
    this.cleanup();
    this.onConnectionChange("disconnected");
  }

  /**
   * Send a message to the server
   */
  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Start ping interval
   */
  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping" });
    }, this.pingInterval);
  }

  /**
   * Stop ping interval
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (!this.token) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.onConnectionChange("disconnected");
      this.onError("Max reconnection attempts reached");
      return;
    }

    this.onConnectionChange("reconnecting");

    // Exponential backoff with jitter
    const delay =
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts) +
      Math.random() * 1000;

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    this.stopPing();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }

      this.ws = null;
    }

    this.connectionId = null;
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get current connection state
   */
  get state(): ConnectionState {
    if (!this.ws) return "disconnected";
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return "connecting";
      case WebSocket.OPEN:
        return "connected";
      default:
        return "disconnected";
    }
  }
}
