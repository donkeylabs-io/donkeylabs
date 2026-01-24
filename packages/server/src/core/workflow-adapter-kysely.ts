/**
 * Kysely Workflow Adapter
 *
 * Implements the WorkflowAdapter interface using Kysely for the shared app database.
 * This provides persistence for workflows, which previously had NO persistence (in-memory only).
 */

import type { Kysely } from "kysely";
import type { WorkflowAdapter, WorkflowInstance, WorkflowStatus, StepResult } from "./workflows";

export interface KyselyWorkflowAdapterConfig {
  /** Auto-cleanup completed workflows older than N days (default: 30, 0 to disable) */
  cleanupDays?: number;
  /** Cleanup interval in ms (default: 3600000 = 1 hour) */
  cleanupInterval?: number;
}

// Table type for Kysely
interface WorkflowInstancesTable {
  id: string;
  workflow_name: string;
  status: string;
  current_step: string | null;
  input: string;
  output: string | null;
  error: string | null;
  step_results: string;
  branch_instances: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  parent_id: string | null;
  branch_name: string | null;
}

interface Database {
  __donkeylabs_workflow_instances__: WorkflowInstancesTable;
}

export class KyselyWorkflowAdapter implements WorkflowAdapter {
  private db: Kysely<Database>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupDays: number;

  constructor(db: Kysely<any>, config: KyselyWorkflowAdapterConfig = {}) {
    this.db = db as Kysely<Database>;
    this.cleanupDays = config.cleanupDays ?? 30;

    // Start cleanup timer (don't run immediately - tables may not exist yet before migrations)
    if (this.cleanupDays > 0) {
      const interval = config.cleanupInterval ?? 3600000; // 1 hour
      this.cleanupTimer = setInterval(() => this.cleanup(), interval);
    }
  }

  async createInstance(instance: Omit<WorkflowInstance, "id">): Promise<WorkflowInstance> {
    const id = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    await this.db
      .insertInto("__donkeylabs_workflow_instances__")
      .values({
        id,
        workflow_name: instance.workflowName,
        status: instance.status,
        current_step: instance.currentStep ?? null,
        input: JSON.stringify(instance.input),
        output: instance.output !== undefined ? JSON.stringify(instance.output) : null,
        error: instance.error ?? null,
        step_results: JSON.stringify(instance.stepResults),
        branch_instances: instance.branchInstances
          ? JSON.stringify(instance.branchInstances)
          : null,
        created_at: instance.createdAt.toISOString(),
        started_at: instance.startedAt?.toISOString() ?? null,
        completed_at: instance.completedAt?.toISOString() ?? null,
        parent_id: instance.parentId ?? null,
        branch_name: instance.branchName ?? null,
      })
      .execute();

    return { ...instance, id };
  }

  async getInstance(instanceId: string): Promise<WorkflowInstance | null> {
    const row = await this.db
      .selectFrom("__donkeylabs_workflow_instances__")
      .selectAll()
      .where("id", "=", instanceId)
      .executeTakeFirst();

    if (!row) return null;
    return this.rowToInstance(row);
  }

  async updateInstance(instanceId: string, updates: Partial<WorkflowInstance>): Promise<void> {
    const updateData: Partial<WorkflowInstancesTable> = {};

    if (updates.status !== undefined) {
      updateData.status = updates.status;
    }
    if (updates.currentStep !== undefined) {
      updateData.current_step = updates.currentStep ?? null;
    }
    if (updates.output !== undefined) {
      updateData.output = JSON.stringify(updates.output);
    }
    if (updates.error !== undefined) {
      updateData.error = updates.error;
    }
    if (updates.stepResults !== undefined) {
      updateData.step_results = JSON.stringify(updates.stepResults);
    }
    if (updates.branchInstances !== undefined) {
      updateData.branch_instances = updates.branchInstances
        ? JSON.stringify(updates.branchInstances)
        : null;
    }
    if (updates.startedAt !== undefined) {
      updateData.started_at = updates.startedAt?.toISOString() ?? null;
    }
    if (updates.completedAt !== undefined) {
      updateData.completed_at = updates.completedAt?.toISOString() ?? null;
    }

    if (Object.keys(updateData).length === 0) return;

    await this.db
      .updateTable("__donkeylabs_workflow_instances__")
      .set(updateData)
      .where("id", "=", instanceId)
      .execute();
  }

  async deleteInstance(instanceId: string): Promise<boolean> {
    // Check if exists first since BunSqliteDialect doesn't report numDeletedRows properly
    const exists = await this.db
      .selectFrom("__donkeylabs_workflow_instances__")
      .select("id")
      .where("id", "=", instanceId)
      .executeTakeFirst();

    if (!exists) return false;

    await this.db
      .deleteFrom("__donkeylabs_workflow_instances__")
      .where("id", "=", instanceId)
      .execute();

    return true;
  }

  async getInstancesByWorkflow(
    workflowName: string,
    status?: WorkflowStatus
  ): Promise<WorkflowInstance[]> {
    let query = this.db
      .selectFrom("__donkeylabs_workflow_instances__")
      .selectAll()
      .where("workflow_name", "=", workflowName);

    if (status) {
      query = query.where("status", "=", status);
    }

    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map((r) => this.rowToInstance(r));
  }

  async getRunningInstances(): Promise<WorkflowInstance[]> {
    const rows = await this.db
      .selectFrom("__donkeylabs_workflow_instances__")
      .selectAll()
      .where("status", "=", "running")
      .execute();

    return rows.map((r) => this.rowToInstance(r));
  }

  private rowToInstance(row: WorkflowInstancesTable): WorkflowInstance {
    // Parse step results with proper Date handling
    const rawStepResults = JSON.parse(row.step_results);
    const stepResults: Record<string, StepResult> = {};

    for (const [key, value] of Object.entries(rawStepResults)) {
      const sr = value as any;
      stepResults[key] = {
        stepName: sr.stepName,
        status: sr.status,
        input: sr.input,
        output: sr.output,
        error: sr.error,
        startedAt: sr.startedAt ? new Date(sr.startedAt) : undefined,
        completedAt: sr.completedAt ? new Date(sr.completedAt) : undefined,
        attempts: sr.attempts,
      };
    }

    return {
      id: row.id,
      workflowName: row.workflow_name,
      status: row.status as WorkflowStatus,
      currentStep: row.current_step ?? undefined,
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : undefined,
      error: row.error ?? undefined,
      stepResults,
      branchInstances: row.branch_instances ? JSON.parse(row.branch_instances) : undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      parentId: row.parent_id ?? undefined,
      branchName: row.branch_name ?? undefined,
    };
  }

  /** Clean up old completed/failed/cancelled workflows */
  private async cleanup(): Promise<void> {
    if (this.cleanupDays <= 0) return;

    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.cleanupDays);

      const result = await this.db
        .deleteFrom("__donkeylabs_workflow_instances__")
        .where((eb) =>
          eb.or([
            eb("status", "=", "completed"),
            eb("status", "=", "failed"),
            eb("status", "=", "cancelled"),
            eb("status", "=", "timed_out"),
          ])
        )
        .where("completed_at", "<", cutoff.toISOString())
        .execute();

      const numDeleted = Number(result[0]?.numDeletedRows ?? 0);
      if (numDeleted > 0) {
        console.log(`[Workflows] Cleaned up ${numDeleted} old workflow instances`);
      }
    } catch (err: any) {
      // Silently ignore "no such table" errors - table may not exist yet before migrations run
      if (err?.message?.includes("no such table")) return;
      console.error("[Workflows] Cleanup error:", err);
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
