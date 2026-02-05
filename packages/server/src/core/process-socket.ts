/**
 * Process Socket Server
 * Handles bidirectional communication with managed processes via Unix sockets (or TCP on Windows)
 */

import { mkdir, rm, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server as NetServer, Socket } from "node:net";
import { createServer as createNetServer, createConnection } from "node:net";

// ============================================
// Types
// ============================================

export interface ProcessMessage {
  type: string;
  processId: string;
  timestamp: number;
  [key: string]: any;
}

export interface ProcessSocketServerOptions {
  /** Directory for Unix sockets */
  socketDir: string;
  /** TCP port range for Windows fallback */
  tcpPortRange: [number, number];
  /** Callback when a message is received */
  onMessage: (message: ProcessMessage) => void;
  /** Callback when a connection is established */
  onConnect?: (processId: string) => void;
  /** Callback when a connection is closed */
  onDisconnect?: (processId: string) => void;
  /** Callback for errors */
  onError?: (error: Error, processId?: string) => void;
}

export interface ProcessSocketServer {
  /** Create a new socket for a process (returns socket path or TCP port) */
  createSocket(processId: string): Promise<{ socketPath?: string; tcpPort?: number }>;
  /** Close a specific process's socket and release reservations */
  closeSocket(processId: string): Promise<void>;
  /** Send a message to a process */
  send(processId: string, message: any): Promise<boolean>;
  /** Get all active process connections */
  getActiveConnections(): string[];
  /** Attempt to reconnect to an existing socket */
  reconnect(processId: string, socketPath?: string, tcpPort?: number): Promise<boolean>;
  /** Reserve a socket path/port for an orphaned process (prevents reuse until released) */
  reserve(processId: string, socketPath?: string, tcpPort?: number): void;
  /** Release reservation for a process (called when process is cleaned up) */
  release(processId: string): void;
  /** Check if a socket path or port is reserved */
  isReserved(socketPath?: string, tcpPort?: number): boolean;
  /** Shutdown all sockets and cleanup */
  shutdown(): Promise<void>;
  /** Clean orphaned socket files from a previous run */
  cleanOrphanedSockets(activeProcessIds: Set<string>): Promise<void>;
}

// ============================================
// Implementation
// ============================================

export class ProcessSocketServerImpl implements ProcessSocketServer {
  private socketDir: string;
  private tcpPortRange: [number, number];
  private onMessage: (message: ProcessMessage) => void;
  private onConnect?: (processId: string) => void;
  private onDisconnect?: (processId: string) => void;
  private onError?: (error: Error, processId?: string) => void;

  // Map of processId -> server instance
  private servers = new Map<string, NetServer>();
  // Map of processId -> active client socket
  private clientSockets = new Map<string, Socket>();
  // Map of processId -> socket path
  private socketPaths = new Map<string, string>();
  // Map of processId -> TCP port
  private tcpPorts = new Map<string, number>();
  // Track used TCP ports
  private usedPorts = new Set<number>();
  // Track reserved socket paths (for processes that might reconnect)
  private reservedSocketPaths = new Set<string>();
  // Track reserved TCP ports (for processes that might reconnect)
  private reservedTcpPorts = new Set<number>();
  // Map processId -> reserved socket path (for release by processId)
  private processReservedSocketPath = new Map<string, string>();
  // Map processId -> reserved TCP port (for release by processId)
  private processReservedTcpPort = new Map<string, number>();

  private isWindows = process.platform === "win32";

  constructor(options: ProcessSocketServerOptions) {
    this.socketDir = options.socketDir;
    this.tcpPortRange = options.tcpPortRange;
    this.onMessage = options.onMessage;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.onError = options.onError;
  }

  async createSocket(processId: string): Promise<{ socketPath?: string; tcpPort?: number }> {
    // Ensure socket directory exists (only for Unix)
    if (!this.isWindows) {
      await mkdir(this.socketDir, { recursive: true });
    }

    if (this.isWindows) {
      return this.createTcpServer(processId);
    } else {
      return this.createUnixServer(processId);
    }
  }

  private async createUnixServer(processId: string): Promise<{ socketPath: string }> {
    const socketPath = join(this.socketDir, `proc_${processId}.sock`);

    // Check if this socket path is reserved by another process
    if (this.reservedSocketPaths.has(socketPath) && !this.processReservedSocketPath.has(processId)) {
      throw new Error(`Socket path ${socketPath} is reserved by another process`);
    }

    // Remove existing socket file if it exists
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }

