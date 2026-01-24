/**
 * Process Client
 *
 * Client library for managed processes to communicate back to the server.
 * Used inside wrapper scripts that are spawned by the Processes service.
 *
 * @example
 * ```ts
 * import { ProcessClient } from "@donkeylabs/server/process-client";
 *
 * const client = await ProcessClient.connect();
 *
 * // Access metadata passed during spawn
 * const { inputPath, outputPath } = client.metadata;
 *
 * // Emit typed events
 * client.emit("progress", { percent: 50, fps: 30 });
 *
 * // When done
 * client.emit("complete", { outputPath, duration: 123 });
 * client.disconnect();
 * ```
 */

import { createConnection, type Socket } from "node:net";

// ============================================
// Types
// ============================================

export interface ProcessClientConfig {
  /** Process ID (from DONKEYLABS_PROCESS_ID env var) */
  processId: string;
  /** Unix socket path (from DONKEYLABS_SOCKET_PATH env var) */
  socketPath?: string;
  /** TCP port for Windows (from DONKEYLABS_TCP_PORT env var) */
  tcpPort?: number;
  /** Metadata passed during spawn (from DONKEYLABS_METADATA env var) */
  metadata?: Record<string, any>;
  /** Heartbeat interval in ms (default: 5000) */
  heartbeatInterval?: number;
  /** Reconnect interval in ms (default: 2000) */
  reconnectInterval?: number;
  /** Max reconnection attempts (default: 30) */
  maxReconnectAttempts?: number;
}

export interface ProcessClient {
  /** Process ID */
  readonly processId: string;
  /** Metadata passed during spawn */
  readonly metadata: Record<string, any>;
  /** Whether currently connected */
  readonly connected: boolean;
  /** Emit a typed event to the server */
  emit(event: string, data?: Record<string, any>): Promise<boolean>;
  /** Disconnect from the server */
  disconnect(): void;
}

// ============================================
// Implementation
// ============================================

class ProcessClientImpl implements ProcessClient {
  readonly processId: string;
  readonly metadata: Record<string, any>;

  private socket: Socket | null = null;
  private socketPath?: string;
  private tcpPort?: number;
  private heartbeatInterval: number;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private isDisconnecting = false;
  private _connected = false;

  constructor(config: ProcessClientConfig) {
    this.processId = config.processId;
    this.metadata = config.metadata ?? {};
    this.socketPath = config.socketPath;
    this.tcpPort = config.tcpPort;
    this.heartbeatInterval = config.heartbeatInterval ?? 5000;
    this.reconnectInterval = config.reconnectInterval ?? 2000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 30;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this._connected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();

        // Send initial "connected" message
        this.sendMessage({ type: "connected" });

        console.log(`[ProcessClient] Connected to server (process: ${this.processId})`);
        resolve();
      };

