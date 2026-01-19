/**
 * Kysely Process Adapter
 *
 * Implements the ProcessAdapter interface using Kysely for the shared app database.
 * This replaces the standalone SqliteProcessAdapter that used a separate .donkeylabs/processes.db file.
 */

import type { Kysely } from "kysely";
import type { ProcessAdapter } from "./process-adapter-sqlite";
import type { ProcessStatus, ManagedProcess, ProcessConfig } from "./processes";

export interface KyselyProcessAdapterConfig {
  /** Auto-cleanup stopped processes older than N days (default: 7, 0 to disable) */
  cleanupDays?: number;
  /** Cleanup interval in ms (default: 3600000 = 1 hour) */
  cleanupInterval?: number;
}

// Table type for Kysely
interface ProcessesTable {
  id: string;
  name: string;
  pid: number | null;
  socket_path: string | null;
  tcp_port: number | null;
  status: string;
  config: string;
  metadata: string | null;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
  last_heartbeat: string | null;
  restart_count: number;
  consecutive_failures: number;
  error: string | null;
}

interface Database {
  __donkeylabs_processes__: ProcessesTable;
}

export class KyselyProcessAdapter implements ProcessAdapter {
  private db: Kysely<Database>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupDays: number;

  constructor(db: Kysely<any>, config: KyselyProcessAdapterConfig = {}) {
    this.db = db as Kysely<Database>;
    this.cleanupDays = config.cleanupDays ?? 7;

    // Start cleanup timer
    if (this.cleanupDays > 0) {
      const interval = config.cleanupInterval ?? 3600000; // 1 hour
      this.cleanupTimer = setInterval(() => this.cleanup(), interval);
      // Run cleanup on startup
      this.cleanup();
    }
  }

  async create(process: Omit<ManagedProcess, "id">): Promise<ManagedProcess> {
    const id = `proc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    await this.db
      .insertInto("__donkeylabs_processes__")
      .values({
        id,
        name: process.name,
        pid: process.pid ?? null,
        socket_path: process.socketPath ?? null,
        tcp_port: process.tcpPort ?? null,
        status: process.status,
        config: JSON.stringify(process.config),
        metadata: process.metadata ? JSON.stringify(process.metadata) : null,
        created_at: process.createdAt.toISOString(),
        started_at: process.startedAt?.toISOString() ?? null,
        stopped_at: process.stoppedAt?.toISOString() ?? null,
        last_heartbeat: process.lastHeartbeat?.toISOString() ?? null,
        restart_count: process.restartCount ?? 0,
        consecutive_failures: process.consecutiveFailures ?? 0,
        error: process.error ?? null,
      })
      .execute();

    return { ...process, id };
  }

  async get(processId: string): Promise<ManagedProcess | null> {
    const row = await this.db
      .selectFrom("__donkeylabs_processes__")
      .selectAll()
      .where("id", "=", processId)
      .executeTakeFirst();

    if (!row) return null;
    return this.rowToProcess(row);
  }

  async update(processId: string, updates: Partial<ManagedProcess>): Promise<void> {
    const updateData: Partial<ProcessesTable> = {};

    if (updates.pid !== undefined) {
      updateData.pid = updates.pid;
    }
    if (updates.socketPath !== undefined) {
      updateData.socket_path = updates.socketPath;
    }
    if (updates.tcpPort !== undefined) {
      updateData.tcp_port = updates.tcpPort;
    }
    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }
    if (updates.config !== undefined) {
      updateData.config = JSON.stringify(updates.config);
    }
    if (updates.metadata !== undefined) {
      updateData.metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;
    }
    if (updates.startedAt !== undefined) {
      updateData.started_at = updates.startedAt?.toISOString() ?? null;
    }
    if (updates.stoppedAt !== undefined) {
      updateData.stopped_at = updates.stoppedAt?.toISOString() ?? null;
    }
    if (updates.lastHeartbeat !== undefined) {
      updateData.last_heartbeat = updates.lastHeartbeat?.toISOString() ?? null;
    }
    if (updates.restartCount !== undefined) {
      updateData.restart_count = updates.restartCount;
    }
    if (updates.consecutiveFailures !== undefined) {
      updateData.consecutive_failures = updates.consecutiveFailures;
    }
    if (updates.error !== undefined) {
      updateData.error = updates.error;
    }

    if (Object.keys(updateData).length === 0) return;

    await this.db
      .updateTable("__donkeylabs_processes__")
      .set(updateData)
      .where("id", "=", processId)
      .execute();
  }

  async delete(processId: string): Promise<boolean> {
    // Check if exists first since BunSqliteDialect doesn't report numDeletedRows properly
    const exists = await this.db
      .selectFrom("__donkeylabs_processes__")
      .select("id")
      .where("id", "=", processId)
      .executeTakeFirst();

    if (!exists) return false;

    await this.db
      .deleteFrom("__donkeylabs_processes__")
      .where("id", "=", processId)
      .execute();

    return true;
  }

  async getByName(name: string): Promise<ManagedProcess[]> {
    const rows = await this.db
      .selectFrom("__donkeylabs_processes__")
      .selectAll()
      .where("name", "=", name)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map((r) => this.rowToProcess(r));
  }

  async getRunning(): Promise<ManagedProcess[]> {
    const rows = await this.db
      .selectFrom("__donkeylabs_processes__")
      .selectAll()
      .where((eb) =>
        eb.or([eb("status", "=", "running"), eb("status", "=", "spawning")])
      )
      .execute();

    return rows.map((r) => this.rowToProcess(r));
  }

  async getOrphaned(): Promise<ManagedProcess[]> {
    const rows = await this.db
      .selectFrom("__donkeylabs_processes__")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("status", "=", "running"),
          eb("status", "=", "spawning"),
          eb("status", "=", "orphaned"),
        ])
      )
      .execute();

    return rows.map((r) => this.rowToProcess(r));
  }

  private rowToProcess(row: ProcessesTable): ManagedProcess {
    return {
      id: row.id,
      name: row.name,
      pid: row.pid ?? undefined,
      socketPath: row.socket_path ?? undefined,
      tcpPort: row.tcp_port ?? undefined,
      status: row.status as ProcessStatus,
      config: JSON.parse(row.config) as ProcessConfig,
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
  private async cleanup(): Promise<void> {
    if (this.cleanupDays <= 0) return;

    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.cleanupDays);

      const result = await this.db
        .deleteFrom("__donkeylabs_processes__")
        .where((eb) =>
          eb.or([
            eb("status", "=", "stopped"),
            eb("status", "=", "crashed"),
            eb("status", "=", "dead"),
          ])
        )
        .where("stopped_at", "<", cutoff.toISOString())
        .execute();

      const numDeleted = Number(result[0]?.numDeletedRows ?? 0);
      if (numDeleted > 0) {
        console.log(`[Processes] Cleaned up ${numDeleted} old process records`);
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
