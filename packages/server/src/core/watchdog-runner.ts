import type { WorkflowAdapter, WorkflowInstance } from "./workflows";
import type { JobAdapter, Job } from "./jobs";
import type { ProcessAdapter } from "./process-adapter-sqlite";

export type WatchdogService = "workflows" | "jobs" | "processes";

export interface WatchdogRunnerConfig {
  services: WatchdogService[];
  killGraceMs: number;
  workflowHeartbeatTimeoutMs: number;
  jobDefaults: {
    heartbeatTimeoutMs: number;
    killGraceMs: number;
  };
  jobConfigs: Record<string, { heartbeatTimeout?: number; timeout?: number; killGraceMs?: number }>;
}

export interface WatchdogRunnerDeps {
  workflowsAdapter?: WorkflowAdapter;
  jobsAdapter?: JobAdapter;
  processesAdapter?: ProcessAdapter;
  now?: () => number;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive?: (pid: number) => boolean;
  emit?: (event: string, data: Record<string, any>) => Promise<void>;
}

export class WatchdogRunner {
  private config: WatchdogRunnerConfig;
  private deps: WatchdogRunnerDeps;

  constructor(config: WatchdogRunnerConfig, deps: WatchdogRunnerDeps) {
    this.config = config;
    this.deps = deps;
  }

  async runOnce(): Promise<void> {
    if (this.config.services.includes("workflows") && this.deps.workflowsAdapter) {
      await this.checkWorkflows();
    }
    if (this.config.services.includes("jobs") && this.deps.jobsAdapter) {
      await this.checkJobs();
    }
    if (this.config.services.includes("processes") && this.deps.processesAdapter) {
      await this.checkProcesses();
    }
  }

  private async checkWorkflows(): Promise<void> {
    const adapter = this.deps.workflowsAdapter!;
    const now = this.now();
    const instances = await adapter.getRunningInstances();

    for (const instance of instances) {
      const info = this.getWatchdogMetadata(instance);
      if (!info?.pid) continue;

      const last = info.lastHeartbeat ?? instance.startedAt?.getTime() ?? 0;
      if (now - last <= this.config.workflowHeartbeatTimeoutMs) continue;

      await this.emit("workflow.watchdog.stale", {
        instanceId: instance.id,
        pid: info.pid,
        timeoutMs: this.config.workflowHeartbeatTimeoutMs,
      });

      await this.killProcessWithGrace(info.pid, this.config.killGraceMs);

      await adapter.updateInstance(instance.id, {
        status: "failed",
        error: "Watchdog killed unresponsive workflow",
        completedAt: new Date(),
      });

      await this.emit("workflow.watchdog.killed", {
        instanceId: instance.id,
        pid: info.pid,
        reason: "heartbeat",
      });
    }
  }

  private async checkJobs(): Promise<void> {
    const adapter = this.deps.jobsAdapter!;
    const now = this.now();
    const jobs = await adapter.getRunningExternal();

    for (const job of jobs) {
      if (!job.pid) continue;
      const config = this.config.jobConfigs[job.name] ?? {};
      const heartbeatTimeout =
        config.heartbeatTimeout ?? this.config.jobDefaults.heartbeatTimeoutMs;
      const killGraceMs = config.killGraceMs ?? this.config.jobDefaults.killGraceMs;
      const lastHeartbeat = job.lastHeartbeat?.getTime() ?? job.startedAt?.getTime() ?? 0;

      if (now - lastHeartbeat > heartbeatTimeout) {
        await this.emit("job.watchdog.stale", {
          jobId: job.id,
          name: job.name,
          pid: job.pid,
          timeoutMs: heartbeatTimeout,
        });

        await this.killProcessWithGrace(job.pid, killGraceMs);

        await adapter.update(job.id, {
          status: "failed",
          error: "Watchdog killed unresponsive job",
          completedAt: new Date(),
          processState: "orphaned",
        });

        await this.emit("job.watchdog.killed", {
          jobId: job.id,
          name: job.name,
          pid: job.pid,
          reason: "heartbeat",
        });
        continue;
      }

      if (config.timeout && job.startedAt) {
        if (now - job.startedAt.getTime() > config.timeout) {
          await this.emit("job.watchdog.stale", {
            jobId: job.id,
            name: job.name,
            pid: job.pid,
            timeoutMs: config.timeout,
            reason: "timeout",
          });

          await this.killProcessWithGrace(job.pid, killGraceMs);

          await adapter.update(job.id, {
            status: "failed",
            error: "Watchdog killed job after timeout",
            completedAt: new Date(),
            processState: "orphaned",
          });

          await this.emit("job.watchdog.killed", {
            jobId: job.id,
            name: job.name,
            pid: job.pid,
            reason: "timeout",
          });
        }
      }
    }
  }

