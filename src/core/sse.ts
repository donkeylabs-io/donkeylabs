// Core SSE Service
// Server-Sent Events for server→client push

export interface SSEClient {
  id: string;
  channels: Set<string>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  createdAt: Date;
  lastEventId?: string;
}

export interface SSEConfig {
  heartbeatInterval?: number; // ms, default 30000 (30s)
  retryInterval?: number; // ms suggested to client, default 3000
}

export interface SSE {
  addClient(options?: { lastEventId?: string }): { client: SSEClient; response: Response };
  removeClient(clientId: string): void;
  getClient(clientId: string): SSEClient | undefined;
  subscribe(clientId: string, channel: string): boolean;
  unsubscribe(clientId: string, channel: string): boolean;
  broadcast(channel: string, event: string, data: any, id?: string): void;
  broadcastAll(event: string, data: any, id?: string): void;
  sendTo(clientId: string, event: string, data: any, id?: string): boolean;
  getClients(): SSEClient[];
  getClientsByChannel(channel: string): SSEClient[];
  shutdown(): void;
}

class SSEImpl implements SSE {
  private clients = new Map<string, SSEClient>();
  private heartbeatInterval: number;
  private retryInterval: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private clientCounter = 0;
  private encoder = new TextEncoder();

  constructor(config: SSEConfig = {}) {
    this.heartbeatInterval = config.heartbeatInterval ?? 30000;
    this.retryInterval = config.retryInterval ?? 3000;

    // Start heartbeat to keep connections alive
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatInterval);
  }

  addClient(options: { lastEventId?: string } = {}): { client: SSEClient; response: Response } {
    const id = `sse_${++this.clientCounter}_${Date.now()}`;

    let clientController: ReadableStreamDefaultController<Uint8Array>;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        clientController = controller;

        // Send retry interval to client
        const retryMsg = `retry: ${this.retryInterval}\n\n`;
        controller.enqueue(this.encoder.encode(retryMsg));
      },
      cancel: () => {
        this.removeClient(id);
      },
    });

    const client: SSEClient = {
      id,
      channels: new Set(),
      controller: clientController!,
      createdAt: new Date(),
      lastEventId: options.lastEventId,
    };

    this.clients.set(id, client);

    const response = new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-SSE-Client-Id": id,
      },
    });

    return { client, response };
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        client.controller.close();
      } catch {
        // Controller may already be closed
      }
      this.clients.delete(clientId);
    }
  }

  getClient(clientId: string): SSEClient | undefined {
    return this.clients.get(clientId);
  }

  subscribe(clientId: string, channel: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.channels.add(channel);
    return true;
  }

  unsubscribe(clientId: string, channel: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    return client.channels.delete(channel);
  }

  broadcast(channel: string, event: string, data: any, id?: string): void {
    for (const client of this.clients.values()) {
      if (client.channels.has(channel)) {
        this.sendEvent(client, event, data, id);
      }
    }
  }

  broadcastAll(event: string, data: any, id?: string): void {
    for (const client of this.clients.values()) {
      this.sendEvent(client, event, data, id);
    }
  }

  sendTo(clientId: string, event: string, data: any, id?: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    return this.sendEvent(client, event, data, id);
  }

  getClients(): SSEClient[] {
    return Array.from(this.clients.values());
  }

  getClientsByChannel(channel: string): SSEClient[] {
    return Array.from(this.clients.values()).filter(c => c.channels.has(channel));
  }

  shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      try {
        client.controller.close();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.clients.clear();
  }

  private sendEvent(client: SSEClient, event: string, data: any, id?: string): boolean {
    try {
      let message = "";

      if (id) {
        message += `id: ${id}\n`;
      }

      message += `event: ${event}\n`;

      // Handle data - serialize if object
      const dataStr = typeof data === "string" ? data : JSON.stringify(data);

      // Split data by newlines for proper SSE format
      for (const line of dataStr.split("\n")) {
        message += `data: ${line}\n`;
      }

      message += "\n"; // End of message

      client.controller.enqueue(this.encoder.encode(message));
      return true;
    } catch {
      // Client may be disconnected
      this.removeClient(client.id);
      return false;
    }
  }

  private sendHeartbeat(): void {
    // Send comment as heartbeat to keep connections alive
    const heartbeat = `: heartbeat ${Date.now()}\n\n`;
    const encoded = this.encoder.encode(heartbeat);

    for (const client of this.clients.values()) {
      try {
        client.controller.enqueue(encoded);
      } catch {
        // Client disconnected
        this.removeClient(client.id);
      }
    }
  }
}

export function createSSE(config?: SSEConfig): SSE {
  return new SSEImpl(config);
}
