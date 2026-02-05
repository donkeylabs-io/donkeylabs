// Core Jobs Service
// Background job queue with scheduling
// Supports both in-process handlers and external processes (Python, Go, Shell, etc.)

import type { Events } from "./events";
import type { Logger, LogLevel } from "./logger";
import type {
  ExternalJobConfig,
  ExternalJob,
  ExternalJobProcessState,
  ExternalJobsConfig,
  AnyExternalJobMessage,
} from "./external-jobs";
import {
  isProcessAlive,
  isExternalJob,
  isProgressMessage,
  isHeartbeatMessage,
  isLogMessage,
  isCompletedMessage,
  isFailedMessage,
  isStartedMessage,
  createInitialPayload,
} from "./external-jobs";
import {
  createExternalJobSocketServer,
  type ExternalJobSocketServer,
} from "./external-job-socket";
import { SqliteJobAdapter } from "./job-adapter-sqlite";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "scheduled";

export interface Job {
  id: string;
  name: string;
  data: any;
  status: JobStatus;
  createdAt: Date;
  runAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: any;
  error?: string;
  attempts: number;
  maxAttempts: number;
  // External job fields (null/undefined for in-process jobs)
  /** Flag indicating this is an external job */
  external?: boolean;
  /** Process ID of the external process */
  pid?: number;
  /** Unix socket path for communication */
  socketPath?: string;
  /** TCP port for Windows fallback */
  tcpPort?: number;
  /** Timestamp of last heartbeat */
  lastHeartbeat?: Date;
  /** Current process state */
  processState?: ExternalJobProcessState;
}

export interface JobHandler<T = any, R = any> {
  (data: T, ctx?: JobHandlerContext): Promise<R>;
}

export interface JobHandlerContext {
  logger?: Logger;
  emit?: (event: string, data?: Record<string, any>) => Promise<void>;
  log?: (level: LogLevel, message: string, data?: Record<string, any>) => void;
}

/** Options for listing all jobs */
export interface GetAllJobsOptions {
  /** Filter by status */
  status?: JobStatus;
  /** Filter by job name */
  name?: string;
  /** Max number of jobs to return (default: 100) */
  limit?: number;
  /** Skip first N jobs (for pagination) */
  offset?: number;
}

export interface JobAdapter {
  create(job: Omit<Job, "id">): Promise<Job>;
  get(jobId: string): Promise<Job | null>;
  update(jobId: string, updates: Partial<Job>): Promise<void>;
  delete(jobId: string): Promise<boolean>;
  getPending(limit?: number): Promise<Job[]>;
  getScheduledReady(now: Date): Promise<Job[]>;
  getByName(name: string, status?: JobStatus): Promise<Job[]>;
  /** Get all running external jobs */
  getRunningExternal(): Promise<Job[]>;
  /** Get external jobs that need reconnection after server restart */
  getOrphanedExternal(): Promise<Job[]>;
  /** Get all jobs with optional filtering (for admin dashboard) */
  getAll(options?: GetAllJobsOptions): Promise<Job[]>;
  /** Atomically claim a pending job (returns true if successfully claimed) */
  claim(jobId: string): Promise<boolean>;
}

export interface JobsConfig {
  adapter?: JobAdapter;
  events?: Events;
  logger?: Logger;
  concurrency?: number; // Max concurrent jobs, default 5
  pollInterval?: number; // ms, default 1000
  maxAttempts?: number; // Default retry attempts, default 3
  /** External jobs configuration */
  external?: ExternalJobsConfig;
  /**
   * Use SQLite for persistence (default: true when external jobs are used)
   * Set to false to use MemoryJobAdapter (not recommended for production)
   */
  persist?: boolean;
  /** SQLite database path (default: .donkeylabs/jobs.db) */
  dbPath?: string;
  /**
   * Retry backoff configuration.
   * Set to false to disable backoff (immediate retry).
   * Default: exponential backoff starting at 1000ms, max 300000ms (5 min)
   */
  retryBackoff?: false | { baseMs?: number; maxMs?: number };
}

