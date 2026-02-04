/**
 * Built-in SQLite Job Adapter
 *
 * Provides automatic persistence for jobs, enabling server restart resilience
 * for external jobs without requiring user configuration.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Job, JobAdapter, JobStatus, GetAllJobsOptions } from "./jobs";
import type { ExternalJobProcessState } from "./external-jobs";

export interface SqliteJobAdapterConfig {
  /** Path to SQLite database file (default: .donkeylabs/jobs.db) */
  path?: string;
  /** Auto-cleanup completed jobs older than N days (default: 7, 0 to disable) */
  cleanupDays?: number;
  /** Cleanup interval in ms (default: 3600000 = 1 hour) */
  cleanupInterval?: number;
}

export class SqliteJobAdapter implements JobAdapter {
  private db: Database;
  private initialized = false;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupDays: number;

  constructor(config: SqliteJobAdapterConfig = {}) {
    const dbPath = config.path ?? ".donkeylabs/jobs.db";
    this.cleanupDays = config.cleanupDays ?? 7;

    // Ensure directory exists
    this.ensureDir(dbPath);

    this.db = new Database(dbPath);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.init();

    // Start cleanup timer
    if (this.cleanupDays > 0) {
      const interval = config.cleanupInterval ?? 3600000; // 1 hour
      this.cleanupTimer = setInterval(() => this.cleanup(), interval);
      // Run cleanup on startup
      this.cleanup();
    }
  }

  private ensureDir(dbPath: string): void {
    const dir = dirname(dbPath);
    if (dir && dir !== ".") {
      // Sync mkdir for constructor
      try {
        Bun.spawnSync(["mkdir", "-p", dir]);
      } catch {
        // Directory may already exist
      }
    }
  }

  private init(): void {
    if (this.initialized) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        run_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        result TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        -- External job fields
        external INTEGER DEFAULT 0,
        pid INTEGER,
        socket_path TEXT,
        tcp_port INTEGER,
        last_heartbeat TEXT,
        process_state TEXT
      )
    `);

    // Indexes for efficient queries
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_external ON jobs(external, status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(status, run_at)`);

    this.initialized = true;
  }

  async create(job: Omit<Job, "id">): Promise<Job> {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    this.db.run(
      `INSERT INTO jobs (
        id, name, data, status, created_at, run_at, attempts, max_attempts,
        external, process_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        job.name,
        JSON.stringify(job.data),
        job.status,
        job.createdAt.toISOString(),
        job.runAt?.toISOString() ?? null,
        job.attempts,
        job.maxAttempts,
        job.external ? 1 : 0,
        job.processState ?? null,
      ]
    );

    return { ...job, id };
  }

  async get(jobId: string): Promise<Job | null> {
    const row = this.db.query(`SELECT * FROM jobs WHERE id = ?`).get(jobId) as any;
    if (!row) return null;
    return this.rowToJob(row);
  }

  async update(jobId: string, updates: Partial<Job>): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      sets.push("status = ?");
      values.push(updates.status);
    }
    if (updates.startedAt !== undefined) {
      sets.push("started_at = ?");
      values.push(updates.startedAt?.toISOString() ?? null);
    }
    if (updates.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(updates.completedAt?.toISOString() ?? null);
    }
    if (updates.result !== undefined) {
      sets.push("result = ?");
      values.push(JSON.stringify(updates.result));
    }
    if (updates.error !== undefined) {
      sets.push("error = ?");
      values.push(updates.error);
    }
    if (updates.attempts !== undefined) {
      sets.push("attempts = ?");
      values.push(updates.attempts);
    }
    // External job fields
    if (updates.pid !== undefined) {
      sets.push("pid = ?");
      values.push(updates.pid);
    }
    if (updates.socketPath !== undefined) {
      sets.push("socket_path = ?");
      values.push(updates.socketPath);
    }
    if (updates.tcpPort !== undefined) {
      sets.push("tcp_port = ?");
      values.push(updates.tcpPort);
    }
    if (updates.lastHeartbeat !== undefined) {
      sets.push("last_heartbeat = ?");
      values.push(updates.lastHeartbeat?.toISOString() ?? null);
    }
    if (updates.processState !== undefined) {
      sets.push("process_state = ?");
      values.push(updates.processState);
    }

    if (sets.length === 0) return;

    values.push(jobId);
    this.db.run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, values);
  }

  async delete(jobId: string): Promise<boolean> {
    const result = this.db.run(`DELETE FROM jobs WHERE id = ?`, [jobId]);
    return result.changes > 0;
  }

  async getPending(limit: number = 100): Promise<Job[]> {
    const rows = this.db
      .query(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => this.rowToJob(r));
  }

  async getScheduledReady(now: Date): Promise<Job[]> {
    const rows = this.db
      .query(`SELECT * FROM jobs WHERE status = 'scheduled' AND run_at <= ? ORDER BY run_at`)
      .all(now.toISOString()) as any[];
    return rows.map((r) => this.rowToJob(r));
  }

  async getByName(name: string, status?: JobStatus): Promise<Job[]> {
    let query = `SELECT * FROM jobs WHERE name = ?`;
    const params: any[] = [name];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC`;

    const rows = this.db.query(query).all(...params) as any[];
    return rows.map((r) => this.rowToJob(r));
  }

  async getRunningExternal(): Promise<Job[]> {
    const rows = this.db
      .query(`SELECT * FROM jobs WHERE external = 1 AND status = 'running'`)
      .all() as any[];
    return rows.map((r) => this.rowToJob(r));
  }

  async getOrphanedExternal(): Promise<Job[]> {
    // Get external jobs that were running when server died
    const rows = this.db
      .query(
        `SELECT * FROM jobs WHERE external = 1 AND status = 'running'
         AND (process_state = 'running' OR process_state = 'orphaned' OR process_state = 'spawning')`
      )
      .all() as any[];
    return rows.map((r) => this.rowToJob(r));
  }

  async getAll(options: GetAllJobsOptions = {}): Promise<Job[]> {
    const { status, name, limit = 100, offset = 0 } = options;
    let query = `SELECT * FROM jobs WHERE 1=1`;
    const params: any[] = [];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }
    if (name) {
      query += ` AND name = ?`;
      params.push(name);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.query(query).all(...params) as any[];
    return rows.map((r) => this.rowToJob(r));
  }

  private rowToJob(row: any): Job {
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
  private cleanup(): void {
    if (this.cleanupDays <= 0) return;

    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.cleanupDays);

      const result = this.db.run(
        `DELETE FROM jobs WHERE (status = 'completed' OR status = 'failed') AND completed_at < ?`,
        [cutoff.toISOString()]
      );

      if (result.changes > 0) {
        console.log(`[Jobs] Cleaned up ${result.changes} old jobs`);
      }
    } catch (err) {
      console.error("[Jobs] Cleanup error:", err);
    }
  }

  /** Stop the adapter and cleanup timer */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** Atomically claim a pending job (returns true if successfully claimed) */
  async claim(jobId: string): Promise<boolean> {
    // Use WHERE status = 'pending' for atomicity - only one process can claim
    const result = this.db.run(
      `UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'`,
      [new Date().toISOString(), jobId]
    );
    return result.changes > 0;
  }
}
