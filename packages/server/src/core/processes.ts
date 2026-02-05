/**
 * Processes Core Service
 *
 * Manages persistent, long-running processes (daemons) with supervision capabilities.
 * Use cases: FFmpeg subprocesses, Firecracker VMs, any long-running daemon requiring supervision.
 */

import type { Subprocess } from "bun";
import type { Events } from "./events";
import {
  createProcessSocketServer,
  type ProcessSocketServer,
  type ProcessMessage,
  type ProcessSocketConfig,
} from "./process-socket";
import {
  SqliteProcessAdapter,
  type ProcessAdapter,
  type SqliteProcessAdapterConfig,
} from "./process-adapter-sqlite";

// ============================================
// Types
// ============================================

export type ProcessStatus =
  | "spawning"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"
  | "orphaned"
  | "dead";

export interface ProcessConfig {
  /** Command to execute (e.g., "ffmpeg", "python", "./script.sh") */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Working directory for the process */
  cwd?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Auto-restart on crash (default: false) */
  autoRestart?: boolean;
  /** Maximum number of restarts before giving up (default: 10, -1 for unlimited) */
  maxRestarts?: number;
  /** Backoff configuration for restarts */
  backoff?: {
    /** Initial delay in ms (default: 1000) */
    initialDelayMs?: number;
    /** Maximum delay in ms (default: 30000) */
    maxDelayMs?: number;
    /** Multiplier for exponential backoff (default: 2) */
    multiplier?: number;
  };
  /** Heartbeat configuration */
  heartbeat?: {
    /** Expected interval between heartbeats in ms (default: 30000) */
    intervalMs?: number;
    /** Timeout before considering unhealthy in ms (default: 60000) */
    timeoutMs?: number;
  };
  /** Hard limits for the process (optional) */
  limits?: {
    /** Max runtime in ms before termination */
    maxRuntimeMs?: number;
    /** Max memory (RSS) in MB before termination (requires stats enabled) */
    maxMemoryMb?: number;
    /** Max CPU percent before termination (requires stats enabled) */
    maxCpuPercent?: number;
  };
}

export interface ManagedProcess {
  id: string;
  name: string;
  pid?: number;
  socketPath?: string;
  tcpPort?: number;
  status: ProcessStatus;
  config: ProcessConfig;
  metadata?: Record<string, any>;
  createdAt: Date;
  startedAt?: Date;
  stoppedAt?: Date;
  lastHeartbeat?: Date;
  restartCount: number;
  consecutiveFailures: number;
  error?: string;
}

/**
 * Process stats received from a managed process.
 */
export interface ProcessStats {
  /** CPU usage since last measurement */
  cpu: {
    /** User CPU time in microseconds */
    user: number;
    /** System CPU time in microseconds */
    system: number;
    /** CPU usage percentage (0-100) since last measurement */
    percent: number;
  };
  /** Memory usage */
  memory: {
    /** Resident set size in bytes */
    rss: number;
    /** V8 heap total in bytes */
    heapTotal: number;
    /** V8 heap used in bytes */
    heapUsed: number;
    /** External memory in bytes (C++ objects bound to JS) */
    external: number;
  };
  /** Process uptime in seconds */
  uptime: number;
}

export interface ProcessDefinition {
  name: string;
  config: Omit<ProcessConfig, "args"> & { args?: string[] };
  /**
   * Event schemas this process can emit.
   * Events are automatically emitted to ctx.core.events as "process.<name>.<event>"
   * and broadcast to SSE channel "process:<processId>".
   *
   * @example
   * ```ts
   * events: {
   *   progress: z.object({ percent: z.number(), fps: z.number() }),
   *   complete: z.object({ outputPath: z.string() }),
   *   error: z.object({ message: z.string() }),
   * }
   * ```
   */
  events?: Record<string, import("zod").ZodType<any>>;
  /** Called when a message is received from the process */
  onMessage?: (process: ManagedProcess, message: any) => void | Promise<void>;
  /** Called when the process crashes unexpectedly */
  onCrash?: (process: ManagedProcess, exitCode: number | null) => void | Promise<void>;
  /** Called when heartbeat is missed */
  onUnhealthy?: (process: ManagedProcess) => void | Promise<void>;
  /** Called when the process is restarted */
  onRestart?: (oldProcess: ManagedProcess, newProcess: ManagedProcess, attempt: number) => void | Promise<void>;
  /**
   * Called when stats are received from the process.
   * Stats are emitted by the process client when stats.enabled is true.
   *
   * @example
   * ```ts
   * onStats: (process, stats) => {
   *   console.log(`${process.name}: CPU ${stats.cpu.percent}%, Memory ${stats.memory.rss / 1e6}MB`);
   * }
   * ```
   */
  onStats?: (process: ManagedProcess, stats: ProcessStats) => void | Promise<void>;
}