      const onError = (err: Error) => {
        if (this.isDisconnecting) return;

        console.error(`[ProcessClient] Connection error: ${err.message}`);

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        } else {
          reject(new Error(`Failed to connect after ${this.maxReconnectAttempts} attempts`));
        }
      };

      const onClose = () => {
        this._connected = false;
        this.stopHeartbeat();

        if (!this.isDisconnecting && this.reconnectAttempts < this.maxReconnectAttempts) {
          console.log(`[ProcessClient] Connection closed, attempting reconnect...`);
          this.scheduleReconnect();
        }
      };

      this.createSocket(onConnect, onError, onClose);
    });
  }

  private createSocket(
    onConnect: () => void,
    onError: (err: Error) => void,
    onClose: () => void
  ): void {
    if (this.socketPath) {
      // Unix socket
      this.socket = createConnection(this.socketPath);
    } else if (this.tcpPort) {
      // TCP (Windows)
      this.socket = createConnection({ host: "127.0.0.1", port: this.tcpPort });
    } else {
      throw new Error("No socket path or TCP port configured");
    }

    this.socket.on("connect", onConnect);
    this.socket.on("error", onError);
    this.socket.on("close", onClose);

    // Handle incoming messages from server (optional)
    let buffer = "";
    this.socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          this.handleServerMessage(message);
        } catch {
          // Ignore malformed messages
        }
      }
    });
  }

  private handleServerMessage(message: any): void {
    // Server can send messages to the process (e.g., "stop", "config update")
    // For now, just log them
    console.log(`[ProcessClient] Received from server:`, message);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    console.log(
      `[ProcessClient] Reconnecting in ${this.reconnectInterval}ms ` +
        `(attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;

      if (this.isDisconnecting) return;

      // Clean up old socket
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.destroy();
        this.socket = null;
      }

      // Try to reconnect
      this.connect().catch(() => {
        // Error already logged, reconnect scheduled if attempts remain
      });
    }, this.reconnectInterval);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendMessage({ type: "heartbeat" });
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private sendMessage(message: { type: string; [key: string]: any }): boolean {
    if (!this.socket || this.socket.destroyed || !this._connected) {
      return false;
    }

    const fullMessage = {
      ...message,
      processId: this.processId,
      timestamp: Date.now(),
    };

    try {
      this.socket.write(JSON.stringify(fullMessage) + "\n");
      return true;
    } catch (err) {
      console.error(`[ProcessClient] Failed to send message:`, err);
      return false;
    }
  }

  async emit(event: string, data?: Record<string, any>): Promise<boolean> {
    return this.sendMessage({
      type: "event",
      event,
      data: data ?? {},
    });
  }

  disconnect(): void {
    this.isDisconnecting = true;
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.socket) {
      // Send disconnect message before closing
      this.sendMessage({ type: "disconnecting" });
      this.socket.end();
      this.socket = null;
    }

    this._connected = false;
    console.log(`[ProcessClient] Disconnected`);
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a ProcessClient from explicit config.
 */
export function createProcessClient(config: ProcessClientConfig): ProcessClient {
  return new ProcessClientImpl(config);
}

/**
 * Connect to the server using environment variables.
 * This is the recommended way to create a ProcessClient.
 *
 * Reads from:
 * - DONKEYLABS_PROCESS_ID (required)
 * - DONKEYLABS_SOCKET_PATH (Unix socket path)
 * - DONKEYLABS_TCP_PORT (TCP port for Windows)
 * - DONKEYLABS_METADATA (JSON-encoded metadata)
 *
 * @example
 * ```ts
 * const client = await ProcessClient.connect();
 * client.emit("progress", { percent: 50 });
 * ```
 */
export async function connect(options?: {
  heartbeatInterval?: number;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}): Promise<ProcessClient> {
  const processId = process.env.DONKEYLABS_PROCESS_ID;
  const socketPath = process.env.DONKEYLABS_SOCKET_PATH;
  const tcpPort = process.env.DONKEYLABS_TCP_PORT
    ? parseInt(process.env.DONKEYLABS_TCP_PORT, 10)
    : undefined;

  if (!processId) {
    throw new Error(
      "DONKEYLABS_PROCESS_ID environment variable not set. " +
        "This script should be spawned by the Processes service."
    );
  }

  if (!socketPath && !tcpPort) {
    throw new Error(
      "Neither DONKEYLABS_SOCKET_PATH nor DONKEYLABS_TCP_PORT is set. " +
        "This script should be spawned by the Processes service."
    );
  }

  // Parse metadata if provided
  let metadata: Record<string, any> = {};
  if (process.env.DONKEYLABS_METADATA) {
    try {
      metadata = JSON.parse(process.env.DONKEYLABS_METADATA);
    } catch {
      console.warn("[ProcessClient] Failed to parse DONKEYLABS_METADATA");
    }
  }

  const client = new ProcessClientImpl({
    processId,
    socketPath,
    tcpPort,
    metadata,
    ...options,
  });

  await client.connect();
  return client;
}

// Export as namespace for cleaner API
export const ProcessClient = {
  connect,
  create: createProcessClient,
};
