// Workflow Socket Server
// Handles bidirectional communication with isolated workflow processes via Unix sockets (or TCP on Windows)

import { mkdir, rm, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server as NetServer, Socket } from "node:net";
import { createServer as createNetServer } from "node:net";

// ============================================
// Message Protocol Types
// ============================================

import type { LogLevel } from "./logger";

export type WorkflowEventType =
  | "ready"
  | "started"
  | "heartbeat"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "step.poll"
  | "step.loop"
  | "progress"
  | "completed"
  | "failed"
  | "event"
  | "log";

export interface WorkflowEvent {
  type: WorkflowEventType;
  instanceId: string;
  workflowName?: string;
  timestamp: number;
  stepName?: string;
  /** Step type (for step.started events) */
  stepType?: string;
  output?: any;
  error?: string;
  progress?: number;
  completedSteps?: number;
  totalSteps?: number;
  /** Next step to execute (for step.completed events) */
  nextStep?: string;
  pollCount?: number;
  done?: boolean;
  result?: any;
  loopCount?: number;
  target?: string;
  /** Custom event name (for event type) */
  event?: string;
  /** Custom event payload or log data */
  data?: Record<string, any>;
  /** Log level (for log type) */
  level?: LogLevel;
  /** Log message (for log type) */
  message?: string;
}

export interface ProxyRequest {
  type: "proxy.call";
  requestId: string;
  target: "plugin" | "core";
  service: string;
  method: string;
  args: any[];
}

export interface ProxyResponse {
  type: "proxy.result" | "proxy.error";
  requestId: string;
  result?: any;
  error?: string;
}

export type WorkflowMessage = WorkflowEvent | ProxyRequest;

// ============================================
// Socket Server Types
// ============================================

export interface WorkflowSocketServerOptions {
  /** Directory for Unix sockets */
  socketDir: string;
  /** TCP port range for Windows fallback */
  tcpPortRange: [number, number];
  /** Callback when a workflow event is received */
  onEvent: (event: WorkflowEvent) => void | Promise<void>;
  /** Callback when a proxy call is received (returns result or throws) */
  onProxyCall: (request: ProxyRequest) => Promise<any>;
  /** Callback when a connection is established */
  onConnect?: (instanceId: string) => void;
  /** Callback when a connection is closed */
  onDisconnect?: (instanceId: string) => void;
  /** Callback for errors */
  onError?: (error: Error, instanceId?: string) => void;
}

export interface WorkflowSocketServer {
  /** Create a new socket for a workflow instance (returns socket path or TCP port) */
  createSocket(instanceId: string): Promise<{ socketPath?: string; tcpPort?: number }>;
  /** Close a specific workflow's socket and release reservations */
  closeSocket(instanceId: string): Promise<void>;
  /** Get all active workflow connections */
  getActiveConnections(): string[];
  /** Send a response to a proxy request */
  sendProxyResponse(instanceId: string, response: ProxyResponse): boolean;
  /** Shutdown all sockets and cleanup */
  shutdown(): Promise<void>;
  /** Clean orphaned socket files from a previous run */
  cleanOrphanedSockets(activeInstanceIds: Set<string>): Promise<void>;
}

// ============================================
// Implementation
// ============================================

export class WorkflowSocketServerImpl implements WorkflowSocketServer {
  private socketDir: string;
  private tcpPortRange: [number, number];
  private onEvent: (event: WorkflowEvent) => void | Promise<void>;
  private onProxyCall: (request: ProxyRequest) => Promise<any>;
  private onConnect?: (instanceId: string) => void;
  private onDisconnect?: (instanceId: string) => void;
  private onError?: (error: Error, instanceId?: string) => void;

  // Map of instanceId -> server instance
  private servers = new Map<string, NetServer>();
  // Map of instanceId -> active client socket
  private clientSockets = new Map<string, Socket>();
  // Map of instanceId -> socket path
  private socketPaths = new Map<string, string>();
  // Map of instanceId -> TCP port
  private tcpPorts = new Map<string, number>();
  // Track used TCP ports
  private usedPorts = new Set<number>();

  private isWindows = process.platform === "win32";

