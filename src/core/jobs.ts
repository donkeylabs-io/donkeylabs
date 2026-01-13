// Core Jobs Service
// Background job queue with scheduling

import type { Events } from "./events";

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
}

export interface JobHandler<T = any, R = any> {
  (data: T): Promise<R>;
}

export interface JobAdapter {
  create(job: Omit<Job, "id">): Promise<Job>;
  get(jobId: string): Promise<Job | null>;
  update(jobId: string, updates: Partial<Job>): Promise<void>;
  delete(jobId: string): Promise<boolean>;
  getPending(limit?: number): Promise<Job[]>;
  getScheduledReady(now: Date): Promise<Job[]>;
  getByName(name: string, status?: JobStatus): Promise<Job[]>;
}

export interface JobsConfig {
  adapter?: JobAdapter;
  events?: Events;
  concurrency?: number; // Max concurrent jobs, default 5
  pollInterval?: number; // ms, default 1000
  maxAttempts?: number; // Default retry attempts, default 3
}

export interface Jobs {
  register<T = any, R = any>(name: string, handler: JobHandler<T, R>): void;
  enqueue<T = any>(name: string, data: T, options?: { maxAttempts?: number }): Promise<string>;
  schedule<T = any>(name: string, data: T, runAt: Date, options?: { maxAttempts?: number }): Promise<string>;
  get(jobId: string): Promise<Job | null>;
  cancel(jobId: string): Promise<boolean>;
  getByName(name: string, status?: JobStatus): Promise<Job[]>;
  start(): void;
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
}

class JobsImpl implements Jobs {
  private adapter: JobAdapter;
  private events?: Events;
  private handlers = new Map<string, JobHandler>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeJobs = 0;
  private concurrency: number;
  private pollInterval: number;
  private defaultMaxAttempts: number;

  constructor(config: JobsConfig = {}) {
    this.adapter = config.adapter ?? new MemoryJobAdapter();
    this.events = config.events;
    this.concurrency = config.concurrency ?? 5;
    this.pollInterval = config.pollInterval ?? 1000;
    this.defaultMaxAttempts = config.maxAttempts ?? 3;
  }

  register<T = any, R = any>(name: string, handler: JobHandler<T, R>): void {
    if (this.handlers.has(name)) {
      throw new Error(`Job handler "${name}" is already registered`);
    }
    this.handlers.set(name, handler);
  }

  async enqueue<T = any>(name: string, data: T, options: { maxAttempts?: number } = {}): Promise<string> {
    if (!this.handlers.has(name)) {
      throw new Error(`No handler registered for job "${name}"`);
    }

    const job = await this.adapter.create({
      name,
      data,
      status: "pending",
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.defaultMaxAttempts,
    });

    return job.id;
  }

  async schedule<T = any>(
    name: string,
    data: T,
    runAt: Date,
    options: { maxAttempts?: number } = {}
  ): Promise<string> {
    if (!this.handlers.has(name)) {
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
      // Can't cancel running job
      return false;
    }

    return this.adapter.delete(jobId);
  }

  async getByName(name: string, status?: JobStatus): Promise<Job[]> {
    return this.adapter.getByName(name, status);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

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

    // Wait for active jobs to complete (with timeout)
    const maxWait = 30000; // 30 seconds
    const start = Date.now();
    while (this.activeJobs > 0 && Date.now() - start < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      // Process scheduled jobs that are ready
      const now = new Date();
      const scheduledReady = await this.adapter.getScheduledReady(now);
      for (const job of scheduledReady) {
        await this.adapter.update(job.id, { status: "pending" });
      }

      // Process pending jobs
      const availableSlots = this.concurrency - this.activeJobs;
      if (availableSlots <= 0) return;

      const pending = await this.adapter.getPending(availableSlots);
      for (const job of pending) {
        if (this.activeJobs >= this.concurrency) break;
        this.processJob(job);
      }
    } catch (err) {
      console.error("[Jobs] Tick error:", err);
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
    const startedAt = new Date();

    try {
      await this.adapter.update(job.id, {
        status: "running",
        startedAt,
        attempts: job.attempts + 1,
      });

      const result = await handler(job.data);

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
        // Retry later
        await this.adapter.update(job.id, {
          status: "pending",
          attempts,
          error,
        });
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
}

export function createJobs(config?: JobsConfig): Jobs {
  return new JobsImpl(config);
}
