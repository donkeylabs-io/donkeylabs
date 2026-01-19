/**
 * Built-in SQLite Process Adapter
 *
 * Provides automatic persistence for managed processes, enabling server restart resilience
 * and orphan recovery without requiring user configuration.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProcessStatus, ManagedProcess, ProcessConfig } from "./processes";

export interface SqliteProcessAdapterConfig {
  /** Path to SQLite database file (default: .donkeylabs/processes.db) */
  path?: string;
  /** Auto-cleanup stopped processes older than N days (default: 7, 0 to disable) */
  cleanupDays?: number;
  /** Cleanup interval in ms (default: 3600000 = 1 hour) */
  cleanupInterval?: number;
}

export interface ProcessAdapter {
  /** Create a new process record */
  create(process: Omit<ManagedProcess, "id">): Promise<ManagedProcess>;
  /** Get a process by ID */
  get(processId: string): Promise<ManagedProcess | null>;
  /** Update a process record */
  update(processId: string, updates: Partial<ManagedProcess>): Promise<void>;
  /** Delete a process record */
  delete(processId: string): Promise<boolean>;
  /** Get all processes by name */
  getByName(name: string): Promise<ManagedProcess[]>;
  /** Get all running processes */
  getRunning(): Promise<ManagedProcess[]>;
  /** Get orphaned processes (status="running" from before crash) */
  getOrphaned(): Promise<ManagedProcess[]>;
  /** Stop the adapter and cleanup timer */
  stop(): void;
}

export class SqliteProcessAdapter implements ProcessAdapter {
  private db: Database;
  private initialized = false;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupDays: number;

  constructor(config: SqliteProcessAdapterConfig = {}) {
    const dbPath = config.path ?? ".donkeylabs/processes.db";
    this.cleanupDays = config.cleanupDays ?? 7;

    // Ensure directory exists
    this.ensureDir(dbPath);

    this.db = new Database(dbPath);
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
      CREATE TABLE IF NOT EXISTS processes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pid INTEGER,
        socket_path TEXT,
        tcp_port INTEGER,
        status TEXT NOT NULL DEFAULT 'stopped',
        config TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        stopped_at TEXT,
        last_heartbeat TEXT,
        restart_count INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0,
        error TEXT
      )
    `);

    // Indexes for efficient queries
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_processes_status ON processes(status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_processes_name ON processes(name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_processes_name_status ON processes(name, status)`);

    this.initialized = true;
  }

  async create(process: Omit<ManagedProcess, "id">): Promise<ManagedProcess> {
    const id = `proc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    this.db.run(
      `INSERT INTO processes (
        id, name, pid, socket_path, tcp_port, status, config, metadata,
        created_at, started_at, stopped_at, last_heartbeat,
        restart_count, consecutive_failures, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        process.name,
        process.pid ?? null,
        process.socketPath ?? null,
        process.tcpPort ?? null,
        process.status,
        JSON.stringify(process.config),
        process.metadata ? JSON.stringify(process.metadata) : null,
        process.createdAt.toISOString(),
        process.startedAt?.toISOString() ?? null,
        process.stoppedAt?.toISOString() ?? null,
        process.lastHeartbeat?.toISOString() ?? null,
        process.restartCount ?? 0,
        process.consecutiveFailures ?? 0,
        process.error ?? null,
      ]
    );

    return { ...process, id };
  }

  async get(processId: string): Promise<ManagedProcess | null> {
    const row = this.db.query(`SELECT * FROM processes WHERE id = ?`).get(processId) as any;
    if (!row) return null;
    return this.rowToProcess(row);
  }

  async update(processId: string, updates: Partial<ManagedProcess>): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];

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
    if (updates.status !== undefined) {
      sets.push("status = ?");
      values.push(updates.status);
    }
    if (updates.config !== undefined) {
      sets.push("config = ?");
      values.push(JSON.stringify(updates.config));
    }
    if (updates.metadata !== undefined) {
      sets.push("metadata = ?");
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }
    if (updates.startedAt !== undefined) {
      sets.push("started_at = ?");
      values.push(updates.startedAt?.toISOString() ?? null);
    }
    if (updates.stoppedAt !== undefined) {
      sets.push("stopped_at = ?");
      values.push(updates.stoppedAt?.toISOString() ?? null);
    }
    if (updates.lastHeartbeat !== undefined) {
      sets.push("last_heartbeat = ?");
      values.push(updates.lastHeartbeat?.toISOString() ?? null);
    }
    if (updates.restartCount !== undefined) {
      sets.push("restart_count = ?");
      values.push(updates.restartCount);
    }
    if (updates.consecutiveFailures !== undefined) {
      sets.push("consecutive_failures = ?");
      values.push(updates.consecutiveFailures);
    }
    if (updates.error !== undefined) {
      sets.push("error = ?");
      values.push(updates.error);
    }

    if (sets.length === 0) return;

    values.push(processId);
    this.db.run(`UPDATE processes SET ${sets.join(", ")} WHERE id = ?`, values);
  }

  async delete(processId: string): Promise<boolean> {
    const result = this.db.run(`DELETE FROM processes WHERE id = ?`, [processId]);
    return result.changes > 0;
  }

  async getByName(name: string): Promise<ManagedProcess[]> {
    const rows = this.db
      .query(`SELECT * FROM processes WHERE name = ? ORDER BY created_at DESC`)
      .all(name) as any[];
    return rows.map((r) => this.rowToProcess(r));
  }

  async getRunning(): Promise<ManagedProcess[]> {
    const rows = this.db
      .query(`SELECT * FROM processes WHERE status = 'running' OR status = 'spawning'`)
      .all() as any[];
    return rows.map((r) => this.rowToProcess(r));
  }

  async getOrphaned(): Promise<ManagedProcess[]> {
    // Get processes that were running or spawning when server died
    const rows = this.db
      .query(
        `SELECT * FROM processes WHERE status IN ('running', 'spawning', 'orphaned')`
      )
      .all() as any[];
    return rows.map((r) => this.rowToProcess(r));
  }

  private rowToProcess(row: any): ManagedProcess {
    return {
      id: row.id,
      name: row.name,
      pid: row.pid ?? undefined,
      socketPath: row.socket_path ?? undefined,
      tcpPort: row.tcp_port ?? undefined,
      status: row.status as ProcessStatus,
      config: JSON.parse(row.config),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      stoppedAt: row.stopped_at ? new Date(row.stopped_at) : undefined,
      lastHeartbeat: row.last_heartbeat ? new Date(row.last_heartbeat) : undefined,
      restartCount: row.restart_count ?? 0,
      consecutiveFailures: row.consecutive_failures ?? 0,
      error: row.error ?? undefined,
    };
  }

  /** Clean up old stopped/crashed processes */
  private cleanup(): void {
    if (this.cleanupDays <= 0) return;

    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.cleanupDays);

      const result = this.db.run(
        `DELETE FROM processes WHERE status IN ('stopped', 'crashed', 'dead') AND stopped_at < ?`,
        [cutoff.toISOString()]
      );

      if (result.changes > 0) {
        console.log(`[Processes] Cleaned up ${result.changes} old process records`);
      }
    } catch (err) {
      console.error("[Processes] Cleanup error:", err);
    }
  }

  /** Stop the adapter and cleanup timer */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}
