/**
 * WebSocket Core Service
 *
 * Provides bidirectional real-time communication using Bun's native WebSocket support.
 * This is an in-memory service (no persistence needed) for high-frequency messaging.
 */

import type { ServerWebSocket } from "bun";

// ============================================
// Types
// ============================================

export interface WebSocketClient {
  id: string;
  socket: ServerWebSocket<WebSocketData>;
  channels: Set<string>;
  metadata?: Record<string, any>;
  connectedAt: Date;
  lastMessageAt?: Date;
}

export interface WebSocketData {
  clientId: string;
}

export interface WebSocketMessage {
  event: string;
  data: any;
  channel?: string;
}

export type WebSocketMessageHandler = (
  clientId: string,
  event: string,
  data: any
) => void | Promise<void>;

// ============================================
// Service Interface
// ============================================

export interface WebSocketService {
  /** Broadcast a message to all clients in a channel */
  broadcast(channel: string, event: string, data: any): void;
  /** Broadcast a message to all connected clients */
  broadcastAll(event: string, data: any): void;
  /** Send a message to a specific client */
  send(clientId: string, event: string, data: any): boolean;
  /** Subscribe a client to a channel */
  subscribe(clientId: string, channel: string): boolean;
  /** Unsubscribe a client from a channel */
  unsubscribe(clientId: string, channel: string): boolean;
  /** Register a message handler */
  onMessage(handler: WebSocketMessageHandler): void;
  /** Get all client IDs in a channel (or all if no channel) */
  getClientIds(channel?: string): string[];
  /** Get all clients with metadata (for admin dashboard) */
  getClients(): Array<{ id: string; connectedAt: Date; channels: string[] }>;
  /** Get client count */
  getClientCount(channel?: string): number;
  /** Check if a client is connected */
  isConnected(clientId: string): boolean;
  /** Get client metadata */
  getClientMetadata(clientId: string): Record<string, any> | undefined;
  /** Set client metadata */
  setClientMetadata(clientId: string, metadata: Record<string, any>): boolean;
  /** Handle an incoming WebSocket connection (for server integration) */
  handleUpgrade(
    clientId: string,
    socket: ServerWebSocket<WebSocketData>,
    metadata?: Record<string, any>
  ): void;
  /** Handle a client disconnection */
  handleClose(clientId: string): void;
  /** Handle an incoming message */
  handleMessage(clientId: string, message: string | Buffer): void;
  /** Close all connections and cleanup */
  shutdown(): void;
}

// ============================================
// Configuration
// ============================================

export interface WebSocketConfig {
  /** Maximum clients per channel (default: unlimited) */
  maxClientsPerChannel?: number;
  /** Ping interval in ms to keep connections alive (default: 30000) */
  pingInterval?: number;
  /** Maximum message size in bytes (default: 1MB) */
  maxMessageSize?: number;
}

// ============================================
// Implementation
// ============================================

class WebSocketServiceImpl implements WebSocketService {
  private clients = new Map<string, WebSocketClient>();
  private channels = new Map<string, Set<string>>(); // channel -> Set<clientId>
  private messageHandlers: WebSocketMessageHandler[] = [];
  private pingTimer?: ReturnType<typeof setInterval>;
  private maxClientsPerChannel: number;
  private pingInterval: number;
  private maxMessageSize: number;

  constructor(config: WebSocketConfig = {}) {
    this.maxClientsPerChannel = config.maxClientsPerChannel ?? Infinity;
    this.pingInterval = config.pingInterval ?? 30000;
    this.maxMessageSize = config.maxMessageSize ?? 1024 * 1024; // 1MB

    // Start ping timer
    this.startPingTimer();
  }

  broadcast(channel: string, event: string, data: any): void {
    const channelClients = this.channels.get(channel);
    if (!channelClients) return;

    const message = JSON.stringify({ event, data, channel });

    for (const clientId of channelClients) {
      const client = this.clients.get(clientId);
      if (client) {
        try {
          client.socket.send(message);
        } catch {
          // Client may have disconnected
        }
      }
    }
  }

  broadcastAll(event: string, data: any): void {
    const message = JSON.stringify({ event, data });

    for (const client of this.clients.values()) {
      try {
        client.socket.send(message);
      } catch {
        // Client may have disconnected
      }
    }
  }