export interface SpawnOptions {
  /** Override config fields for this spawn */
  configOverrides?: Partial<ProcessConfig>;
  /** Metadata to store with the process */
  metadata?: Record<string, any>;
}

// ============================================
// Configuration
// ============================================

export interface ProcessesConfig {
  /** Adapter instance or sqlite adapter configuration */
  adapter?: ProcessAdapter | SqliteProcessAdapterConfig;
  /** Socket server configuration */
  socket?: ProcessSocketConfig;
  /** Events service for emitting process events */
  events?: Events;
  /** Heartbeat check interval in ms (default: 10000) */
  heartbeatCheckInterval?: number;
  /** Enable auto-reconnect to orphaned processes on startup (default: true) */
  autoRecoverOrphans?: boolean;
  /** Grace period before SIGKILL when stopping/killing (ms, default: 5000) */
  killGraceMs?: number;
  /** Disable in-process watchdog timers (use external watchdog instead) */
  useWatchdog?: boolean;
}

// ============================================
// Service Interface
// ============================================

export interface Processes {
  /** Register a process definition */
  register(definition: ProcessDefinition): void;
  /** Spawn a new process instance */
  spawn(name: string, options?: SpawnOptions): Promise<string>;
  /** Gracefully stop a process (SIGTERM) */
  stop(processId: string): Promise<boolean>;
  /** Force kill a process (SIGKILL) */
  kill(processId: string): Promise<boolean>;
  /** Restart a process */
  restart(processId: string): Promise<string>;
  /** Get a process by ID */
  get(processId: string): Promise<ManagedProcess | null>;
  /** Get all processes by name */
  getByName(name: string): Promise<ManagedProcess[]>;
  /** Get all running processes */
  getRunning(): Promise<ManagedProcess[]>;
  /** Send a message to a process via socket */
  send(processId: string, message: any): Promise<boolean>;
  /** Start the service (recovery, monitoring) */
  start(): void;
  /** Shutdown the service and all managed processes */
  shutdown(): Promise<void>;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Check if a process with given PID is still alive
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 doesn't actually send a signal,
    // it just checks if the process exists and we have permission to signal it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Calculate backoff delay with jitter
 */
function calculateBackoff(
  consecutiveFailures: number,
  config: ProcessConfig["backoff"]
): number {
  const initialDelay = config?.initialDelayMs ?? 1000;
  const maxDelay = config?.maxDelayMs ?? 30000;
  const multiplier = config?.multiplier ?? 2;

  const delay = Math.min(
    initialDelay * Math.pow(multiplier, consecutiveFailures),
    maxDelay
  );

  // Add jitter (0.5 to 1.5x the delay)
  return delay * (0.5 + Math.random());
}

// ============================================
// Implementation
// ============================================

export class ProcessesImpl implements Processes {
  private definitions = new Map<string, ProcessDefinition>();
  private adapter: ProcessAdapter;
  private socketServer: ProcessSocketServer;
  private events?: Events;
  private heartbeatCheckInterval: number;
  private autoRecoverOrphans: boolean;
  private killGraceMs: number;
  private runtimeLimitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private useWatchdog: boolean;

  // Track running Bun subprocesses
  private subprocesses = new Map<string, Subprocess>();
  // Track pending restarts (processId -> timeout)
  private pendingRestarts = new Map<string, ReturnType<typeof setTimeout>>();
  // Heartbeat monitor interval
  private heartbeatMonitor?: ReturnType<typeof setInterval>;
  // Shutdown flag
  private isShuttingDown = false;