export interface Jobs {
  /** Register an in-process job handler */
  register<T = any, R = any>(name: string, handler: JobHandler<T, R>): void;
  /** Register an external job (Python, Go, Shell, etc.) */
  registerExternal(name: string, config: ExternalJobConfig): void;
  /** Enqueue a job (works for both in-process and external jobs) */
  enqueue<T = any>(name: string, data: T, options?: { maxAttempts?: number }): Promise<string>;
  /** Schedule a job to run at a specific time */
  schedule<T = any>(name: string, data: T, runAt: Date, options?: { maxAttempts?: number }): Promise<string>;
  /** Get a job by ID */
  get(jobId: string): Promise<Job | null>;
  /** Cancel a pending job */
  cancel(jobId: string): Promise<boolean>;
  /** Get jobs by name and optionally filter by status */
  getByName(name: string, status?: JobStatus): Promise<Job[]>;
  /** Get all running external jobs */
  getRunningExternal(): Promise<Job[]>;
  /** Get all jobs with optional filtering (for admin dashboard) */
  getAll(options?: GetAllJobsOptions): Promise<Job[]>;
  /** Start the job processing loop */
  start(): void;
  /** Stop the job processing and cleanup */
  stop(): Promise<void>;
}

// In-memory job adapter
export class MemoryJobAdapter implements JobAdapter {
  private jobs = new Map<string, Job>();
  private counter = 0;

  async create(job: Omit<Job, "id">): Promise<Job> {
    const id = `job_${++this.counter}_${Date.now()}`;
    const fullJob: Job = { ...job, id };
    this.jobs.set(id, fullJob);
    return fullJob;
  }

  async get(jobId: string): Promise<Job | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async update(jobId: string, updates: Partial<Job>): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) {
      Object.assign(job, updates);
    }
  }

  async delete(jobId: string): Promise<boolean> {
    return this.jobs.delete(jobId);
  }

  async getPending(limit: number = 100): Promise<Job[]> {
    const pending: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "pending") {
        pending.push(job);
        if (pending.length >= limit) break;
      }
    }
    return pending;
  }

  async getScheduledReady(now: Date): Promise<Job[]> {
    const ready: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "scheduled" && job.runAt && job.runAt <= now) {
        ready.push(job);
      }
    }
    return ready;
  }

  async getByName(name: string, status?: JobStatus): Promise<Job[]> {
    const results: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.name === name && (!status || job.status === status)) {
        results.push(job);
      }
    }
    return results;
  }

  async getRunningExternal(): Promise<Job[]> {
    const results: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.external && job.status === "running") {
        results.push(job);
      }
    }
    return results;
  }

  async getOrphanedExternal(): Promise<Job[]> {
    const results: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.external && (job.processState === "orphaned" || job.processState === "running")) {
        results.push(job);
      }
    }
    return results;
  }

  async getAll(options: GetAllJobsOptions = {}): Promise<Job[]> {
    const { status, name, limit = 100, offset = 0 } = options;
    const results: Job[] = [];

    for (const job of this.jobs.values()) {
      if (status && job.status !== status) continue;
      if (name && job.name !== name) continue;
      results.push(job);
    }

    // Sort by createdAt descending (newest first)
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Apply pagination
    return results.slice(offset, offset + limit);
  }

  async claim(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending") return false;
    job.status = "running";
    job.startedAt = new Date();
    return true;
  }
}

class JobsImpl implements Jobs {
  private adapter: JobAdapter;
  private sqliteAdapter?: SqliteJobAdapter;
  private events?: Events;
  private logger?: Logger;
  private handlers = new Map<string, JobHandler>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeJobs = 0;
  private concurrency: number;
  private pollInterval: number;
  private defaultMaxAttempts: number;
  private usePersistence: boolean;
  private dbPath?: string;
  private tickRunning = false; // Reentrancy guard for tick()
  private retryBackoff: false | { baseMs: number; maxMs: number };