  constructor(options: WorkflowSocketServerOptions) {
    this.socketDir = options.socketDir;
    this.tcpPortRange = options.tcpPortRange;
    this.onEvent = options.onEvent;
    this.onProxyCall = options.onProxyCall;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.onError = options.onError;
  }

  async createSocket(instanceId: string): Promise<{ socketPath?: string; tcpPort?: number }> {
    // Ensure socket directory exists (only for Unix)
    if (!this.isWindows) {
      await mkdir(this.socketDir, { recursive: true });
    }

    if (this.isWindows) {
      return this.createTcpServer(instanceId);
    } else {
      return this.createUnixServer(instanceId);
    }
  }

  private async createUnixServer(instanceId: string): Promise<{ socketPath: string }> {
    const socketPath = join(this.socketDir, `workflow_${instanceId}.sock`);

    // Remove existing socket file if it exists
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }

    return new Promise((resolve, reject) => {
      const server = createNetServer((socket) => {
        this.handleConnection(instanceId, socket);
      });

      server.on("error", (err) => {
        this.onError?.(err, instanceId);
        reject(err);
      });

      server.listen(socketPath, () => {
        this.servers.set(instanceId, server);
        this.socketPaths.set(instanceId, socketPath);
        resolve({ socketPath });
      });
    });
  }

  private async createTcpServer(instanceId: string): Promise<{ tcpPort: number }> {
    const port = await this.findAvailablePort();

    return new Promise((resolve, reject) => {
      const server = createNetServer((socket) => {
        this.handleConnection(instanceId, socket);
      });

      server.on("error", (err) => {
        this.usedPorts.delete(port);
        this.onError?.(err, instanceId);
        reject(err);
      });

      server.listen(port, "127.0.0.1", () => {
        this.servers.set(instanceId, server);
        this.tcpPorts.set(instanceId, port);
        this.usedPorts.add(port);
        resolve({ tcpPort: port });
      });
    });
  }

  private async findAvailablePort(): Promise<number> {
    const [minPort, maxPort] = this.tcpPortRange;

    // Try random ports within range
    for (let i = 0; i < 100; i++) {
      const port = minPort + Math.floor(Math.random() * (maxPort - minPort));
      if (this.usedPorts.has(port)) {
        continue;
      }
      const isAvailable = await this.checkPortAvailable(port);
      if (isAvailable) {
        return port;
      }
    }

    throw new Error(
      `Could not find available port in range ${minPort}-${maxPort}`
    );
  }

  private checkPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createNetServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
  }

  private handleConnection(instanceId: string, socket: Socket): void {
    // Store the client socket
    this.clientSockets.set(instanceId, socket);
    this.onConnect?.(instanceId);

    let buffer = "";

    const queue: WorkflowMessage[] = [];
    let processing = false;

    const processQueue = async () => {
      if (processing) return;
      processing = true;
      while (queue.length > 0) {
        const message = queue.shift()!;
        try {
          await this.handleMessage(instanceId, message);
        } catch (err) {
          this.onError?.(err instanceof Error ? err : new Error(String(err)), instanceId);
        }
      }
      processing = false;
    };

    socket.on("data", (data) => {
      buffer += data.toString();

      // Process complete messages (newline-delimited JSON)
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line) as WorkflowMessage;
          queue.push(message);
        } catch (err) {
          this.onError?.(new Error(`Invalid message: ${line}`), instanceId);
        }
      }

      processQueue().catch(() => undefined);
    });

    socket.on("error", (err) => {
      this.onError?.(err, instanceId);
    });

    socket.on("close", () => {
      this.clientSockets.delete(instanceId);
      this.onDisconnect?.(instanceId);
    });
  }

  private async handleMessage(instanceId: string, message: WorkflowMessage): Promise<void> {
    if (message.type === "proxy.call") {
      // Handle proxy request
      const request = message as ProxyRequest;
      try {
        const result = await this.onProxyCall(request);
        this.sendProxyResponse(instanceId, {
          type: "proxy.result",
          requestId: request.requestId,
          result,
        });
      } catch (err) {
        this.sendProxyResponse(instanceId, {
          type: "proxy.error",
          requestId: request.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Handle workflow event
      await this.onEvent(message as WorkflowEvent);
    }
  }

  sendProxyResponse(instanceId: string, response: ProxyResponse): boolean {
    const socket = this.clientSockets.get(instanceId);
    if (!socket) {
      return false;
    }

    try {
      socket.write(JSON.stringify(response) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  async closeSocket(instanceId: string): Promise<void> {
    // Close client socket
    const clientSocket = this.clientSockets.get(instanceId);
    if (clientSocket) {
      clientSocket.destroy();
      this.clientSockets.delete(instanceId);
    }

    // Close server
    const server = this.servers.get(instanceId);
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.servers.delete(instanceId);
    }

    // Clean up socket file (Unix only)
    const socketPath = this.socketPaths.get(instanceId);
    if (socketPath && existsSync(socketPath)) {
      await unlink(socketPath).catch(() => {
        // Ignore errors during cleanup
      });
    }
    this.socketPaths.delete(instanceId);

    // Clean up port tracking (TCP)
    const port = this.tcpPorts.get(instanceId);
    if (port) {
      this.usedPorts.delete(port);
      this.tcpPorts.delete(instanceId);
    }
  }

  getActiveConnections(): string[] {
    return Array.from(this.clientSockets.keys());
  }

  async shutdown(): Promise<void> {
    // Close all client sockets
    for (const socket of this.clientSockets.values()) {
      socket.destroy();
    }
    this.clientSockets.clear();

    // Close all servers
    const closePromises = Array.from(this.servers.values()).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    await Promise.all(closePromises);
    this.servers.clear();

    // Clean up socket files
    for (const socketPath of this.socketPaths.values()) {
      if (existsSync(socketPath)) {
        await unlink(socketPath).catch(() => {});
      }
    }
    this.socketPaths.clear();
    this.tcpPorts.clear();
    this.usedPorts.clear();
  }

  async cleanOrphanedSockets(activeInstanceIds: Set<string>): Promise<void> {
    if (this.isWindows) {
      // No socket files to clean on Windows
      return;
    }

    if (!existsSync(this.socketDir)) {
      return;
    }

    try {
      const files = await readdir(this.socketDir);

      for (const file of files) {
        // Match socket files: workflow_<instanceId>.sock
        const match = file.match(/^workflow_(.+)\.sock$/);
        if (match) {
          const instanceId = match[1]!;

          if (!activeInstanceIds.has(instanceId)) {
            // This socket file doesn't correspond to any active workflow
            const socketPath = join(this.socketDir, file);
            await unlink(socketPath).catch(() => {});
          }
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  }
}

// ============================================
// Factory Function
// ============================================

export interface WorkflowSocketConfig {
  /** Directory for Unix sockets (default: /tmp/donkeylabs-workflows) */
  socketDir?: string;
  /** TCP port range for Windows fallback (default: [49152, 65535]) */
  tcpPortRange?: [number, number];
}

export function createWorkflowSocketServer(
  config: WorkflowSocketConfig,
  callbacks: {
    onEvent: (event: WorkflowEvent) => void | Promise<void>;
    onProxyCall: (request: ProxyRequest) => Promise<any>;
    onConnect?: (instanceId: string) => void;
    onDisconnect?: (instanceId: string) => void;
    onError?: (error: Error, instanceId?: string) => void;
  }
): WorkflowSocketServer {
  return new WorkflowSocketServerImpl({
    socketDir: config.socketDir ?? "/tmp/donkeylabs-workflows",
    tcpPortRange: config.tcpPortRange ?? [49152, 65535],
    onEvent: callbacks.onEvent,
    onProxyCall: callbacks.onProxyCall,
    onConnect: callbacks.onConnect,
    onDisconnect: callbacks.onDisconnect,
    onError: callbacks.onError,
  });
}

// ============================================
// Message Parsing Helpers
// ============================================

export function isWorkflowEvent(message: WorkflowMessage): message is WorkflowEvent {
  return message.type !== "proxy.call";
}

export function isProxyRequest(message: WorkflowMessage): message is ProxyRequest {
  return message.type === "proxy.call";
}

export function parseWorkflowMessage(data: string): WorkflowMessage | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed.type) {
      return null;
    }
    return parsed as WorkflowMessage;
  } catch {
    return null;
  }
}
