// External Jobs Service
// Extends the Jobs system to support external processes written in any language

import type { Events } from "./events";
import type { Job, JobAdapter } from "./jobs";

// ============================================
// Message Protocol Types
// ============================================

export type ExternalJobMessageType =
  | "started"
  | "progress"
  | "heartbeat"
  | "log"
  | "completed"
  | "failed";

export interface ExternalJobMessage {
  type: ExternalJobMessageType;
  jobId: string;
  timestamp: number;
}

export interface StartedMessage extends ExternalJobMessage {
  type: "started";
}

export interface ProgressMessage extends ExternalJobMessage {
  type: "progress";
  percent: number;
  message?: string;
  data?: Record<string, any>;
}

export interface HeartbeatMessage extends ExternalJobMessage {
  type: "heartbeat";
}

export interface LogMessage extends ExternalJobMessage {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, any>;
}

export interface CompletedMessage extends ExternalJobMessage {
  type: "completed";
  result?: any;
}

export interface FailedMessage extends ExternalJobMessage {
  type: "failed";
  error: string;
  stack?: string;
}

export type AnyExternalJobMessage =
  | StartedMessage
  | ProgressMessage
  | HeartbeatMessage
  | LogMessage
  | CompletedMessage
  | FailedMessage;

// ============================================
// External Job Configuration
// ============================================

export interface ExternalJobConfig {
  /** Command to execute (e.g., "python", "node", "./script.sh") */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Working directory for the process */
  cwd?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Heartbeat timeout in milliseconds (default: 30000) */
  heartbeatTimeout?: number;
  /** Job timeout in milliseconds (optional) */
  timeout?: number;
  /** Grace period before SIGKILL when terminating (ms, default: 5000) */
  killGraceMs?: number;
}

// ============================================
// External Job State
// ============================================

export type ExternalJobProcessState =
  | "spawning"
  | "running"
  | "orphaned"
  | "reconnecting";

export interface ExternalJob extends Job {
  /** Flag indicating this is an external job */
  external: true;
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

// ============================================
// External Jobs Configuration
// ============================================

export interface ExternalJobsConfig {
  /** Directory for Unix sockets (default: /tmp/donkeylabs-jobs) */
  socketDir?: string;
  /** TCP port range for Windows fallback (default: [49152, 65535]) */
  tcpPortRange?: [number, number];
  /** Default heartbeat timeout in ms (default: 30000) */
  defaultHeartbeatTimeout?: number;
  /** Heartbeat check interval in ms (default: 10000) */
  heartbeatCheckInterval?: number;
  /** Default grace period before SIGKILL when terminating (ms, default: 5000) */
  killGraceMs?: number;
  /** Disable in-process watchdog timers (use external watchdog instead) */
  useWatchdog?: boolean;
}

// ============================================
// External Job Manager Interface
// ============================================

export interface ExternalJobManager {
  /** Register an external job configuration */
  registerExternal(name: string, config: ExternalJobConfig): void;
  /** Check if a job is registered as external */
  isExternal(name: string): boolean;
  /** Get external job configuration */
  getExternalConfig(name: string): ExternalJobConfig | undefined;
  /** Spawn an external job process */
  spawn(jobId: string, name: string, data: any): Promise<ExternalJob>;
  /** Handle message from external process */
  handleMessage(message: AnyExternalJobMessage): Promise<void>;
  /** Get all running external jobs */
  getRunningExternal(): Promise<ExternalJob[]>;
  /** Attempt to reconnect to orphaned jobs on server restart */
  reconnectOrphaned(): Promise<void>;
  /** Start the heartbeat monitoring loop */
  startHeartbeatMonitor(): void;
  /** Stop the heartbeat monitoring and cleanup */
  stop(): Promise<void>;
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
 * Generate a unique socket path for a job
 */
export function generateSocketPath(socketDir: string, jobId: string): string {
  return `${socketDir}/job_${jobId}.sock`;
}

/**
 * Parse a message from an external job process
 */
export function parseJobMessage(data: string): AnyExternalJobMessage | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed.type || !parsed.jobId || typeof parsed.timestamp !== "number") {
      return null;
    }
    return parsed as AnyExternalJobMessage;
  } catch {
    return null;
  }
}

/**
 * Create the initial payload to send to the external process via stdin
 */
export function createInitialPayload(
  jobId: string,
  name: string,
  data: any,
  socketPath: string
): string {
  return JSON.stringify({
    jobId,
    name,
    data,
    socketPath,
  });
}

// ============================================
// Type Guards
// ============================================

export function isExternalJob(job: Job): job is ExternalJob {
  return (job as ExternalJob).external === true;
}

export function isProgressMessage(msg: AnyExternalJobMessage): msg is ProgressMessage {
  return msg.type === "progress";
}

export function isHeartbeatMessage(msg: AnyExternalJobMessage): msg is HeartbeatMessage {
  return msg.type === "heartbeat";
}

export function isLogMessage(msg: AnyExternalJobMessage): msg is LogMessage {
  return msg.type === "log";
}

export function isCompletedMessage(msg: AnyExternalJobMessage): msg is CompletedMessage {
  return msg.type === "completed";
}

export function isFailedMessage(msg: AnyExternalJobMessage): msg is FailedMessage {
  return msg.type === "failed";
}

export function isStartedMessage(msg: AnyExternalJobMessage): msg is StartedMessage {
  return msg.type === "started";
}