  // External jobs support
  private externalConfigs = new Map<string, ExternalJobConfig>();
  private externalConfig: ExternalJobsConfig;
  private socketServer: ExternalJobSocketServer | null = null;
  private externalProcesses = new Map<
    string,
    { pid: number; timeout?: ReturnType<typeof setTimeout>; killTimer?: ReturnType<typeof setTimeout> }
  >();

  constructor(config: JobsConfig = {}) {
    this.events = config.events;
    this.logger = config.logger;
    this.concurrency = config.concurrency ?? 5;
    this.pollInterval = config.pollInterval ?? 1000;
    this.defaultMaxAttempts = config.maxAttempts ?? 3;
    this.externalConfig = config.external ?? {};
    this.usePersistence = config.persist ?? true; // Default to SQLite persistence
    this.dbPath = config.dbPath;
    // Configure retry backoff
    if (config.retryBackoff === false) {
      this.retryBackoff = false;
    } else if (config.retryBackoff) {
      this.retryBackoff = {
        baseMs: config.retryBackoff.baseMs ?? 1000,
        maxMs: config.retryBackoff.maxMs ?? 300000,
      };
    } else {
      // Default: exponential backoff
      this.retryBackoff = { baseMs: 1000, maxMs: 300000 };
    }

    // Use provided adapter, or create SQLite adapter if persistence enabled
    if (config.adapter) {
      this.adapter = config.adapter;
    } else if (this.usePersistence) {
      this.sqliteAdapter = new SqliteJobAdapter({ path: this.dbPath });
      this.adapter = this.sqliteAdapter;
    } else {
      this.adapter = new MemoryJobAdapter();
    }
  }

  register<T = any, R = any>(name: string, handler: JobHandler<T, R>): void {
    if (this.handlers.has(name) || this.externalConfigs.has(name)) {
      throw new Error(`Job handler "${name}" is already registered`);
    }
    this.handlers.set(name, handler);
  }

  registerExternal(name: string, config: ExternalJobConfig): void {
    if (this.handlers.has(name) || this.externalConfigs.has(name)) {
      throw new Error(`Job handler "${name}" is already registered`);
    }
    this.externalConfigs.set(name, config);
  }

  private isExternalJob(name: string): boolean {
    return this.externalConfigs.has(name);
  }

  async enqueue<T = any>(name: string, data: T, options: { maxAttempts?: number } = {}): Promise<string> {
    const isExternal = this.isExternalJob(name);

    if (!isExternal && !this.handlers.has(name)) {
      throw new Error(`No handler registered for job "${name}"`);
    }

    const job = await this.adapter.create({
      name,
      data,
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.defaultMaxAttempts,
      external: isExternal || undefined,
      processState: isExternal ? "spawning" : undefined,
    });

    return job.id;
  }

  async schedule<T = any>(
    name: string,
    data: T,
    runAt: Date,
    options: { maxAttempts?: number } = {}
  ): Promise<string> {
    const isExternal = this.isExternalJob(name);

    if (!isExternal && !this.handlers.has(name)) {
      throw new Error(`No handler registered for job "${name}"`);
    }

    const job = await this.adapter.create({
      name,
      data,
      status: "scheduled",
      createdAt: new Date(),
      runAt,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.defaultMaxAttempts,
      external: isExternal || undefined,
      processState: isExternal ? "spawning" : undefined,
    });

    return job.id;
  }

  async get(jobId: string): Promise<Job | null> {
    return this.adapter.get(jobId);
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = await this.adapter.get(jobId);
    if (!job) return false;

    if (job.status === "running") {
      // For external jobs, we can try to kill the process
      if (job.external && job.pid) {
        try {
          process.kill(job.pid, "SIGTERM");
        } catch {
          // Process may already be dead
        }
        await this.cleanupExternalJob(jobId);
      } else {
        // Can't cancel running in-process job
        return false;
      }
    }

    return this.adapter.delete(jobId);
  }

  async getByName(name: string, status?: JobStatus): Promise<Job[]> {
    return this.adapter.getByName(name, status);
  }

  async getRunningExternal(): Promise<Job[]> {
    return this.adapter.getRunningExternal();
  }