    return new Promise((resolve, reject) => {
      const server = createNetServer((socket) => {
        this.handleConnection(processId, socket);
      });

      server.on("error", (err) => {
        this.onError?.(err, processId);
        reject(err);
      });

      server.listen(socketPath, () => {
        this.servers.set(processId, server);
        this.socketPaths.set(processId, socketPath);
        resolve({ socketPath });
      });
    });
  }

  private async createTcpServer(processId: string): Promise<{ tcpPort: number }> {
    const port = await this.findAvailablePort();

    return new Promise((resolve, reject) => {
      const server = createNetServer((socket) => {
        this.handleConnection(processId, socket);
      });

      server.on("error", (err) => {
        this.usedPorts.delete(port);
        this.onError?.(err, processId);
        reject(err);
      });

      server.listen(port, "127.0.0.1", () => {
        this.servers.set(processId, server);
        this.tcpPorts.set(processId, port);
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
      // Skip if port is already in use or reserved by another process
      if (this.usedPorts.has(port) || this.reservedTcpPorts.has(port)) {
        continue;
      }
      // Check if port is actually available
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

  private handleConnection(processId: string, socket: Socket): void {
    // Store the client socket
    this.clientSockets.set(processId, socket);
    this.onConnect?.(processId);

    let buffer = "";

    const queue: ProcessMessage[] = [];
    let processing = false;

    const processQueue = async () => {
      if (processing) return;
      processing = true;
      while (queue.length > 0) {
        const message = queue.shift()!;
        try {
          await this.onMessage(message);
        } catch (err) {
          this.onError?.(err instanceof Error ? err : new Error(String(err)), processId);
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

        const message = this.parseMessage(line);
        if (message) {
          queue.push(message);
        } else {
          this.onError?.(new Error(`Invalid message: ${line}`), processId);
        }
      }

      processQueue().catch(() => undefined);
    });

    socket.on("error", (err) => {
      this.onError?.(err, processId);
    });

    socket.on("close", () => {
      this.clientSockets.delete(processId);
      this.onDisconnect?.(processId);
    });
  }

  private parseMessage(data: string): ProcessMessage | null {
    try {
      const parsed = JSON.parse(data);
      if (!parsed.type || !parsed.processId || typeof parsed.timestamp !== "number") {
        return null;
      }
      return parsed as ProcessMessage;
    } catch {
      return null;
    }
  }

  async send(processId: string, message: any): Promise<boolean> {
    const socket = this.clientSockets.get(processId);
    if (!socket || socket.destroyed) {
      return false;
    }

    return new Promise((resolve) => {
      const data = JSON.stringify(message) + "\n";
      socket.write(data, (err) => {
        if (err) {
          this.onError?.(err, processId);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  async closeSocket(processId: string): Promise<void> {
    // Close client socket
    const clientSocket = this.clientSockets.get(processId);
    if (clientSocket) {
      clientSocket.destroy();
      this.clientSockets.delete(processId);
    }

    // Close server
    const server = this.servers.get(processId);
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.servers.delete(processId);
    }

    // Clean up socket file (Unix only)
    const socketPath = this.socketPaths.get(processId);
    if (socketPath && existsSync(socketPath)) {
      await unlink(socketPath).catch(() => {
        // Ignore errors during cleanup
      });
    }
    this.socketPaths.delete(processId);

    // Clean up port tracking (TCP)
    const port = this.tcpPorts.get(processId);
    if (port) {
      this.usedPorts.delete(port);
      this.tcpPorts.delete(processId);
    }

    // Release any reservations for this process
    this.release(processId);
  }

  getActiveConnections(): string[] {
    return Array.from(this.clientSockets.keys());
  }

  reserve(processId: string, socketPath?: string, tcpPort?: number): void {
    if (socketPath) {
      this.reservedSocketPaths.add(socketPath);
      this.processReservedSocketPath.set(processId, socketPath);
    }
    if (tcpPort) {
      this.reservedTcpPorts.add(tcpPort);
      this.processReservedTcpPort.set(processId, tcpPort);
    }
  }

  release(processId: string): void {
    // Release socket path reservation
    const socketPath = this.processReservedSocketPath.get(processId);
    if (socketPath) {
      this.reservedSocketPaths.delete(socketPath);
      this.processReservedSocketPath.delete(processId);
    }
    // Also check socketPaths map (for active processes)
    const activeSocketPath = this.socketPaths.get(processId);
    if (activeSocketPath) {
      this.reservedSocketPaths.delete(activeSocketPath);
    }

    // Release TCP port reservation
    const tcpPort = this.processReservedTcpPort.get(processId);
    if (tcpPort) {
      this.reservedTcpPorts.delete(tcpPort);
      this.processReservedTcpPort.delete(processId);
    }
    // Also check tcpPorts map (for active processes)
    const activeTcpPort = this.tcpPorts.get(processId);
    if (activeTcpPort) {
      this.reservedTcpPorts.delete(activeTcpPort);
    }
  }

  isReserved(socketPath?: string, tcpPort?: number): boolean {
    if (socketPath && this.reservedSocketPaths.has(socketPath)) {
      return true;
    }
    if (tcpPort && this.reservedTcpPorts.has(tcpPort)) {
      return true;
    }
    return false;
  }

  async reconnect(
    processId: string,
    socketPath?: string,
    tcpPort?: number
  ): Promise<boolean> {
    // Check if we already have a connection
    if (this.clientSockets.has(processId)) {
      return true;
    }

    // For Unix sockets, recreate the server on the same path
    // The external process should be retrying to connect
    if (socketPath && !this.isWindows) {
      try {
        // Remove old socket file if it exists
        if (existsSync(socketPath)) {
          await unlink(socketPath);
        }

        // Create new server on the same path
        return new Promise((resolve) => {
          const server = createNetServer((socket) => {
            this.handleConnection(processId, socket);
          });

          server.on("error", (err) => {
            this.onError?.(err, processId);
            resolve(false);
          });

          server.listen(socketPath, () => {
            this.servers.set(processId, server);
            this.socketPaths.set(processId, socketPath);
            console.log(`[ProcessSocket] Recreated socket for process ${processId} at ${socketPath}`);
            // Return true - the server is ready, external process should reconnect
            resolve(true);
          });
        });
      } catch (err) {
        this.onError?.(err as Error, processId);
        return false;
      }
    }

    // For TCP, recreate the server on the same port
    if (tcpPort && this.isWindows) {
      try {
        return new Promise((resolve) => {
          const server = createNetServer((socket) => {
            this.handleConnection(processId, socket);
          });

          server.on("error", (err) => {
            this.onError?.(err, processId);
            resolve(false);
          });

          server.listen(tcpPort, "127.0.0.1", () => {
            this.servers.set(processId, server);
            this.tcpPorts.set(processId, tcpPort);
            this.usedPorts.add(tcpPort);
            console.log(`[ProcessSocket] Recreated TCP server for process ${processId} on port ${tcpPort}`);
            resolve(true);
          });
        });
      } catch (err) {
        this.onError?.(err as Error, processId);
        return false;
      }
    }

    return false;
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

  async cleanOrphanedSockets(activeProcessIds: Set<string>): Promise<void> {
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
        // Match socket files: proc_<processId>.sock
        const match = file.match(/^proc_(.+)\.sock$/);
        if (match) {
          const processId = match[1]!;
          const socketPath = join(this.socketDir, file);

          // Don't clean if process is active or socket path is reserved
          if (!activeProcessIds.has(processId) && !this.reservedSocketPaths.has(socketPath)) {
            // This socket file doesn't correspond to any active process and isn't reserved
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

export interface ProcessSocketConfig {
  /** Directory for Unix sockets (default: /tmp/donkeylabs-processes) */
  socketDir?: string;
  /** TCP port range for Windows fallback (default: [49152, 65535]) */
  tcpPortRange?: [number, number];
}

export function createProcessSocketServer(
  config: ProcessSocketConfig,
  callbacks: {
    onMessage: (message: ProcessMessage) => void;
    onConnect?: (processId: string) => void;
    onDisconnect?: (processId: string) => void;
    onError?: (error: Error, processId?: string) => void;
  }
): ProcessSocketServer {
  return new ProcessSocketServerImpl({
    socketDir: config.socketDir ?? "/tmp/donkeylabs-processes",
    tcpPortRange: config.tcpPortRange ?? [49152, 65535],
    onMessage: callbacks.onMessage,
    onConnect: callbacks.onConnect,
    onDisconnect: callbacks.onDisconnect,
    onError: callbacks.onError,
  });
}
