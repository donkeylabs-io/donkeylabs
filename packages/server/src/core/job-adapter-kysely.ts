/**
 * Kysely Job Adapter
 *
 * Implements the JobAdapter interface using Kysely for the shared app database.
 * This replaces the standalone SqliteJobAdapter that used a separate .donkeylabs/jobs.db file.
 */

import type { Kysely } from "kysely";
import type { Job, JobAdapter, JobStatus, GetAllJobsOptions } from "./jobs";
import type { ExternalJobProcessState } from "./external-jobs";

export interface KyselyJobAdapterConfig {
  /** Auto-cleanup completed jobs older than N days (default: 7, 0 to disable) */
  cleanupDays?: number;
  /** Cleanup interval in ms (default: 3600000 = 1 hour) */
  cleanupInterval?: number;
}

// Table type for Kysely
interface JobsTable {
  id: string;
  name: string;
  data: string;
  status: string;
  created_at: string;
  run_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result: string | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  external: number;
  pid: number | null;
  socket_path: string | null;
  tcp_port: number | null;
  last_heartbeat: string | null;
  process_state: string | null;
}

interface Database {
  __donkeylabs_jobs__: JobsTable;
}

export class KyselyJobAdapter implements JobAdapter {
  private db: Kysely<Database>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupDays: number;
  private stopped = false;

  constructor(db: Kysely<any>, config: KyselyJobAdapterConfig = {}) {
    this.db = db as Kysely<Database>;
    this.cleanupDays = config.cleanupDays ?? 7;

    // Start cleanup timer (don't run immediately - tables may not exist yet before migrations)
    if (this.cleanupDays > 0) {
      const interval = config.cleanupInterval ?? 3600000; // 1 hour
      this.cleanupTimer = setInterval(() => this.cleanup(), interval);
    }
  }

  /** Check if adapter is stopped (for safe database access) */
  private checkStopped(): boolean {
    return this.stopped;
  }

  async create(job: Omit<Job, "id">): Promise<Job> {
    if (this.checkStopped()) {
      throw new Error("JobAdapter has been stopped");
    }

    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    await this.db
      .insertInto("__donkeylabs_jobs__")
      .values({
        id,
        name: job.name,
        data: JSON.stringify(job.data),
        status: job.status,
        created_at: job.createdAt.toISOString(),
        run_at: job.runAt?.toISOString() ?? null,
        started_at: null,
        completed_at: null,
        result: null,
        error: null,
        attempts: job.attempts,
        max_attempts: job.maxAttempts,
        external: job.external ? 1 : 0,
        pid: null,
        socket_path: null,
        tcp_port: null,
        last_heartbeat: null,
        process_state: job.processState ?? null,
      })
      .execute();

    return { ...job, id };
  }

  async get(jobId: string): Promise<Job | null> {
    if (this.checkStopped()) return null;

    try {
      const row = await this.db
        .selectFrom("__donkeylabs_jobs__")
        .selectAll()
        .where("id", "=", jobId)
        .executeTakeFirst();

      if (!row) return null;
      return this.rowToJob(row);
    } catch (err: any) {
      // Silently ignore errors if adapter was stopped during query
      if (this.stopped && err?.message?.includes("destroyed")) return null;
      throw err;
    }
  }

  async update(jobId: string, updates: Partial<Job>): Promise<void> {
    if (this.checkStopped()) return;

    const updateData: Partial<JobsTable> = {};

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }
    if (updates.startedAt !== undefined) {
      updateData.started_at = updates.startedAt?.toISOString() ?? null;
    }
    if (updates.completedAt !== undefined) {
      updateData.completed_at = updates.completedAt?.toISOString() ?? null;
    }
    if (updates.result !== undefined) {
      updateData.result = JSON.stringify(updates.result);
    }
    if (updates.error !== undefined) {
      updateData.error = updates.error;
    }
    if (updates.attempts !== undefined) {
      updateData.attempts = updates.attempts;
    }
    // External job fields
    if (updates.pid !== undefined) {
      updateData.pid = updates.pid;
    }
    if (updates.socketPath !== undefined) {
      updateData.socket_path = updates.socketPath;
    }
    if (updates.tcpPort !== undefined) {
      updateData.tcp_port = updates.tcpPort;
    }
    if (updates.lastHeartbeat !== undefined) {
      updateData.last_heartbeat = updates.lastHeartbeat?.toISOString() ?? null;
    }
    if (updates.processState !== undefined) {
      updateData.process_state = updates.processState;
    }

    if (Object.keys(updateData).length === 0) return;