  private async checkProcesses(): Promise<void> {
    const adapter = this.deps.processesAdapter!;
    const now = this.now();
    const running = await adapter.getRunning();

    for (const proc of running) {
      if (!proc.pid) continue;
      const heartbeatTimeout = proc.config.heartbeat?.timeoutMs;
      const lastHeartbeat = proc.lastHeartbeat?.getTime() ?? proc.startedAt?.getTime() ?? 0;

      if (heartbeatTimeout && now - lastHeartbeat > heartbeatTimeout) {
        await this.emit("process.watchdog.stale", {
          processId: proc.id,
          name: proc.name,
          pid: proc.pid,
          timeoutMs: heartbeatTimeout,
        });

        await this.killProcessWithGrace(proc.pid, this.config.killGraceMs);

        await adapter.update(proc.id, {
          status: "crashed",
          error: "Watchdog killed unresponsive process",
          stoppedAt: new Date(),
        });

        await this.emit("process.watchdog.killed", {
          processId: proc.id,
          name: proc.name,
          pid: proc.pid,
          reason: "heartbeat",
        });
        continue;
      }

      const maxRuntimeMs = proc.config.limits?.maxRuntimeMs;
      if (maxRuntimeMs && proc.startedAt) {
        if (now - proc.startedAt.getTime() > maxRuntimeMs) {
          await this.emit("process.watchdog.stale", {
            processId: proc.id,
            name: proc.name,
            pid: proc.pid,
            timeoutMs: maxRuntimeMs,
            reason: "maxRuntimeMs",
          });

          await this.killProcessWithGrace(proc.pid, this.config.killGraceMs);

          await adapter.update(proc.id, {
            status: "crashed",
            error: "Watchdog killed process after max runtime",
            stoppedAt: new Date(),
          });

          await this.emit("process.watchdog.killed", {
            processId: proc.id,
            name: proc.name,
            pid: proc.pid,
            reason: "maxRuntimeMs",
          });
        }
      }
    }
  }

  private getWatchdogMetadata(instance: WorkflowInstance): { pid?: number; lastHeartbeat?: number } | null {
    const meta = instance.metadata as any;
    if (!meta || typeof meta !== "object") return null;
    const info = meta.__watchdog;
    if (!info || typeof info !== "object") return null;
    return {
      pid: typeof info.pid === "number" ? info.pid : undefined,
      lastHeartbeat: info.lastHeartbeat ? new Date(info.lastHeartbeat).getTime() : undefined,
    };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async emit(event: string, data: Record<string, any>): Promise<void> {
    if (this.deps.emit) {
      await this.deps.emit(event, data);
    }
  }

  private async killProcessWithGrace(pid: number, graceMs: number): Promise<void> {
    const kill = this.deps.killProcess ?? process.kill;
    try {
      kill(pid, "SIGTERM");
    } catch {
      return;
    }

    if (graceMs <= 0) {
      try {
        kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, graceMs));

    try {
      const isAlive = this.deps.isProcessAlive
        ? this.deps.isProcessAlive(pid)
        : (() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })();

      if (isAlive) {
        kill(pid, "SIGKILL");
      }
    } catch {
      // ignore
    }
  }
}
