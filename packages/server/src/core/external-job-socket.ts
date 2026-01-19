// External Job Socket Server
// Handles bidirectional communication with external job processes via Unix sockets (or TCP on Windows)

import { mkdir, rm, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server as NetServer, Socket } from "node:net";
import { createServer as createNetServer } from "node:net";
import type {
  AnyExternalJobMessage,
  ExternalJobsConfig,
} from "./external-jobs";
import { parseJobMessage } from "./external-jobs";

// ============================================
// Types
// ============================================

export interface SocketServerOptions {
  /** Directory for Unix sockets */
  socketDir: string;
  /** TCP port range for Windows fallback */
  tcpPortRange: [number, number];
  /** Callback when a message is received */
  onMessage: (message: AnyExternalJobMessage) => void;
  /** Callback when a connection is established */
  onConnect?: (jobId: string) => void;
  /** Callback when a connection is closed */
  onDisconnect?: (jobId: string) => void;
  /** Callback for errors */
  onError?: (error: Error, jobId?: string) => void;
}

export interface ExternalJobSocketServer {
  /** Create a new socket for a job (returns socket path or TCP port) */
  createSocket(jobId: string): Promise<{ socketPath?: string; tcpPort?: number }>;
  /** Close a specific job's socket and release reservations */
  closeSocket(jobId: string): Promise<void>;
  /** Get all active job connections */
  getActiveConnections(): string[];
  /** Attempt to reconnect to an existing socket */
  reconnect(jobId: string, socketPath?: string, tcpPort?: number): Promise<boolean>;
  /** Reserve a socket path/port for an orphaned job (prevents reuse until released) */
  reserve(jobId: string, socketPath?: string, tcpPort?: number): void;
  /** Release reservation for a job (called when job is cleaned up) */
  release(jobId: string): void;
  /** Check if a socket path or port is reserved */
  isReserved(socketPath?: string, tcpPort?: number): boolean;
  /** Shutdown all sockets and cleanup */
  shutdown(): Promise<void>;
  /** Clean orphaned socket files from a previous run */
  cleanOrphanedSockets(activeJobIds: Set<string>): Promise<void>;
}

// ============================================
// Implementation
// ============================================

export class ExternalJobSocketServerImpl implements ExternalJobSocketServer {
  private socketDir: string;
  private tcpPortRange: [number, number];
  private onMessage: (message: AnyExternalJobMessage) => void;
  private onConnect?: (jobId: string) => void;
  private onDisconnect?: (jobId: string) => void;
  private onError?: (error: Error, jobId?: string) => void;

  // Map of jobId -> server instance
  private servers = new Map<string, NetServer>();
  // Map of jobId -> active client socket
  private clientSockets = new Map<string, Socket>();
  // Map of jobId -> socket path
  private socketPaths = new Map<string, string>();
  // Map of jobId -> TCP port
  private tcpPorts = new Map<string, number>();
  // Track used TCP ports
  private usedPorts = new Set<number>();
  // Track reserved socket paths (for jobs that might reconnect)
  private reservedSocketPaths = new Set<string>();
  // Track reserved TCP ports (for jobs that might reconnect)
  private reservedTcpPorts = new Set<number>();
  // Map jobId -> reserved socket path (for release by jobId)
  private jobReservedSocketPath = new Map<string, string>();
  // Map jobId -> reserved TCP port (for release by jobId)
  private jobReservedTcpPort = new Map<string, number>();

  private isWindows = process.platform === "win32";

  constructor(options: SocketServerOptions) {
    this.socketDir = options.socketDir;
    this.tcpPortRange = options.tcpPortRange;
    this.onMessage = options.onMessage;
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.onError = options.onError;
  }

  async createSocket(jobId: string): Promise<{ socketPath?: string; tcpPort?: number }> {
    // Ensure socket directory exists (only for Unix)
    if (!this.isWindows) {
      await mkdir(this.socketDir, { recursive: true });
    }

    if (this.isWindows) {
      return this.createTcpServer(jobId);
    } else {
      return this.createUnixServer(jobId);
    }
  }

  private async createUnixServer(jobId: string): Promise<{ socketPath: string }> {
    const socketPath = join(this.socketDir, `job_${jobId}.sock`);

    // Check if this socket path is reserved by another job
    if (this.reservedSocketPaths.has(socketPath) && !this.jobReservedSocketPath.has(jobId)) {
      throw new Error(`Socket path ${socketPath} is reserved by another job`);
    }

    // Remove existing socket file if it exists
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }

    return new Promise((resolve, reject) => {
      const server = createNetServer((socket) => {
        this.handleConnection(jobId, socket);
      });

      server.on("error", (err) => {
        this.onError?.(err, jobId);
        reject(err);
      });

      server.listen(socketPath, () => {
        this.servers.set(jobId, server);
        this.socketPaths.set(jobId, socketPath);
        resolve({ socketPath });
      });
    });
  }

  private async createTcpServer(jobId: string): Promise<{ tcpPort: number }> {
    const port = await this.findAvailablePort();

    return new Promise((resolve, reject) => {
      const server = createNetServer((socket) => {
        this.handleConnection(jobId, socket);
      });

      server.on("error", (err) => {
        this.usedPorts.delete(port);
        this.onError?.(err, jobId);
        reject(err);
      });

      server.listen(port, "127.0.0.1", () => {
        this.servers.set(jobId, server);
        this.tcpPorts.set(jobId, port);
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
      // Skip if port is already in use or reserved by another job
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

  private handleConnection(jobId: string, socket: Socket): void {
    // Store the client socket
    this.clientSockets.set(jobId, socket);
    this.onConnect?.(jobId);

    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();

      // Process complete messages (newline-delimited JSON)
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        const message = parseJobMessage(line);
        if (message) {
          this.onMessage(message);
        } else {
          this.onError?.(new Error(`Invalid message: ${line}`), jobId);
        }
      }
    });

    socket.on("error", (err) => {
      this.onError?.(err, jobId);
    });

    socket.on("close", () => {
      this.clientSockets.delete(jobId);
      this.onDisconnect?.(jobId);
    });
  }

  async closeSocket(jobId: string): Promise<void> {
    // Close client socket
    const clientSocket = this.clientSockets.get(jobId);
    if (clientSocket) {
      clientSocket.destroy();
      this.clientSockets.delete(jobId);
    }

    // Close server
    const server = this.servers.get(jobId);
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.servers.delete(jobId);
    }

    // Clean up socket file (Unix only)
    const socketPath = this.socketPaths.get(jobId);
    if (socketPath && existsSync(socketPath)) {
      await unlink(socketPath).catch(() => {
        // Ignore errors during cleanup
      });
    }
    this.socketPaths.delete(jobId);

    // Clean up port tracking (TCP)
    const port = this.tcpPorts.get(jobId);
    if (port) {
      this.usedPorts.delete(port);
      this.tcpPorts.delete(jobId);
    }

    // Release any reservations for this job
    this.release(jobId);
  }

  getActiveConnections(): string[] {
    return Array.from(this.clientSockets.keys());
  }

  reserve(jobId: string, socketPath?: string, tcpPort?: number): void {
    if (socketPath) {
      this.reservedSocketPaths.add(socketPath);
      this.jobReservedSocketPath.set(jobId, socketPath);
    }
    if (tcpPort) {
      this.reservedTcpPorts.add(tcpPort);
      this.jobReservedTcpPort.set(jobId, tcpPort);
    }
  }

  release(jobId: string): void {
    // Release socket path reservation
    const socketPath = this.jobReservedSocketPath.get(jobId);
    if (socketPath) {
      this.reservedSocketPaths.delete(socketPath);
      this.jobReservedSocketPath.delete(jobId);
    }
    // Also check socketPaths map (for active jobs)
    const activeSocketPath = this.socketPaths.get(jobId);
    if (activeSocketPath) {
      this.reservedSocketPaths.delete(activeSocketPath);
    }

    // Release TCP port reservation
    const tcpPort = this.jobReservedTcpPort.get(jobId);
    if (tcpPort) {
      this.reservedTcpPorts.delete(tcpPort);
      this.jobReservedTcpPort.delete(jobId);
    }
    // Also check tcpPorts map (for active jobs)
    const activeTcpPort = this.tcpPorts.get(jobId);
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
    jobId: string,
    socketPath?: string,
    tcpPort?: number
  ): Promise<boolean> {
    // Check if we already have a connection
    if (this.clientSockets.has(jobId)) {
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
            this.handleConnection(jobId, socket);
          });

          server.on("error", (err) => {
            this.onError?.(err, jobId);
            resolve(false);
          });

          server.listen(socketPath, () => {
            this.servers.set(jobId, server);
            this.socketPaths.set(jobId, socketPath);
            console.log(`[SocketServer] Recreated socket for job ${jobId} at ${socketPath}`);
            // Return true - the server is ready, external process should reconnect
            resolve(true);
          });
        });
      } catch (err) {
        this.onError?.(err as Error, jobId);
        return false;
      }
    }

    // For TCP, recreate the server on the same port
    if (tcpPort && this.isWindows) {
      try {
        return new Promise((resolve) => {
          const server = createNetServer((socket) => {
            this.handleConnection(jobId, socket);
          });

          server.on("error", (err) => {
            this.onError?.(err, jobId);
            resolve(false);
          });

          server.listen(tcpPort, "127.0.0.1", () => {
            this.servers.set(jobId, server);
            this.tcpPorts.set(jobId, tcpPort);
            this.usedPorts.add(tcpPort);
            console.log(`[SocketServer] Recreated TCP server for job ${jobId} on port ${tcpPort}`);
            resolve(true);
          });
        });
      } catch (err) {
        this.onError?.(err as Error, jobId);
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

  async cleanOrphanedSockets(activeJobIds: Set<string>): Promise<void> {
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
        // Match socket files: job_<jobId>.sock
        const match = file.match(/^job_(.+)\.sock$/);
        if (match) {
          const jobId = match[1]!;
          const socketPath = join(this.socketDir, file);

          // Don't clean if job is active or socket path is reserved
          if (!activeJobIds.has(jobId) && !this.reservedSocketPaths.has(socketPath)) {
            // This socket file doesn't correspond to any active job and isn't reserved
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

export function createExternalJobSocketServer(
  config: ExternalJobsConfig,
  callbacks: {
    onMessage: (message: AnyExternalJobMessage) => void;
    onConnect?: (jobId: string) => void;
    onDisconnect?: (jobId: string) => void;
    onError?: (error: Error, jobId?: string) => void;
  }
): ExternalJobSocketServer {
  return new ExternalJobSocketServerImpl({
    socketDir: config.socketDir ?? "/tmp/donkeylabs-jobs",
    tcpPortRange: config.tcpPortRange ?? [49152, 65535],
    onMessage: callbacks.onMessage,
    onConnect: callbacks.onConnect,
    onDisconnect: callbacks.onDisconnect,
    onError: callbacks.onError,
  });
}