  async getAll(options?: GetAllJobsOptions): Promise<Job[]> {
    return this.adapter.getAll(options);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Initialize socket server for external jobs
    if (this.externalConfigs.size > 0) {
      this.initializeSocketServer();
      this.startHeartbeatMonitor();
      // Attempt to reconnect to orphaned jobs from previous run
      this.reconnectOrphanedJobs();
    }

    this.timer = setInterval(() => this.tick(), this.pollInterval);
    // Run immediately too
    this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Wait for any in-progress tick to complete
    const tickWaitStart = Date.now();
    while (this.tickRunning && Date.now() - tickWaitStart < 5000) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Cleanup external job processes
    for (const [jobId, procInfo] of this.externalProcesses) {
      if (procInfo.timeout) {
        clearTimeout(procInfo.timeout);
      }
      try {
        process.kill(procInfo.pid, "SIGTERM");
      } catch {
        // Process may already be dead
      }
    }
    this.externalProcesses.clear();

    // Shutdown socket server
    if (this.socketServer) {
      await this.socketServer.shutdown();
      this.socketServer = null;
    }

    // Stop SQLite adapter cleanup timer
    if (this.sqliteAdapter) {
      this.sqliteAdapter.stop();
    }

    // Stop adapter (cleanup timers and prevent further DB access)
    // This handles KyselyJobAdapter and other adapters with stop() method
    if (this.adapter && typeof (this.adapter as any).stop === "function") {
      (this.adapter as any).stop();
    }

    // Wait for active in-process jobs to complete (with timeout)
    const maxWait = 30000; // 30 seconds
    const startTime = Date.now();
    while (this.activeJobs > 0 && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private initializeSocketServer(): void {
    this.socketServer = createExternalJobSocketServer(this.externalConfig, {
      onMessage: (msg) => this.handleExternalMessage(msg),
      onConnect: (jobId) => {
        console.log(`[Jobs] External job ${jobId} connected`);
      },
      onDisconnect: (jobId) => {
        console.log(`[Jobs] External job ${jobId} disconnected`);
        // Check if the job is still running and mark as orphaned if so
        this.handleExternalDisconnect(jobId);
      },
      onError: (err, jobId) => {
        console.error(`[Jobs] External job socket error:`, err, jobId);
      },
    });
  }

  private startHeartbeatMonitor(): void {
    const checkInterval = this.externalConfig.heartbeatCheckInterval ?? 10000;

    this.heartbeatTimer = setInterval(async () => {
      await this.checkHeartbeats();
    }, checkInterval);
  }

  private async checkHeartbeats(): Promise<void> {
    try {
      const runningExternal = await this.adapter.getRunningExternal();
      const now = Date.now();

      for (const job of runningExternal) {
        if (!job.external || !job.lastHeartbeat) continue;

        const config = this.externalConfigs.get(job.name);
        const heartbeatTimeout = config?.heartbeatTimeout ?? this.externalConfig.defaultHeartbeatTimeout ?? 30000;
        const killGraceMs = config?.killGraceMs ?? this.externalConfig.killGraceMs ?? 5000;
        const timeSinceHeartbeat = now - job.lastHeartbeat.getTime();

        if (timeSinceHeartbeat > heartbeatTimeout) {
          // Job is stale
          console.warn(`[Jobs] External job ${job.id} is stale (no heartbeat for ${timeSinceHeartbeat}ms)`);

          if (this.events) {
            await this.events.emit("job.stale", {
              jobId: job.id,
              name: job.name,
              timeSinceHeartbeat,
            });
            await this.events.emit("job.watchdog.stale", {
              jobId: job.id,
              name: job.name,
              timeSinceHeartbeat,
            });
          }

          const procInfo = this.externalProcesses.get(job.id);
          if (job.pid && !procInfo?.killTimer) {
            console.error(`[Jobs] Terminating stale external job ${job.id}`);
            await this.terminateExternalProcess(
              job.id,
              job.pid,
              killGraceMs,
              "Heartbeat timeout - job process unresponsive"
            );
          }
        }
      }
    } catch (err) {
      console.error("[Jobs] Heartbeat check error:", err);
    }
  }

  private async reconnectOrphanedJobs(): Promise<void> {
    try {
      const orphaned = await this.adapter.getOrphanedExternal();
      const activeJobIds = new Set<string>();

      for (const job of orphaned) {
        if (!job.pid) {
          // No PID, mark as failed
          await this.adapter.update(job.id, {
            status: "failed",
            error: "Lost job state - no PID available",
            completedAt: new Date(),
          });
          continue;
        }

        // Check if process is still alive
        if (isProcessAlive(job.pid)) {
          console.log(`[Jobs] Found orphaned job ${job.id} with PID ${job.pid}, attempting reconnect`);
          activeJobIds.add(job.id);

          // Reserve the socket path/port to prevent new jobs from using it
          this.socketServer?.reserve(job.id, job.socketPath, job.tcpPort);

          // Try to reconnect to the socket
          const reconnected = await this.socketServer?.reconnect(
            job.id,
            job.socketPath,
            job.tcpPort
          );

          if (reconnected) {
            await this.adapter.update(job.id, {
              processState: "running",
              lastHeartbeat: new Date(),
            });

            if (this.events) {
              await this.events.emit("job.reconnected", {
                jobId: job.id,
                name: job.name,
              });
            }
          } else {
            // Mark as orphaned, but keep tracking (reservation remains)
            await this.adapter.update(job.id, { processState: "orphaned" });

            if (this.events) {
              await this.events.emit("job.lost", {
                jobId: job.id,
                name: job.name,
              });
            }
          }
        } else {
          // Process is dead, mark job as failed and release any reservations
          console.log(`[Jobs] Orphaned job ${job.id} process (PID ${job.pid}) is dead`);
          await this.adapter.update(job.id, {
            status: "failed",
            error: "Process died unexpectedly",
            completedAt: new Date(),
          });

          // Release reservation since the job is done
          this.socketServer?.release(job.id);

          if (this.events) {
            await this.events.emit("job.failed", {
              jobId: job.id,
              name: job.name,
              error: "Process died unexpectedly",
            });
          }
        }
      }

      // Clean orphaned socket files
      await this.socketServer?.cleanOrphanedSockets(activeJobIds);
    } catch (err) {
      console.error("[Jobs] Orphan reconnection error:", err);
    }
  }

  private async handleExternalMessage(message: AnyExternalJobMessage): Promise<void> {
    const job = await this.adapter.get(message.jobId);
    if (!job) {
      console.warn(`[Jobs] Received message for unknown job: ${message.jobId}`);
      return;
    }

    if (isStartedMessage(message)) {
      await this.adapter.update(message.jobId, {
        processState: "running",
        lastHeartbeat: new Date(message.timestamp),
      });

      if (this.events) {
        await this.events.emit("job.external.spawned", {
          jobId: message.jobId,
          name: job.name,
        });
      }
    } else if (isHeartbeatMessage(message)) {
      await this.adapter.update(message.jobId, {
        lastHeartbeat: new Date(message.timestamp),
      });
    } else if (isProgressMessage(message)) {
      await this.adapter.update(message.jobId, {
        lastHeartbeat: new Date(message.timestamp),
      });

      if (this.events) {
        await this.events.emit("job.external.progress", {
          jobId: message.jobId,
          name: job.name,
          percent: message.percent,
          message: message.message,
          data: message.data,
        });
      }
    } else if (isLogMessage(message)) {
      await this.adapter.update(message.jobId, {
        lastHeartbeat: new Date(message.timestamp),
      });

      if (this.events) {
        await this.events.emit("job.external.log", {
          jobId: message.jobId,
          name: job.name,
          level: message.level,
          message: message.message,
          data: message.data,
        });
      }
    } else if (isCompletedMessage(message)) {
      await this.adapter.update(message.jobId, {
        status: "completed",
        result: message.result,
        completedAt: new Date(message.timestamp),
      });

      await this.cleanupExternalJob(message.jobId);

      if (this.events) {
        await this.events.emit("job.completed", {
          jobId: message.jobId,
          name: job.name,
          result: message.result,
        });
        await this.events.emit(`job.${job.name}.completed`, {
          jobId: message.jobId,
          result: message.result,
        });
      }
    } else if (isFailedMessage(message)) {
      await this.adapter.update(message.jobId, {
        status: "failed",
        error: message.error,
        completedAt: new Date(message.timestamp),
      });

      await this.cleanupExternalJob(message.jobId);

      if (this.events) {
        await this.events.emit("job.failed", {
          jobId: message.jobId,
          name: job.name,
          error: message.error,
          stack: message.stack,
        });
        await this.events.emit(`job.${job.name}.failed`, {
          jobId: message.jobId,
          error: message.error,
          stack: message.stack,
        });
      }
    }
  }

  private async handleExternalDisconnect(jobId: string): Promise<void> {
    const job = await this.adapter.get(jobId);
    if (!job || job.status !== "running") return;

    // Mark as orphaned - the job might still be running
    await this.adapter.update(jobId, { processState: "orphaned" });
  }

  private async cleanupExternalJob(jobId: string): Promise<void> {
    // Clear any timeout
    const procInfo = this.externalProcesses.get(jobId);
    if (procInfo?.timeout) {
      clearTimeout(procInfo.timeout);
    }
    if (procInfo?.killTimer) {
      clearTimeout(procInfo.killTimer);
    }
    this.externalProcesses.delete(jobId);

    // Close the socket
    await this.socketServer?.closeSocket(jobId);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    // Reentrancy guard - prevent concurrent tick execution
    if (this.tickRunning) return;
    this.tickRunning = true;

    try {
      // Check running state before each async operation to exit quickly on stop()
      if (!this.running) return;

      // Process scheduled jobs that are ready
      const now = new Date();
      const scheduledReady = await this.adapter.getScheduledReady(now);

      if (!this.running) return;

      for (const job of scheduledReady) {
        if (!this.running) return;
        await this.adapter.update(job.id, { status: "pending" });
      }

      if (!this.running) return;

      // Process pending jobs
      const availableSlots = this.concurrency - this.activeJobs;
      if (availableSlots <= 0) return;

      const pending = await this.adapter.getPending(availableSlots);

      if (!this.running) return;

      for (const job of pending) {
        if (!this.running) break;
        if (this.activeJobs >= this.concurrency) break;

        // Atomic claim - prevent double execution
        const claimed = await this.adapter.claim(job.id);
        if (!claimed) continue; // Another process claimed it

        if (job.external) {
          this.processExternalJob(job);
        } else {
          this.processJob(job);
        }
      }
    } catch (err: any) {
      // Suppress "driver destroyed" errors which happen during test cleanup
      // when the database is garbage collected before the tick completes
      const isDriverDestroyed = err?.message?.includes("driver has already been destroyed");
      // Only log if we're still running and it's not a driver destroyed error
      if (this.running && !isDriverDestroyed) {
        console.error("[Jobs] Tick error:", err);
      }
    } finally {
      this.tickRunning = false; // Release guard
    }
  }

  private async processExternalJob(job: Job): Promise<void> {
    const config = this.externalConfigs.get(job.name);
    if (!config) {
      await this.adapter.update(job.id, {
        status: "failed",
        error: `No external config registered for job "${job.name}"`,
        completedAt: new Date(),
      });
      return;
    }

    this.activeJobs++;
    const startedAt = new Date();

    try {
      // Create socket for this job
      if (!this.socketServer) {
        this.initializeSocketServer();
      }

      const { socketPath, tcpPort } = await this.socketServer!.createSocket(job.id);

      // Job is already claimed (status=running, startedAt set)
      // Update with socket info and other external job fields
      await this.adapter.update(job.id, {
        attempts: job.attempts + 1,
        socketPath,
        tcpPort,
        processState: "spawning",
        lastHeartbeat: startedAt,
      });

      // Create initial payload
      const payload = createInitialPayload(
        job.id,
        job.name,
        job.data,
        socketPath ?? `tcp://127.0.0.1:${tcpPort}`
      );

      // Spawn the external process
      const env = {
        ...process.env,
        ...config.env,
        DONKEYLABS_JOB_ID: job.id,
        DONKEYLABS_JOB_NAME: job.name,
        DONKEYLABS_SOCKET_PATH: socketPath ?? "",
        DONKEYLABS_TCP_PORT: String(tcpPort ?? ""),
      };

      const proc = Bun.spawn([config.command, ...(config.args ?? [])], {
        cwd: config.cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      // Store process info
      this.externalProcesses.set(job.id, { pid: proc.pid });

      // Update job with PID
      await this.adapter.update(job.id, { pid: proc.pid });

      // Send payload via stdin
      proc.stdin.write(payload + "\n");
      proc.stdin.end();

      // Set up process timeout if configured
      if (config.timeout) {
        const timeout = setTimeout(async () => {
          console.warn(`[Jobs] External job ${job.id} timed out after ${config.timeout}ms`);
          const killGraceMs = config.killGraceMs ?? this.externalConfig.killGraceMs ?? 5000;
          await this.terminateExternalProcess(
            job.id,
            proc.pid,
            killGraceMs,
            `Job timed out after ${config.timeout}ms`
          );
        }, config.timeout);

        const procInfo = this.externalProcesses.get(job.id);
        if (procInfo) {
          procInfo.timeout = timeout;
        }
      }

      // Handle process exit
      proc.exited.then(async (code) => {
        // Only handle exit if job is still running (not already completed/failed via message)
        const currentJob = await this.adapter.get(job.id);
        if (currentJob?.status === "running") {
          if (code === 0) {
            // Process exited cleanly but didn't send completion message - mark as completed
            console.warn(`[Jobs] External job ${job.id} exited with code 0 but no completion message, marking completed`);
            await this.adapter.update(job.id, {
              status: "completed",
              completedAt: new Date(),
            });

            if (this.events) {
              await this.events.emit("job.completed", {
                jobId: job.id,
                name: job.name,
                result: undefined,
              });
            }
          } else {
            // Process failed
            await this.adapter.update(job.id, {
              status: "failed",
              error: `Process exited with code ${code}`,
              completedAt: new Date(),
            });

            if (this.events) {
              await this.events.emit("job.failed", {
                jobId: job.id,
                name: job.name,
                error: `Process exited with code ${code}`,
              });
            }
          }

          await this.cleanupExternalJob(job.id);
        }

        this.activeJobs--;
      });

      // Stream stdout/stderr to logs
      this.streamProcessOutput(job.id, job.name, proc);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      await this.adapter.update(job.id, {
        status: "failed",
        error,
        completedAt: new Date(),
      });

      await this.cleanupExternalJob(job.id);

      if (this.events) {
        await this.events.emit("job.failed", {
          jobId: job.id,
          name: job.name,
          error,
        });
      }

      this.activeJobs--;
    }
  }

  private async terminateExternalProcess(
    jobId: string,
    pid: number,
    killGraceMs: number,
    error: string
  ): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }

    if (killGraceMs <= 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
      await this.handleExternalFailure(jobId, error);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }

      await this.handleExternalFailure(jobId, error);
    }, killGraceMs);

    const procInfo = this.externalProcesses.get(jobId);
    if (procInfo) {
      procInfo.killTimer = timer;
    }
  }

