/**
 * Core Event Map
 *
 * Single source of truth for all core service event types.
 * These events are emitted by workflows, jobs, processes, cron, and logs.
 * They are always available in EventRegistry without code generation.
 */

import type { ProcessStats } from "./processes";
import type { PersistentLogEntry } from "./logs";

export interface CoreEventMap {
  // Workflow events
  "workflow.started": { instanceId: string; workflowName: string; input: any };
  "workflow.completed": { instanceId: string; output: any };
  "workflow.failed": { instanceId: string; workflowName: string; error: string };
  "workflow.cancelled": { instanceId: string; workflowName: string };
  "workflow.progress": { instanceId: string; progress: number; currentStep: string; completedSteps: number; totalSteps: number };
  "workflow.event": { instanceId: string; workflowName: string; event: string; data: any };
  "workflow.step.started": { instanceId: string; stepName: string; stepType: string };
  "workflow.step.completed": { instanceId: string; stepName: string; output: any };
  "workflow.step.failed": { instanceId: string; stepName: string; error: string; attempts: number };
  "workflow.step.poll": { instanceId: string; stepName: string; pollCount: number; done: boolean; result: any };
  "workflow.step.loop": { instanceId: string; stepName: string; loopCount: number; target: string };
  "workflow.step.retry": { instanceId: string; stepName: string; attempt: number; maxAttempts: number; delay: number };
  "workflow.watchdog.stale": { instanceId: string; reason: string; timeoutMs: number };
  "workflow.watchdog.killed": { instanceId: string; reason: string; timeoutMs: number };

  // Job events
  "job.completed": { jobId: string; name: string; result: any };
  "job.failed": { jobId: string; name: string; error: string; attempts?: number; stack?: string };
  "job.stale": { jobId: string; name: string; timeSinceHeartbeat: number };
  "job.reconnected": { jobId: string; name: string };
  "job.lost": { jobId: string; name: string };
  "job.event": { jobId: string; name: string; event: string; data?: any };
  "job.external.spawned": { jobId: string; name: string };
  "job.external.progress": { jobId: string; name: string; percent: number; message: string; data: any };
  "job.external.log": { jobId: string; name: string; level: string; message: string; data?: any };
  "job.watchdog.stale": { jobId: string; name: string; timeSinceHeartbeat: number };
  "job.watchdog.killed": { jobId: string; name: string; reason: string };

  // Process events
  "process.spawned": { processId: string; name: string; pid: number };
  "process.stopped": { processId: string; name: string };
  "process.crashed": { processId: string; name: string; exitCode: number | null };
  "process.restarted": { oldProcessId: string; newProcessId: string; name: string; attempt: number };
  "process.reconnected": { processId: string; name: string; pid: number };
  "process.stats": { processId: string; name: string; stats: ProcessStats };
  "process.limits_exceeded": { processId: string; name: string; reason: string; limit: number; value?: number };
  "process.heartbeat_missed": { processId: string; name: string };
  "process.event": { processId: string; name: string; event: string; data: any };
  "process.message": { processId: string; name: string; message: any };
  "process.watchdog.stale": { processId: string; name: string; reason: string; timeoutMs: number };
  "process.watchdog.killed": { processId: string; name: string; reason: string; value?: number };

  // Cron events
  "cron.event": { taskId: string; name: string; event: string; data?: any };

  // Log events
  "log.created": PersistentLogEntry;
}

/**
 * Serializable core event definitions for CLI type generation.
 * Maps event name to TypeScript type string (used by `donkeylabs generate`).
 */
export const CORE_EVENT_DEFINITIONS: Record<string, string> = {
  // Workflow events
  "workflow.started": "{ instanceId: string; workflowName: string; input: any }",
  "workflow.completed": "{ instanceId: string; output: any }",
  "workflow.failed": "{ instanceId: string; workflowName: string; error: string }",
  "workflow.cancelled": "{ instanceId: string; workflowName: string }",
  "workflow.progress": "{ instanceId: string; progress: number; currentStep: string; completedSteps: number; totalSteps: number }",
  "workflow.event": "{ instanceId: string; workflowName: string; event: string; data: any }",
  "workflow.step.started": "{ instanceId: string; stepName: string; stepType: string }",
  "workflow.step.completed": "{ instanceId: string; stepName: string; output: any }",
  "workflow.step.failed": "{ instanceId: string; stepName: string; error: string; attempts: number }",
  "workflow.step.poll": "{ instanceId: string; stepName: string; pollCount: number; done: boolean; result: any }",
  "workflow.step.loop": "{ instanceId: string; stepName: string; loopCount: number; target: string }",
  "workflow.step.retry": "{ instanceId: string; stepName: string; attempt: number; maxAttempts: number; delay: number }",
  "workflow.watchdog.stale": "{ instanceId: string; reason: string; timeoutMs: number }",
  "workflow.watchdog.killed": "{ instanceId: string; reason: string; timeoutMs: number }",

  // Job events
  "job.completed": "{ jobId: string; name: string; result: any }",
  "job.failed": "{ jobId: string; name: string; error: string; attempts?: number; stack?: string }",
  "job.stale": "{ jobId: string; name: string; timeSinceHeartbeat: number }",
  "job.reconnected": "{ jobId: string; name: string }",
  "job.lost": "{ jobId: string; name: string }",
  "job.event": "{ jobId: string; name: string; event: string; data?: any }",
  "job.external.spawned": "{ jobId: string; name: string }",
  "job.external.progress": "{ jobId: string; name: string; percent: number; message: string; data: any }",
  "job.external.log": "{ jobId: string; name: string; level: string; message: string; data?: any }",
  "job.watchdog.stale": "{ jobId: string; name: string; timeSinceHeartbeat: number }",
  "job.watchdog.killed": "{ jobId: string; name: string; reason: string }",

  // Process events
  "process.spawned": "{ processId: string; name: string; pid: number }",
  "process.stopped": "{ processId: string; name: string }",
  "process.crashed": "{ processId: string; name: string; exitCode: number | null }",
  "process.restarted": "{ oldProcessId: string; newProcessId: string; name: string; attempt: number }",
  "process.reconnected": "{ processId: string; name: string; pid: number }",
  "process.stats": "{ processId: string; name: string; stats: { cpu: { user: number; system: number; percent: number }; memory: { rss: number; heapTotal: number; heapUsed: number; external: number }; uptime: number } }",
  "process.limits_exceeded": "{ processId: string; name: string; reason: string; limit: number; value?: number }",
  "process.heartbeat_missed": "{ processId: string; name: string }",
  "process.event": "{ processId: string; name: string; event: string; data: any }",
  "process.message": "{ processId: string; name: string; message: any }",
  "process.watchdog.stale": "{ processId: string; name: string; reason: string; timeoutMs: number }",
  "process.watchdog.killed": "{ processId: string; name: string; reason: string; value?: number }",

  // Cron events
  "cron.event": "{ taskId: string; name: string; event: string; data?: any }",

  // Log events
  "log.created": "{ id: string; timestamp: Date; level: string; message: string; source: string; sourceId?: string; tags?: string[]; data?: Record<string, any>; context?: Record<string, any> }",
};