  constructor(config: ProcessesConfig = {}) {
    if (config.adapter && typeof (config.adapter as ProcessAdapter).get === "function") {
      this.adapter = config.adapter as ProcessAdapter;
    } else {
      this.adapter = new SqliteProcessAdapter(config.adapter as SqliteProcessAdapterConfig | undefined);
    }
    this.events = config.events;
    this.heartbeatCheckInterval = config.heartbeatCheckInterval ?? 10000;
    this.autoRecoverOrphans = config.autoRecoverOrphans ?? true;
    this.killGraceMs = config.killGraceMs ?? 5000;
    this.useWatchdog = config.useWatchdog ?? false;

    // Create socket server with callbacks
    this.socketServer = createProcessSocketServer(config.socket ?? {}, {
      onMessage: (message) => this.handleMessage(message),
      onConnect: (processId) => this.handleConnect(processId),
      onDisconnect: (processId) => this.handleDisconnect(processId),
      onError: (error, processId) => this.handleError(error, processId),
    });
  }

  register(definition: ProcessDefinition): void {
    if (this.definitions.has(definition.name)) {
      console.warn(`[Processes] Overwriting existing definition for '${definition.name}'`);
    }
    this.definitions.set(definition.name, definition);
    console.log(`[Processes] Registered process definition: ${definition.name}`);
  }

  async spawn(name: string, options?: SpawnOptions): Promise<string> {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`Process definition '${name}' not found. Did you call register()?`);
    }

    // Merge config with overrides
    const config: ProcessConfig = {
      ...definition.config,
      ...options?.configOverrides,
      args: options?.configOverrides?.args ?? definition.config.args,
      env: {
        ...definition.config.env,
        ...options?.configOverrides?.env,
      },
    };