  private async handleExternalFailure(jobId: string, error: string): Promise<void> {
    await this.adapter.update(jobId, {
      status: "failed",
      error,
      completedAt: new Date(),
      processState: "orphaned",
    });

    const job = await this.adapter.get(jobId);
    if (this.events && job) {
      await this.events.emit("job.watchdog.killed", {
        jobId,
        name: job.name,
        reason: error,
      });
    }

    await this.cleanupExternalJob(jobId);

    if (this.events && job) {
      await this.events.emit("job.failed", {
        jobId,
        name: job.name,
        error,
      });
    }
  }

  private streamProcessOutput(
    jobId: string,
    jobName: string,
    proc: ReturnType<typeof Bun.spawn>
  ): void {
    const decoder = new TextDecoder();
    const events = this.events;
    const scopedLogger = this.logger?.scoped("job", jobId);

    // Helper to stream a ReadableStream
    const streamOutput = async (
      stream: ReadableStream<Uint8Array> | undefined,
      level: "info" | "error"
    ) => {
      if (!stream) return;

      try {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value);
          if (level === "error") {
            console.error(`[Jobs:${jobId}] stderr:`, text.trim());
          } else {
            console.log(`[Jobs:${jobId}] stdout:`, text.trim());
          }

          if (events) {
            await events.emit("job.external.log", {
              jobId,
              name: jobName,
              level,
              message: text.trim(),
            });
          }

          if (scopedLogger) {
            scopedLogger[level](text.trim(), { external: true });
          }
        }
      } catch {
        // Stream may be closed
      }
    };

    // Stream stdout
    if (proc.stdout && typeof proc.stdout !== "number") {
      streamOutput(proc.stdout as ReadableStream<Uint8Array>, "info");
    }

    // Stream stderr
    if (proc.stderr && typeof proc.stderr !== "number") {
      streamOutput(proc.stderr as ReadableStream<Uint8Array>, "error");
    }
  }

  private async processJob(job: Job): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      await this.adapter.update(job.id, {
        status: "failed",
        error: `No handler registered for job "${job.name}"`,
        completedAt: new Date(),
      });
      return;
    }

    this.activeJobs++;

    try {
      // Job is already claimed (status=running, startedAt set)
      // Just update attempts
      await this.adapter.update(job.id, {
        attempts: job.attempts + 1,
      });

      // Create scoped logger for this job execution
      const scopedLogger = this.logger?.scoped("job", job.id);
      const emit = this.createJobEmitter(job);
      const log = scopedLogger
        ? (level: LogLevel, message: string, data?: Record<string, any>) => {
            scopedLogger[level](message, data);
          }
        : undefined;

      const result = await handler(job.data, {
        logger: scopedLogger,
        emit,
        log,
      });

      await this.adapter.update(job.id, {
        status: "completed",
        completedAt: new Date(),
        result,
      });

      // Emit completion event
      if (this.events) {
        await this.events.emit(`job.completed`, {
          jobId: job.id,
          name: job.name,
          result,
        });
        await this.events.emit(`job.${job.name}.completed`, {
          jobId: job.id,
          result,
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const attempts = job.attempts + 1;

      if (attempts < job.maxAttempts) {
        // Retry with optional exponential backoff
        if (this.retryBackoff === false) {
          // No backoff - immediate retry
          await this.adapter.update(job.id, {
            status: "pending",
            attempts,
            error,
          });
        } else {
          // Exponential backoff: delay = min(baseMs * 2^(attempts-1), maxMs)
          const { baseMs, maxMs } = this.retryBackoff;
          const backoffMs = Math.min(baseMs * Math.pow(2, attempts - 1), maxMs);
          const runAt = new Date(Date.now() + backoffMs);

          await this.adapter.update(job.id, {
            status: "scheduled",
            runAt,
            attempts,
            error,
          });
        }
      } else {
        // Max attempts reached, mark as failed
        await this.adapter.update(job.id, {
          status: "failed",
          completedAt: new Date(),
          attempts,
          error,
        });

        // Emit failure event
        if (this.events) {
          await this.events.emit(`job.failed`, {
            jobId: job.id,
            name: job.name,
            error,
            attempts,
          });
          await this.events.emit(`job.${job.name}.failed`, {
            jobId: job.id,
            error,
            attempts,
          });
        }
      }
    } finally {
      this.activeJobs--;
    }
  }

  private createJobEmitter(job: Job): JobHandlerContext["emit"] {
    const events = this.events;
    if (!events) return undefined;
    return async (event: string, data?: Record<string, any>) => {
      const payload = {
        jobId: job.id,
        name: job.name,
        event,
        data,
      };

      await events.emit("job.event", payload);
      await events.emit(`job.${job.name}.event`, payload);
      await events.emit(`job.${job.id}.event`, payload);
    };
  }
}

export function createJobs(config?: JobsConfig): Jobs {
  return new JobsImpl(config);
}