  send(clientId: string, event: string, data: any): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    try {
      client.socket.send(JSON.stringify({ event, data }));
      return true;
    } catch {
      return false;
    }
  }

  subscribe(clientId: string, channel: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    // Check max clients per channel
    let channelClients = this.channels.get(channel);
    if (!channelClients) {
      channelClients = new Set();
      this.channels.set(channel, channelClients);
    }

    if (channelClients.size >= this.maxClientsPerChannel) {
      return false;
    }

    channelClients.add(clientId);
    client.channels.add(channel);
    return true;
  }

  unsubscribe(clientId: string, channel: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    client.channels.delete(channel);

    const channelClients = this.channels.get(channel);
    if (channelClients) {
      channelClients.delete(clientId);
      if (channelClients.size === 0) {
        this.channels.delete(channel);
      }
    }

    return true;
  }

  onMessage(handler: WebSocketMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  getClientIds(channel?: string): string[] {
    if (channel) {
      const channelClients = this.channels.get(channel);
      return channelClients ? Array.from(channelClients) : [];
    }
    return Array.from(this.clients.keys());
  }

  getClients(): Array<{ id: string; connectedAt: Date; channels: string[] }> {
    return Array.from(this.clients.values()).map((client) => ({
      id: client.id,
      connectedAt: client.connectedAt,
      channels: Array.from(client.channels),
    }));
  }

  getClientCount(channel?: string): number {
    if (channel) {
      return this.channels.get(channel)?.size ?? 0;
    }
    return this.clients.size;
  }

  isConnected(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  getClientMetadata(clientId: string): Record<string, any> | undefined {
    return this.clients.get(clientId)?.metadata;
  }

  setClientMetadata(clientId: string, metadata: Record<string, any>): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.metadata = { ...client.metadata, ...metadata };
    return true;
  }

  handleUpgrade(
    clientId: string,
    socket: ServerWebSocket<WebSocketData>,
    metadata?: Record<string, any>
  ): void {
    const client: WebSocketClient = {
      id: clientId,
      socket,
      channels: new Set(),
      metadata,
      connectedAt: new Date(),
    };

    this.clients.set(clientId, client);
    console.log(`[WebSocket] Client connected: ${clientId}`);
  }

  handleClose(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove from all channels
    for (const channel of client.channels) {
      const channelClients = this.channels.get(channel);
      if (channelClients) {
        channelClients.delete(clientId);
        if (channelClients.size === 0) {
          this.channels.delete(channel);
        }
      }
    }

    this.clients.delete(clientId);
    console.log(`[WebSocket] Client disconnected: ${clientId}`);
  }

  handleMessage(clientId: string, message: string | Buffer): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.lastMessageAt = new Date();

    // Check message size
    const messageStr = typeof message === "string" ? message : message.toString();
    if (messageStr.length > this.maxMessageSize) {
      console.warn(`[WebSocket] Message too large from ${clientId}`);
      return;
    }

    try {
      const parsed = JSON.parse(messageStr) as WebSocketMessage;
      const { event, data } = parsed;

      // Handle built-in events
      if (event === "subscribe" && data?.channel) {
        this.subscribe(clientId, data.channel);
        return;
      }
      if (event === "unsubscribe" && data?.channel) {
        this.unsubscribe(clientId, data.channel);
        return;
      }
      if (event === "ping") {
        this.send(clientId, "pong", { timestamp: Date.now() });
        return;
      }

      // Call registered handlers
      for (const handler of this.messageHandlers) {
        try {
          handler(clientId, event, data);
        } catch (err) {
          console.error(`[WebSocket] Message handler error:`, err);
        }
      }
    } catch {
      console.warn(`[WebSocket] Invalid message from ${clientId}`);
    }
  }

  shutdown(): void {
    // Stop ping timer
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    // Close all connections
    for (const client of this.clients.values()) {
      try {
        client.socket.close(1000, "Server shutting down");
      } catch {
        // Already closed
      }
    }

    this.clients.clear();
    this.channels.clear();
    this.messageHandlers = [];

    console.log("[WebSocket] Service shutdown complete");
  }

  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      const now = Date.now();

      for (const client of this.clients.values()) {
        try {
          client.socket.send(JSON.stringify({ event: "ping", data: { timestamp: now } }));
        } catch {
          // Client may have disconnected
        }
      }
    }, this.pingInterval);
  }
}

// ============================================
// Factory Function
// ============================================

export function createWebSocket(config?: WebSocketConfig): WebSocketService {
  return new WebSocketServiceImpl(config);
}