    try {
      await this.db
        .updateTable("__donkeylabs_jobs__")
        .set(updateData)
        .where("id", "=", jobId)
        .execute();
    } catch (err: any) {
      // Silently ignore errors if adapter was stopped during query
      if (this.stopped && err?.message?.includes("destroyed")) return;
      throw err;
    }
  }

  async delete(jobId: string): Promise<boolean> {
    if (this.checkStopped()) return false;

    // Check if exists first since BunSqliteDialect doesn't report numDeletedRows properly
    const exists = await this.db
      .selectFrom("__donkeylabs_jobs__")
      .select("id")
      .where("id", "=", jobId)
      .executeTakeFirst();

    if (!exists) return false;

    await this.db
      .deleteFrom("__donkeylabs_jobs__")
      .where("id", "=", jobId)
      .execute();

    return true;
  }

  async getPending(limit: number = 100): Promise<Job[]> {
    if (this.checkStopped()) return [];

    try {
      const rows = await this.db
        .selectFrom("__donkeylabs_jobs__")
        .selectAll()
        .where("status", "=", "pending")
        .orderBy("created_at", "asc")
        .limit(limit)
        .execute();

      return rows.map((r) => this.rowToJob(r));
    } catch (err: any) {
      // Silently ignore errors if adapter was stopped during query
      if (this.stopped && err?.message?.includes("destroyed")) return [];
      throw err;
    }
  }

  async getScheduledReady(now: Date): Promise<Job[]> {
    if (this.checkStopped()) return [];

    try {
      const rows = await this.db
        .selectFrom("__donkeylabs_jobs__")
        .selectAll()
        .where("status", "=", "scheduled")
        .where("run_at", "<=", now.toISOString())
        .orderBy("run_at", "asc")
        .execute();

      return rows.map((r) => this.rowToJob(r));
    } catch (err: any) {
      // Silently ignore errors if adapter was stopped during query
      if (this.stopped && err?.message?.includes("destroyed")) return [];
      throw err;
    }
  }

  async getByName(name: string, status?: JobStatus): Promise<Job[]> {
    if (this.checkStopped()) return [];

    try {
      let query = this.db
        .selectFrom("__donkeylabs_jobs__")
        .selectAll()
        .where("name", "=", name);

      if (status) {
        query = query.where("status", "=", status);
      }

      const rows = await query.orderBy("created_at", "desc").execute();
      return rows.map((r) => this.rowToJob(r));
    } catch (err: any) {
      // Silently ignore errors if adapter was stopped during query
      if (this.stopped && err?.message?.includes("destroyed")) return [];
      throw err;
    }
  }

  async getRunningExternal(): Promise<Job[]> {
    if (this.checkStopped()) return [];

    try {
      const rows = await this.db
        .selectFrom("__donkeylabs_jobs__")
        .selectAll()
        .where("external", "=", 1)
        .where("status", "=", "running")
        .execute();

      return rows.map((r) => this.rowToJob(r));
    } catch (err: any) {
      // Silently ignore errors if adapter was stopped during query
      if (this.stopped && err?.message?.includes("destroyed")) return [];
      throw err;
    }
  }

  async getOrphanedExternal(): Promise<Job[]> {
    if (this.checkStopped()) return [];

    try {
      const rows = await this.db
        .selectFrom("__donkeylabs_jobs__")
        .selectAll()
        .where("external", "=", 1)
        .where("status", "=", "running")
        .where((eb) =>
          eb.or([
            eb("process_state", "=", "running"),
            eb("process_state", "=", "orphaned"),
            eb("process_state", "=", "spawning"),
          ])
        )
        .execute();

      return rows.map((r) => this.rowToJob(r));
    } catch (err: any) {
      // Silently ignore errors if adapter was stopped during query
      if (this.stopped && err?.message?.includes("destroyed")) return [];
      throw err;
    }
  }

  async getAll(options: GetAllJobsOptions = {}): Promise<Job[]> {
    if (this.checkStopped()) return [];

    try {
      const { status, name, limit = 100, offset = 0 } = options;

      let query = this.db.selectFrom("__donkeylabs_jobs__").selectAll();

      if (status) {
        query = query.where("status", "=", status);
      }
      if (name) {
        query = query.where("name", "=", name);
      }

      const rows = await query
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute();

      return rows.map((r) => this.rowToJob(r));
    } catch (err: any) {
      // Silently ignore errors if adapter was stopped during query
      if (this.stopped && err?.message?.includes("destroyed")) return [];
      throw err;
    }
  }

  private rowToJob(row: JobsTable): Job {
    return {
      id: row.id,
      name: row.name,
      data: JSON.parse(row.data),
      status: row.status as JobStatus,
      createdAt: new Date(row.created_at),
      runAt: row.run_at ? new Date(row.run_at) : undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error ?? undefined,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      // External job fields
      external: row.external === 1 ? true : undefined,
      pid: row.pid ?? undefined,
      socketPath: row.socket_path ?? undefined,
      tcpPort: row.tcp_port ?? undefined,
      lastHeartbeat: row.last_heartbeat ? new Date(row.last_heartbeat) : undefined,
      processState: row.process_state as ExternalJobProcessState | undefined,
    };
  }

  /** Clean up old completed/failed jobs */
  private async cleanup(): Promise<void> {
    if (this.cleanupDays <= 0 || this.checkStopped()) return;

    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.cleanupDays);

      const result = await this.db
        .deleteFrom("__donkeylabs_jobs__")
        .where((eb) =>
          eb.or([eb("status", "=", "completed"), eb("status", "=", "failed")])
        )
        .where("completed_at", "<", cutoff.toISOString())
        .execute();

      const numDeleted = Number(result[0]?.numDeletedRows ?? 0);
      if (numDeleted > 0) {
        console.log(`[Jobs] Cleaned up ${numDeleted} old jobs`);
      }
    } catch (err: any) {
      // Silently ignore "no such table" errors - table may not exist yet before migrations run
      if (err?.message?.includes("no such table")) return;
      console.error("[Jobs] Cleanup error:", err);
    }
  }

  /** Stop the adapter and cleanup timer */
  stop(): void {
    this.stopped = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** Atomically claim a pending job (returns true if successfully claimed) */
  async claim(jobId: string): Promise<boolean> {
    if (this.checkStopped()) return false;

    try {
      // Use WHERE status = 'pending' for atomicity - only one process can claim
      const result = await this.db
        .updateTable("__donkeylabs_jobs__")
        .set({
          status: "running",
          started_at: new Date().toISOString(),
        })
        .where("id", "=", jobId)
        .where("status", "=", "pending")
        .execute();

      // Kysely returns numUpdatedRows for updates
      const numUpdated = Number(result[0]?.numUpdatedRows ?? 0);
      return numUpdated > 0;
    } catch (err: any) {
      // Silently ignore errors if adapter was stopped during query
      if (this.stopped && err?.message?.includes("destroyed")) return false;
      throw err;
    }
  }
}