    // Create DB record with status "spawning" (before spawn for crash recovery)
    const process = await this.adapter.create({
      name,
      status: "spawning",
      config,
      metadata: options?.metadata,
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    try {
      // Create Unix socket
      const { socketPath, tcpPort } = await this.socketServer.createSocket(process.id);

      // Build environment with socket info and metadata
      const env: Record<string, string> = {
        ...config.env,
        DONKEYLABS_PROCESS_ID: process.id,
      };
      if (socketPath) {
        env.DONKEYLABS_SOCKET_PATH = socketPath;
      }
      if (tcpPort) {
        env.DONKEYLABS_TCP_PORT = tcpPort.toString();
      }
      if (options?.metadata) {
        env.DONKEYLABS_METADATA = JSON.stringify(options.metadata);
      }

      // Spawn the process
      const proc = Bun.spawn([config.command, ...(config.args || [])], {
        cwd: config.cwd,
        env,
        stdout: "inherit",
        stderr: "inherit",
      });

      // Store subprocess reference
      this.subprocesses.set(process.id, proc);

      // Update DB with PID and status
      await this.adapter.update(process.id, {
        pid: proc.pid,
        socketPath,
        tcpPort,
        status: "running",
        startedAt: new Date(),
      });

      // Emit event
      await this.emitEvent("process.spawned", {
        processId: process.id,
        name,
        pid: proc.pid,
      });

      // Set up exit handler for crash detection
      proc.exited.then((exitCode) => this.handleExit(process.id, exitCode));

      const maxRuntimeMs = config.limits?.maxRuntimeMs;
      if (!this.useWatchdog && maxRuntimeMs && maxRuntimeMs > 0) {
        const timer = setTimeout(async () => {
          console.warn(`[Processes] Max runtime exceeded for ${name} (${process.id})`);
          await this.emitEvent("process.limits_exceeded", {
            processId: process.id,
            name,
            reason: "maxRuntimeMs",
            limit: maxRuntimeMs,
          });
          await this.stop(process.id);
        }, maxRuntimeMs);
        this.runtimeLimitTimers.set(process.id, timer);
      }

      console.log(`[Processes] Spawned ${name} (${process.id}) with PID ${proc.pid}`);
      return process.id;
    } catch (error) {
      // Cleanup on spawn failure
      await this.adapter.update(process.id, {
        status: "crashed",
        error: error instanceof Error ? error.message : String(error),
        stoppedAt: new Date(),
      });
      await this.socketServer.closeSocket(process.id);
      throw error;
    }
  }

  async stop(processId: string): Promise<boolean> {
    const proc = await this.adapter.get(processId);
    if (!proc) return false;

    if (proc.status !== "running" && proc.status !== "spawning") {
      return false;
    }

    // Mark as stopping to prevent auto-restart
    await this.adapter.update(processId, { status: "stopping" });

    const subprocess = this.subprocesses.get(processId);
    if (subprocess && proc.pid) {
      try {
        // Send SIGTERM for graceful shutdown
        subprocess.kill("SIGTERM");

        // Wait for process to exit (with timeout)
        const exitPromise = subprocess.exited;
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), this.killGraceMs)
        );

        const result = await Promise.race([exitPromise, timeoutPromise]);
        if (result === null) {
          // Timed out, force kill
          subprocess.kill("SIGKILL");
          await subprocess.exited;
        }
      } catch {
        // Process may have already exited
      }
    }

    // Cleanup
    await this.socketServer.closeSocket(processId);
    this.subprocesses.delete(processId);
    const runtimeTimer = this.runtimeLimitTimers.get(processId);
    if (runtimeTimer) {
      clearTimeout(runtimeTimer);
      this.runtimeLimitTimers.delete(processId);
    }

    await this.adapter.update(processId, {
      status: "stopped",
      stoppedAt: new Date(),
    });

    await this.emitEvent("process.stopped", { processId, name: proc.name });
    console.log(`[Processes] Stopped ${proc.name} (${processId})`);
    return true;
  }

  async kill(processId: string): Promise<boolean> {
    const proc = await this.adapter.get(processId);
    if (!proc) return false;

    // Mark as stopping to prevent auto-restart
    await this.adapter.update(processId, { status: "stopping" });

    const subprocess = this.subprocesses.get(processId);
    if (subprocess && proc.pid) {
      try {
        subprocess.kill("SIGKILL");
        await subprocess.exited;
      } catch {
        // Process may have already exited
      }
    }

    // Cleanup
    await this.socketServer.closeSocket(processId);
    this.subprocesses.delete(processId);
    const runtimeTimer = this.runtimeLimitTimers.get(processId);
    if (runtimeTimer) {
      clearTimeout(runtimeTimer);
      this.runtimeLimitTimers.delete(processId);
    }

    await this.adapter.update(processId, {
      status: "stopped",
      stoppedAt: new Date(),
    });

    await this.emitEvent("process.stopped", { processId, name: proc.name });
    console.log(`[Processes] Killed ${proc.name} (${processId})`);
    return true;
  }

  async restart(processId: string): Promise<string> {
    const oldProcess = await this.adapter.get(processId);
    if (!oldProcess) {
      throw new Error(`Process ${processId} not found`);
    }

    // Stop the old process
    await this.stop(processId);

    // Spawn new instance with same config
    const newProcessId = await this.spawn(oldProcess.name, {
      configOverrides: oldProcess.config,
      metadata: oldProcess.metadata,
    });

    const newProcess = await this.adapter.get(newProcessId);
    if (newProcess) {
      // Update restart count
      await this.adapter.update(newProcessId, {
        restartCount: oldProcess.restartCount + 1,
      });

      const definition = this.definitions.get(oldProcess.name);
      if (definition?.onRestart) {
        await definition.onRestart(oldProcess, newProcess, oldProcess.restartCount + 1);
      }

      await this.emitEvent("process.restarted", {
        oldProcessId: processId,
        newProcessId,
        name: oldProcess.name,
        attempt: oldProcess.restartCount + 1,
      });
    }

    return newProcessId;
  }

  async get(processId: string): Promise<ManagedProcess | null> {
    return this.adapter.get(processId);
  }

  async getByName(name: string): Promise<ManagedProcess[]> {
    return this.adapter.getByName(name);
  }

  async getRunning(): Promise<ManagedProcess[]> {
    return this.adapter.getRunning();
  }

  async send(processId: string, message: any): Promise<boolean> {
    return this.socketServer.send(processId, message);
  }

  start(): void {
    // Recover orphaned processes
    if (this.autoRecoverOrphans) {
      this.reconcileOrphans().catch((err) => {
        console.error("[Processes] Error recovering orphans:", err);
      });
    }

    // Start heartbeat monitoring
    this.startHeartbeatMonitor();

    console.log("[Processes] Service started");
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    console.log("[Processes] Shutting down...");

    // Stop heartbeat monitor
    if (this.heartbeatMonitor) {
      clearInterval(this.heartbeatMonitor);
      this.heartbeatMonitor = undefined;
    }

    // Cancel pending restarts
    for (const timeout of this.pendingRestarts.values()) {
      clearTimeout(timeout);
    }
    this.pendingRestarts.clear();

    // Stop all running processes
    const running = await this.adapter.getRunning();
    await Promise.all(running.map((p) => this.stop(p.id)));

    // Shutdown socket server
    await this.socketServer.shutdown();

    // Stop adapter
    this.adapter.stop();

    console.log("[Processes] Shutdown complete");
  }

  // ============================================
  // Private Methods
  // ============================================

  private async handleMessage(message: ProcessMessage): Promise<void> {
    const { processId, type } = message;
    const proc = await this.adapter.get(processId);
    if (!proc) return;

    // Handle heartbeat messages
    if (type === "heartbeat") {
      await this.adapter.update(processId, { lastHeartbeat: new Date() });
      return;
    }

    // Handle stats messages
    if (type === "stats" && message.stats) {
      const stats = message.stats as ProcessStats;

      // Emit to events service as "process.<name>.stats"
      await this.emitEvent(`process.${proc.name}.stats`, {
        processId,
        name: proc.name,
        stats,
      });

      // Generic stats event
      await this.emitEvent("process.stats", {
        processId,
        name: proc.name,
        stats,
      });

      // Call definition callback
      const definition = this.definitions.get(proc.name);
      if (definition?.onStats) {
        await definition.onStats(proc, stats);
      }

      const limits = proc.config.limits;
      if (limits) {
        if (limits.maxMemoryMb && stats.memory.rss / 1e6 > limits.maxMemoryMb) {
          console.warn(`[Processes] Memory limit exceeded for ${proc.name} (${proc.id})`);
          await this.emitEvent("process.limits_exceeded", {
            processId,
            name: proc.name,
            reason: "maxMemoryMb",
            limit: limits.maxMemoryMb,
            value: stats.memory.rss / 1e6,
          });
          await this.emitEvent("process.watchdog.killed", {
            processId,
            name: proc.name,
            reason: "maxMemoryMb",
            value: stats.memory.rss / 1e6,
          });
          await this.stop(proc.id);
          return;
        }

        if (limits.maxCpuPercent && stats.cpu.percent > limits.maxCpuPercent) {
          console.warn(`[Processes] CPU limit exceeded for ${proc.name} (${proc.id})`);
          await this.emitEvent("process.limits_exceeded", {
            processId,
            name: proc.name,
            reason: "maxCpuPercent",
            limit: limits.maxCpuPercent,
            value: stats.cpu.percent,
          });
          await this.emitEvent("process.watchdog.killed", {
            processId,
            name: proc.name,
            reason: "maxCpuPercent",
            value: stats.cpu.percent,
          });
          await this.stop(proc.id);
          return;
        }
      }

      return;
    }

    // Handle typed event messages from ProcessClient.emit()
    if (type === "event" && message.event) {
      const eventName = message.event as string;
      const eventData = message.data ?? {};

      // Emit to events service as "process.<name>.<event>"
      await this.emitEvent(`process.${proc.name}.${eventName}`, {
        processId,
        name: proc.name,
        event: eventName,
        data: eventData,
      });

      // Broadcast to SSE channel "process:<processId>"
      if (this.events) {
        // SSE broadcast happens through events - listeners can forward to SSE
        await this.emitEvent("process.event", {
          processId,
          name: proc.name,
          event: eventName,
          data: eventData,
        });
      }
    }

    // Emit generic message event (for raw messages)
    await this.emitEvent("process.message", {
      processId,
      name: proc.name,
      message,
    });

    // Call definition callback
    const definition = this.definitions.get(proc.name);
    if (definition?.onMessage) {
      await definition.onMessage(proc, message);
    }
  }

  private handleConnect(processId: string): void {
    console.log(`[Processes] Socket connected: ${processId}`);
  }

  private async handleDisconnect(processId: string): Promise<void> {
    console.log(`[Processes] Socket disconnected: ${processId}`);
    // Socket disconnect doesn't mean process crashed - wait for exit handler
  }

  private handleError(error: Error, processId?: string): void {
    console.error(`[Processes] Socket error${processId ? ` for ${processId}` : ""}:`, error.message);
  }

  private async handleExit(processId: string, exitCode: number | null): Promise<void> {
    if (this.isShuttingDown) return;

    const proc = await this.adapter.get(processId);
    if (!proc) return;

    // If we're intentionally stopping, don't treat as crash
    if (proc.status === "stopping" || proc.status === "stopped") {
      return;
    }

    console.log(`[Processes] Process ${proc.name} (${processId}) exited with code ${exitCode}`);

    // Increment consecutive failures
    const newConsecutiveFailures = proc.consecutiveFailures + 1;

    // Unexpected crash
    await this.adapter.update(processId, {
      status: "crashed",
      stoppedAt: new Date(),
      consecutiveFailures: newConsecutiveFailures,
      error: `Exited with code ${exitCode}`,
    });

    // Cleanup
    await this.socketServer.closeSocket(processId);
    this.subprocesses.delete(processId);

    // Emit event
    await this.emitEvent("process.crashed", {
      processId,
      name: proc.name,
      exitCode,
    });

    // Call definition callback
    const definition = this.definitions.get(proc.name);
    if (definition?.onCrash) {
      await definition.onCrash(proc, exitCode);
    }

    // Handle auto-restart with updated consecutive failures
    const updatedProc = { ...proc, consecutiveFailures: newConsecutiveFailures };
    await this.handleAutoRestart(processId, updatedProc);
  }

  private async handleAutoRestart(processId: string, proc: ManagedProcess): Promise<void> {
    const config = proc.config;
    if (!config.autoRestart) return;

    const maxRestarts = config.maxRestarts ?? 10;
    if (maxRestarts !== -1 && proc.consecutiveFailures >= maxRestarts) {
      console.log(`[Processes] ${proc.name} (${processId}) reached max restarts (${maxRestarts})`);
      await this.adapter.update(processId, { status: "dead" });
      return;
    }

    // Calculate backoff delay
    const delay = calculateBackoff(proc.consecutiveFailures, config.backoff);
    console.log(`[Processes] Scheduling restart of ${proc.name} in ${Math.round(delay)}ms`);

    // Schedule restart
    const timeout = setTimeout(async () => {
      this.pendingRestarts.delete(processId);

      try {
        const newProcessId = await this.spawn(proc.name, {
          configOverrides: proc.config,
          metadata: proc.metadata,
        });

        // Preserve restart count
        await this.adapter.update(newProcessId, {
          restartCount: proc.restartCount + 1,
          consecutiveFailures: proc.consecutiveFailures,
        });

        const newProcess = await this.adapter.get(newProcessId);
        const definition = this.definitions.get(proc.name);
        if (definition?.onRestart && newProcess) {
          await definition.onRestart(proc, newProcess, proc.restartCount + 1);
        }

        await this.emitEvent("process.restarted", {
          oldProcessId: processId,
          newProcessId,
          name: proc.name,
          attempt: proc.restartCount + 1,
        });
      } catch (err) {
        console.error(`[Processes] Failed to restart ${proc.name}:`, err);
      }
    }, delay);

    this.pendingRestarts.set(processId, timeout);
  }

  private async reconcileOrphans(): Promise<void> {
    console.log("[Processes] Checking for orphaned processes...");
    const orphaned = await this.adapter.getOrphaned();

    if (orphaned.length === 0) {
      console.log("[Processes] No orphaned processes found");
      return;
    }

    // Reserve socket paths for potential reconnection
    const activeIds = new Set<string>();
    for (const proc of orphaned) {
      if (proc.socketPath || proc.tcpPort) {
        this.socketServer.reserve(proc.id, proc.socketPath, proc.tcpPort);
        activeIds.add(proc.id);
      }
    }

    // Clean orphaned socket files not belonging to our processes
    await this.socketServer.cleanOrphanedSockets(activeIds);

    for (const proc of orphaned) {
      if (proc.pid && isProcessAlive(proc.pid)) {
        // Process is still running! Try to reconnect
        console.log(`[Processes] Found orphaned process ${proc.name} (${proc.id}) with PID ${proc.pid}`);

        const reconnected = await this.socketServer.reconnect(
          proc.id,
          proc.socketPath,
          proc.tcpPort
        );

        if (reconnected) {
          await this.adapter.update(proc.id, { status: "running" });
          await this.emitEvent("process.reconnected", {
            processId: proc.id,
            name: proc.name,
            pid: proc.pid,
          });
          console.log(`[Processes] Reconnected to ${proc.name} (${proc.id})`);
        } else {
          // Couldn't reconnect, mark as orphaned
          await this.adapter.update(proc.id, { status: "orphaned" });
          console.log(`[Processes] Could not reconnect to ${proc.name} (${proc.id}), marked as orphaned`);

          // Try auto-restart if configured
          const definition = this.definitions.get(proc.name);
          if (definition?.config.autoRestart) {
            console.log(`[Processes] Killing orphaned process and restarting ${proc.name}`);
            try {
              process.kill(proc.pid, "SIGKILL");
            } catch {
              // Process may have already exited
            }
            await this.handleAutoRestart(proc.id, proc);
          }
        }
      } else {
        // Process is dead
        console.log(`[Processes] Orphaned process ${proc.name} (${proc.id}) is dead`);
        await this.adapter.update(proc.id, { status: "dead", stoppedAt: new Date() });
        this.socketServer.release(proc.id);

        // Try auto-restart if configured
        const definition = this.definitions.get(proc.name);
        if (definition?.config.autoRestart) {
          await this.handleAutoRestart(proc.id, proc);
        }
      }
    }
  }

  private startHeartbeatMonitor(): void {
    if (this.useWatchdog) return;
    this.heartbeatMonitor = setInterval(async () => {
      if (this.isShuttingDown) return;

      const running = await this.adapter.getRunning();
      const now = Date.now();

      for (const proc of running) {
        const heartbeatConfig = proc.config.heartbeat;
        if (!heartbeatConfig) continue;

        const timeoutMs = heartbeatConfig.timeoutMs ?? 60000;
        const lastHeartbeat = proc.lastHeartbeat?.getTime() ?? proc.startedAt?.getTime() ?? 0;

        if (now - lastHeartbeat > timeoutMs) {
          console.warn(`[Processes] Heartbeat missed for ${proc.name} (${proc.id})`);

          await this.emitEvent("process.heartbeat_missed", {
            processId: proc.id,
            name: proc.name,
          });
          await this.emitEvent("process.watchdog.stale", {
            processId: proc.id,
            name: proc.name,
            reason: "heartbeat",
            timeoutMs,
          });

          const definition = this.definitions.get(proc.name);
          if (definition?.onUnhealthy) {
            await definition.onUnhealthy(proc);
          }

          // If heartbeat is way overdue (2x timeout), stop and restart
          if (now - lastHeartbeat > timeoutMs * 2) {
            console.warn(`[Processes] Stopping unresponsive process ${proc.name} (${proc.id})`);
            await this.stop(proc.id);
            await this.emitEvent("process.watchdog.killed", {
              processId: proc.id,
              name: proc.name,
              reason: "heartbeat",
            });
            // handleExit will trigger auto-restart if configured
          }
        }
      }
    }, this.heartbeatCheckInterval);
  }

  private async emitEvent(eventName: string, data: any): Promise<void> {
    if (this.events) {
      await this.events.emit(eventName, data);
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createProcesses(config?: ProcessesConfig): Processes {
  return new ProcessesImpl(config);
}
