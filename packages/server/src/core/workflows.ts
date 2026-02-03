// Core Workflows Service
// Step function / state machine orchestration built on Jobs
//
// Supports:
// - task: Execute inline handler or job (sync or async)
// - parallel: Run multiple branches concurrently
// - choice: Conditional branching
// - pass: Transform data / no-op
// - isolated: Execute in subprocess to prevent event loop blocking (default)

import type { Events } from "./events";
import type { Jobs } from "./jobs";
import type { SSE } from "./sse";
import type { z } from "zod";
import type { CoreServices } from "../core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkflowSocketServer,
  type WorkflowSocketServer,
  type WorkflowEvent,
  type ProxyRequest,
} from "./workflow-socket";
import { isProcessAlive } from "./external-jobs";

// Type helper for Zod schema inference
type ZodSchema = z.ZodTypeAny;
type InferZodOutput<T extends ZodSchema> = z.infer<T>;

// ============================================
// Step Types
// ============================================

export type StepType = "task" | "parallel" | "choice" | "pass";

export interface BaseStepDefinition {
  name: string;
  type: StepType;
  next?: string;
  end?: boolean;
  /** Retry configuration for this step */
  retry?: RetryConfig;
  /** Timeout for this step in milliseconds */
  timeout?: number;
}

export interface RetryConfig {
  maxAttempts: number;
  /** Backoff multiplier (default: 2) */
  backoffRate?: number;
  /** Initial delay in ms (default: 1000) */
  intervalMs?: number;
  /** Max delay in ms (default: 30000) */
  maxIntervalMs?: number;
  /** Errors to retry on (default: all) */
  retryOn?: string[];
}

// Task Step: Execute inline handler or job
export interface TaskStepDefinition<
  TInput extends ZodSchema = ZodSchema,
  TOutput extends ZodSchema = ZodSchema,
> extends BaseStepDefinition {
  type: "task";

  // === NEW API: Inline handler with Zod schemas ===
  /**
   * Input schema (Zod) OR function that maps previous step output to input.
   * - First task: Use Zod schema, input comes from workflow input
   * - Subsequent tasks: Use function (prev, workflowInput) => inputShape
   */
  inputSchema?: TInput | ((prev: any, workflowInput: any) => InferZodOutput<TInput>);
  /** Output schema (Zod) for runtime validation and typing */
  outputSchema?: TOutput;
  /** Inline handler function - receives validated input, returns output */
  handler?: (input: InferZodOutput<TInput>, ctx: WorkflowContext) => Promise<InferZodOutput<TOutput>> | InferZodOutput<TOutput>;

  // === LEGACY API: Job-based execution ===
  /** Job name to execute (legacy - use handler instead) */
  job?: string;
  /** Transform workflow context to job input (legacy) */
  input?: (ctx: WorkflowContext) => any;
  /** Transform job result to step output (legacy) */
  output?: (result: any, ctx: WorkflowContext) => any;
}

// Parallel Step: Run branches concurrently
export interface ParallelStepDefinition extends BaseStepDefinition {
  type: "parallel";
  /** Branches to execute in parallel */
  branches: WorkflowDefinition[];
  /** How to handle branch failures */
  onError?: "fail-fast" | "wait-all";
}

// Choice Step: Conditional branching
export interface ChoiceCondition {
  /** Condition function - return true to take this branch */
  condition: (ctx: WorkflowContext) => boolean;
  /** Step to go to if condition is true */
  next: string;
}

export interface ChoiceStepDefinition extends BaseStepDefinition {
  type: "choice";
  /** Conditions evaluated in order */
  choices: ChoiceCondition[];
  /** Default step if no conditions match */
  default?: string;
}

// Pass Step: Transform data or no-op
export interface PassStepDefinition extends BaseStepDefinition {
  type: "pass";
  /** Transform input to output */
  transform?: (ctx: WorkflowContext) => any;
  /** Static result to use */
  result?: any;
}

export type StepDefinition =
  | TaskStepDefinition
  | ParallelStepDefinition
  | ChoiceStepDefinition
  | PassStepDefinition;

// ============================================
// Workflow Definition
// ============================================

export interface WorkflowDefinition {
  name: string;
  steps: Map<string, StepDefinition>;
  startAt: string;
  /** Default timeout for the entire workflow in ms */
  timeout?: number;
  /** Default retry config for all steps */
  defaultRetry?: RetryConfig;
  /**
   * Whether to execute this workflow in an isolated subprocess.
   * Default: true (isolated by default to prevent blocking the event loop)
   *
   * Set to false for lightweight workflows that benefit from inline execution.
   */
  isolated?: boolean;
}

// ============================================
// Workflow Instance (Runtime State)
// ============================================

export type WorkflowStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface StepResult {
  stepName: string;
  status: StepStatus;
  input?: any;
  output?: any;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  attempts: number;
}

export interface WorkflowInstance {
  id: string;
  workflowName: string;
  status: WorkflowStatus;
  currentStep?: string;
  input: any;
  output?: any;
  error?: string;
  stepResults: Record<string, StepResult>;
  /** For parallel steps, track branch instances */
  branchInstances?: Record<string, string[]>;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /** Parent workflow instance ID (for branches) */
  parentId?: string;
  /** Branch name if this is a branch instance */
  branchName?: string;
  /** Custom metadata that persists across steps (JSON-serializable) */
  metadata?: Record<string, any>;
}

// ============================================
// Workflow Context (Available to steps)
// ============================================

export interface WorkflowContext {
  /** Original workflow input */
  input: any;
  /** Results from completed steps */
  steps: Record<string, any>;
  /** Output from the previous step (undefined for first step) */
  prev?: any;
  /** Current workflow instance */
  instance: WorkflowInstance;
  /** Get a step result with type safety */
  getStepResult<T = any>(stepName: string): T | undefined;
  /** Core services (logger, events, cache, etc.) */
  core: CoreServices;
  /** Plugin services - available for business logic in workflow handlers */
  plugins: Record<string, any>;
  /**
   * Custom metadata that persists across steps (read-only snapshot).
   * Use setMetadata() to update values.
   */
  metadata: Record<string, any>;
  /**
   * Set a metadata value that persists across workflow steps.
   * Accepts any JSON-serializable value (objects, arrays, primitives).
   *
   * @example
   * await ctx.setMetadata('orderContext', {
   *   correlationId: 'abc-123',
   *   customer: { id: 'cust_1', tier: 'premium' },
   *   flags: { expedited: true }
   * });
   */
  setMetadata(key: string, value: any): Promise<void>;
  /**
   * Get a metadata value with type safety.
   *
   * @example
   * interface OrderContext { correlationId: string; customer: { id: string } }
   * const ctx = ctx.getMetadata<OrderContext>('orderContext');
   */
  getMetadata<T = any>(key: string): T | undefined;
}

// ============================================
// Workflow Adapter (Persistence)
// ============================================

/** Options for listing all workflow instances */
export interface GetAllWorkflowsOptions {
  /** Filter by status */
  status?: WorkflowStatus;
  /** Filter by workflow name */
  workflowName?: string;
  /** Max number of instances to return (default: 100) */
  limit?: number;
  /** Skip first N instances (for pagination) */
  offset?: number;
}

export interface WorkflowAdapter {
  createInstance(instance: Omit<WorkflowInstance, "id">): Promise<WorkflowInstance>;
  getInstance(instanceId: string): Promise<WorkflowInstance | null>;
  updateInstance(instanceId: string, updates: Partial<WorkflowInstance>): Promise<void>;
  deleteInstance(instanceId: string): Promise<boolean>;
  getInstancesByWorkflow(workflowName: string, status?: WorkflowStatus): Promise<WorkflowInstance[]>;
  getRunningInstances(): Promise<WorkflowInstance[]>;
  /** Get all workflow instances with optional filtering (for admin dashboard) */
  getAllInstances(options?: GetAllWorkflowsOptions): Promise<WorkflowInstance[]>;
}

// In-memory adapter
export class MemoryWorkflowAdapter implements WorkflowAdapter {
  private instances = new Map<string, WorkflowInstance>();
  private counter = 0;

  async createInstance(instance: Omit<WorkflowInstance, "id">): Promise<WorkflowInstance> {
    const id = `wf_${++this.counter}_${Date.now()}`;
    const fullInstance: WorkflowInstance = { ...instance, id };
    this.instances.set(id, fullInstance);
    return fullInstance;
  }

  async getInstance(instanceId: string): Promise<WorkflowInstance | null> {
    return this.instances.get(instanceId) ?? null;
  }

  async updateInstance(instanceId: string, updates: Partial<WorkflowInstance>): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (instance) {
      Object.assign(instance, updates);
    }
  }

  async deleteInstance(instanceId: string): Promise<boolean> {
    return this.instances.delete(instanceId);
  }

  async getInstancesByWorkflow(
    workflowName: string,
    status?: WorkflowStatus
  ): Promise<WorkflowInstance[]> {
    const results: WorkflowInstance[] = [];
    for (const instance of this.instances.values()) {
      if (instance.workflowName === workflowName) {
        if (!status || instance.status === status) {
          results.push(instance);
        }
      }
    }
    return results;
  }

  async getRunningInstances(): Promise<WorkflowInstance[]> {
    const results: WorkflowInstance[] = [];
    for (const instance of this.instances.values()) {
      if (instance.status === "running") {
        results.push(instance);
      }
    }
    return results;
  }

  async getAllInstances(options: GetAllWorkflowsOptions = {}): Promise<WorkflowInstance[]> {
    const { status, workflowName, limit = 100, offset = 0 } = options;
    const results: WorkflowInstance[] = [];

    for (const instance of this.instances.values()) {
      if (status && instance.status !== status) continue;
      if (workflowName && instance.workflowName !== workflowName) continue;
      results.push(instance);
    }

    // Sort by createdAt descending (newest first)
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Apply pagination
    return results.slice(offset, offset + limit);
  }
}

// ============================================
// Workflow Builder (Fluent API)
// ============================================

export class WorkflowBuilder {
  private _name: string;
  private _steps = new Map<string, StepDefinition>();
  private _startAt?: string;
  private _timeout?: number;
  private _defaultRetry?: RetryConfig;
  private _lastStep?: string;
  private _isolated = true; // Default to isolated execution

  constructor(name: string) {
    this._name = name;
  }

  /**
   * Set whether to execute this workflow in an isolated subprocess.
   * Default: true (isolated by default to prevent blocking the event loop)
   *
   * @param enabled - Set to false for lightweight workflows that benefit from inline execution
   * @example
   * // Heavy workflow - uses default isolation (no call needed)
   * workflow("data-ingestion").task("process", { ... }).build();
   *
   * // Lightweight workflow - opt out of isolation
   * workflow("quick-validation").isolated(false).task("validate", { ... }).build();
   */
  isolated(enabled: boolean = true): this {
    this._isolated = enabled;
    return this;
  }

  /** Set the starting step explicitly */
  startAt(stepName: string): this {
    this._startAt = stepName;
    return this;
  }

  /** Set default timeout for the workflow */
  timeout(ms: number): this {
    this._timeout = ms;
    return this;
  }

  /** Set default retry config for all steps */
  defaultRetry(config: RetryConfig): this {
    this._defaultRetry = config;
    return this;
  }

  /**
   * Add a task step with inline handler (recommended) or job reference.
   *
   * @example
   * // New API with inline handler and Zod schemas
   * .task("validate", {
   *   inputSchema: z.object({ orderId: z.string() }),
   *   outputSchema: z.object({ valid: z.boolean(), total: z.number() }),
   *   handler: async (input, ctx) => {
   *     return { valid: true, total: 99.99 };
   *   },
   * })
   *
   * // Using input mapper from previous step
   * .task("charge", {
   *   inputSchema: (prev) => ({ amount: prev.total }),
   *   outputSchema: z.object({ chargeId: z.string() }),
   *   handler: async (input, ctx) => {
   *     return { chargeId: "ch_123" };
   *   },
   * })
   *
   * // Legacy API (still supported)
   * .task("process", { job: "process-order" })
   */
  task<TInput extends ZodSchema = ZodSchema, TOutput extends ZodSchema = ZodSchema>(
    name: string,
    config:
      | {
          // New API: Inline handler with typed schemas
          inputSchema?: TInput | ((prev: any, workflowInput: any) => InferZodOutput<TInput>);
          outputSchema?: TOutput;
          handler: (
            input: InferZodOutput<TInput>,
            ctx: WorkflowContext
          ) => Promise<InferZodOutput<TOutput>> | InferZodOutput<TOutput>;
          retry?: RetryConfig;
          timeout?: number;
          next?: string;
          end?: boolean;
        }
      | {
          // Legacy API: Job reference
          job: string;
          input?: (ctx: WorkflowContext) => any;
          output?: (result: any, ctx: WorkflowContext) => any;
          retry?: RetryConfig;
          timeout?: number;
          next?: string;
          end?: boolean;
        }
  ): this {
    // Determine which API is being used
    const isNewApi = "handler" in config;

    const step: TaskStepDefinition<TInput, TOutput> = {
      name,
      type: "task",
      retry: config.retry,
      timeout: config.timeout,
      next: config.next,
      end: config.end,
      // New API fields
      inputSchema: isNewApi ? (config as any).inputSchema : undefined,
      outputSchema: isNewApi ? (config as any).outputSchema : undefined,
      handler: isNewApi ? (config as any).handler : undefined,
      // Legacy API fields
      job: !isNewApi ? (config as any).job : undefined,
      input: !isNewApi ? (config as any).input : undefined,
      output: !isNewApi ? (config as any).output : undefined,
    };

    this.addStep(step);
    return this;
  }

  /** Add a parallel step that runs branches concurrently */
  parallel(
    name: string,
    config: {
      branches: WorkflowDefinition[];
      onError?: "fail-fast" | "wait-all";
      next?: string;
      end?: boolean;
    }
  ): this {
    const step: ParallelStepDefinition = {
      name,
      type: "parallel",
      branches: config.branches,
      onError: config.onError,
      next: config.next,
      end: config.end,
    };

    this.addStep(step);
    return this;
  }

  /** Add a choice step for conditional branching */
  choice(
    name: string,
    config: {
      choices: ChoiceCondition[];
      default?: string;
    }
  ): this {
    const step: ChoiceStepDefinition = {
      name,
      type: "choice",
      choices: config.choices,
      default: config.default,
    };

    this.addStep(step);
    return this;
  }

  /** Add a pass step for data transformation */
  pass(
    name: string,
    config?: {
      transform?: (ctx: WorkflowContext) => any;
      result?: any;
      next?: string;
      end?: boolean;
    }
  ): this {
    const step: PassStepDefinition = {
      name,
      type: "pass",
      transform: config?.transform,
      result: config?.result,
      next: config?.next,
      end: config?.end ?? (!config?.next),
    };

    this.addStep(step);
    return this;
  }

  /** Add an end step (shorthand for pass with end: true) */
  end(name: string = "end"): this {
    return this.pass(name, { end: true });
  }

  private addStep(step: StepDefinition): void {
    // Auto-link previous step to this one
    if (this._lastStep && !this._steps.get(this._lastStep)?.next && !this._steps.get(this._lastStep)?.end) {
      const lastStep = this._steps.get(this._lastStep)!;
      if (lastStep.type !== "choice") {
        lastStep.next = step.name;
      }
    }

    // First step is the start
    if (!this._startAt) {
      this._startAt = step.name;
    }

    this._steps.set(step.name, step);
    this._lastStep = step.name;
  }

  /** Build the workflow definition */
  build(): WorkflowDefinition {
    if (!this._startAt) {
      throw new Error("Workflow must have at least one step");
    }

    // Validate: mark last step as end if not already
    const lastStep = this._steps.get(this._lastStep!);
    if (lastStep && !lastStep.next && !lastStep.end && lastStep.type !== "choice") {
      lastStep.end = true;
    }

    return {
      name: this._name,
      steps: this._steps,
      startAt: this._startAt,
      timeout: this._timeout,
      defaultRetry: this._defaultRetry,
      isolated: this._isolated,
    };
  }
}

/** Create a workflow builder */
export function workflow(name: string): WorkflowBuilder {
  return new WorkflowBuilder(name);
}

/** Create a branch for parallel steps */
workflow.branch = function (name: string): WorkflowBuilder {
  return new WorkflowBuilder(name);
};

// ============================================
// Workflow Service Interface
// ============================================

export interface WorkflowsConfig {
  adapter?: WorkflowAdapter;
  events?: Events;
  jobs?: Jobs;
  sse?: SSE;
  /** Poll interval for checking job completion (ms) */
  pollInterval?: number;
  /** Core services to pass to step handlers */
  core?: CoreServices;
  /** Directory for Unix sockets (default: /tmp/donkeylabs-workflows) */
  socketDir?: string;
  /** TCP port range for Windows fallback (default: [49152, 65535]) */
  tcpPortRange?: [number, number];
  /** Database file path (required for isolated workflows) */
  dbPath?: string;
  /** Heartbeat timeout in ms (default: 60000) */
  heartbeatTimeout?: number;
}

/** Options for registering a workflow */
export interface WorkflowRegisterOptions {
  /**
   * Module path for isolated workflows.
   * Required when workflow.isolated !== false and running in isolated mode.
   * Use `import.meta.url` to get the current module's path.
   *
   * @example
   * workflows.register(myWorkflow, { modulePath: import.meta.url });
   */
  modulePath?: string;
}

export interface Workflows {
  /**
   * Register a workflow definition.
   * @param definition - The workflow definition to register
   * @param options - Registration options (modulePath required for isolated workflows)
   */
  register(definition: WorkflowDefinition, options?: WorkflowRegisterOptions): void;
  /** Start a new workflow instance */
  start<T = any>(workflowName: string, input: T): Promise<string>;
  /** Get a workflow instance by ID */
  getInstance(instanceId: string): Promise<WorkflowInstance | null>;
  /** Cancel a running workflow */
  cancel(instanceId: string): Promise<boolean>;
  /** Get all instances of a workflow */
  getInstances(workflowName: string, status?: WorkflowStatus): Promise<WorkflowInstance[]>;
  /** Get all workflow instances with optional filtering (for admin dashboard) */
  getAllInstances(options?: GetAllWorkflowsOptions): Promise<WorkflowInstance[]>;
  /** Resume workflows after server restart */
  resume(): Promise<void>;
  /** Stop the workflow service */
  stop(): Promise<void>;
  /** Set core services (called after initialization to resolve circular dependency) */
  setCore(core: CoreServices): void;
  /** Set plugin services (called after plugins are initialized) */
  setPlugins(plugins: Record<string, any>): void;
  /** Update metadata for a workflow instance (used by isolated workflows) */
  updateMetadata(instanceId: string, key: string, value: any): Promise<void>;
}

// ============================================
// Workflow Service Implementation
// ============================================

interface IsolatedProcessInfo {
  pid: number;
  timeout?: ReturnType<typeof setTimeout>;
  heartbeatTimeout?: ReturnType<typeof setTimeout>;
  lastHeartbeat: number;
}

class WorkflowsImpl implements Workflows {
  private adapter: WorkflowAdapter;
  private events?: Events;
  private jobs?: Jobs;
  private sse?: SSE;
  private core?: CoreServices;
  private plugins: Record<string, any> = {};
  private definitions = new Map<string, WorkflowDefinition>();
  private running = new Map<string, { timeout?: ReturnType<typeof setTimeout> }>();
  private pollInterval: number;

  // Isolated execution state
  private socketServer?: WorkflowSocketServer;
  private socketDir: string;
  private tcpPortRange: [number, number];
  private dbPath?: string;
  private heartbeatTimeoutMs: number;
  private workflowModulePaths = new Map<string, string>();
  private isolatedProcesses = new Map<string, IsolatedProcessInfo>();

  constructor(config: WorkflowsConfig = {}) {
    this.adapter = config.adapter ?? new MemoryWorkflowAdapter();
    this.events = config.events;
    this.jobs = config.jobs;
    this.sse = config.sse;
    this.core = config.core;
    this.pollInterval = config.pollInterval ?? 1000;

    // Isolated execution config
    this.socketDir = config.socketDir ?? "/tmp/donkeylabs-workflows";
    this.tcpPortRange = config.tcpPortRange ?? [49152, 65535];
    this.dbPath = config.dbPath;
    this.heartbeatTimeoutMs = config.heartbeatTimeout ?? 60000;
  }

  private getSocketServer(): WorkflowSocketServer {
    if (!this.socketServer) {
      this.socketServer = createWorkflowSocketServer(
        {
          socketDir: this.socketDir,
          tcpPortRange: this.tcpPortRange,
        },
        {
          onEvent: (event) => this.handleIsolatedEvent(event),
          onProxyCall: (request) => this.handleProxyCall(request),
          onConnect: (instanceId) => {
            console.log(`[Workflows] Isolated workflow ${instanceId} connected`);
          },
          onDisconnect: (instanceId) => {
            console.log(`[Workflows] Isolated workflow ${instanceId} disconnected`);
          },
          onError: (error, instanceId) => {
            console.error(`[Workflows] Socket error for ${instanceId}:`, error);
          },
        }
      );
    }
    return this.socketServer;
  }

  setCore(core: CoreServices): void {
    this.core = core;
    // Extract DB path if using Kysely adapter (for isolated workflows)
    if (!this.dbPath && (core.db as any)?.getExecutor) {
      // Try to get the database path from the Kysely instance
      // This is a bit hacky but necessary for isolated workflows
      try {
        const executor = (core.db as any).getExecutor();
        const adapter = executor?.adapter;
        if (adapter?.db?.filename) {
          this.dbPath = adapter.db.filename;
        }
      } catch {
        // Ignore - dbPath might be set manually
      }
    }
  }

  setPlugins(plugins: Record<string, any>): void {
    this.plugins = plugins;
  }

  async updateMetadata(instanceId: string, key: string, value: any): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) return;

    const metadata = { ...(instance.metadata || {}), [key]: value };
    await this.adapter.updateInstance(instanceId, { metadata });
  }

  register(definition: WorkflowDefinition, options?: WorkflowRegisterOptions): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`Workflow "${definition.name}" is already registered`);
    }

    // Validate isolated workflows don't use unsupported step types
    if (definition.isolated !== false) {
      for (const [stepName, step] of definition.steps) {
        if (step.type === "choice" || step.type === "parallel") {
          throw new Error(
            `Workflow "${definition.name}" uses ${step.type} step "${stepName}" ` +
            `which is not supported in isolated mode. Use .isolated(false) to run inline.`
          );
        }
      }
    }

    // Store module path for isolated workflows
    if (options?.modulePath) {
      this.workflowModulePaths.set(definition.name, options.modulePath);
    } else if (definition.isolated !== false) {
      // Warn if isolated workflow has no module path
      console.warn(
        `[Workflows] Workflow "${definition.name}" is isolated but no modulePath provided. ` +
        `Use: workflows.register(myWorkflow, { modulePath: import.meta.url })`
      );
    }

    this.definitions.set(definition.name, definition);
  }

  async start<T = any>(workflowName: string, input: T): Promise<string> {
    const definition = this.definitions.get(workflowName);
    if (!definition) {
      throw new Error(`Workflow "${workflowName}" is not registered`);
    }

    const instance = await this.adapter.createInstance({
      workflowName,
      status: "pending",
      currentStep: definition.startAt,
      input,
      stepResults: {},
      createdAt: new Date(),
    });

    // Emit start event
    await this.emitEvent("workflow.started", {
      instanceId: instance.id,
      workflowName,
      input,
    });

    // SSE broadcast for real-time monitoring
    if (this.sse) {
      this.sse.broadcast(`workflow:${instance.id}`, "started", {
        workflowName,
        input,
      });
      this.sse.broadcast("workflows:all", "workflow.started", {
        instanceId: instance.id,
        workflowName,
        input,
      });
    }

    // Start execution (isolated or inline based on definition.isolated)
    const isIsolated = definition.isolated !== false;
    const modulePath = this.workflowModulePaths.get(workflowName);

    if (isIsolated && modulePath && this.dbPath) {
      // Execute in isolated subprocess
      this.executeIsolatedWorkflow(instance.id, definition, input, modulePath);
    } else {
      // Execute inline (existing behavior)
      if (isIsolated && !modulePath) {
        console.warn(
          `[Workflows] Workflow "${workflowName}" falling back to inline execution (no modulePath)`
        );
      }
      this.executeWorkflow(instance.id, definition);
    }

    return instance.id;
  }

  async getInstance(instanceId: string): Promise<WorkflowInstance | null> {
    return this.adapter.getInstance(instanceId);
  }

  async cancel(instanceId: string): Promise<boolean> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance || instance.status !== "running") {
      return false;
    }

    // Kill isolated process if running
    const isolatedInfo = this.isolatedProcesses.get(instanceId);
    if (isolatedInfo) {
      try {
        process.kill(isolatedInfo.pid, "SIGTERM");
      } catch {
        // Process might already be dead
      }
      if (isolatedInfo.timeout) clearTimeout(isolatedInfo.timeout);
      if (isolatedInfo.heartbeatTimeout) clearTimeout(isolatedInfo.heartbeatTimeout);
      this.isolatedProcesses.delete(instanceId);
      await this.getSocketServer().closeSocket(instanceId);
    }

    // Clear inline timeout
    const runInfo = this.running.get(instanceId);
    if (runInfo?.timeout) {
      clearTimeout(runInfo.timeout);
    }
    this.running.delete(instanceId);

    // Update status
    await this.adapter.updateInstance(instanceId, {
      status: "cancelled",
      completedAt: new Date(),
    });

    await this.emitEvent("workflow.cancelled", {
      instanceId,
      workflowName: instance.workflowName,
    });

    return true;
  }

  async getInstances(workflowName: string, status?: WorkflowStatus): Promise<WorkflowInstance[]> {
    return this.adapter.getInstancesByWorkflow(workflowName, status);
  }

  async getAllInstances(options?: GetAllWorkflowsOptions): Promise<WorkflowInstance[]> {
    return this.adapter.getAllInstances(options);
  }

  async resume(): Promise<void> {
    const running = await this.adapter.getRunningInstances();

    for (const instance of running) {
      const definition = this.definitions.get(instance.workflowName);
      if (!definition) {
        // Workflow no longer registered, mark as failed
        await this.adapter.updateInstance(instance.id, {
          status: "failed",
          error: "Workflow definition not found after restart",
          completedAt: new Date(),
        });
        continue;
      }

      console.log(`[Workflows] Resuming workflow instance ${instance.id}`);

      // Check isolation mode and call appropriate method
      const isIsolated = definition.isolated !== false;
      const modulePath = this.workflowModulePaths.get(instance.workflowName);

      if (isIsolated && modulePath && this.dbPath) {
        this.executeIsolatedWorkflow(instance.id, definition, instance.input, modulePath);
      } else {
        this.executeWorkflow(instance.id, definition);
      }
    }
  }

  async stop(): Promise<void> {
    // Kill all isolated processes
    for (const [instanceId, info] of this.isolatedProcesses) {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        // Process might already be dead
      }
      if (info.timeout) clearTimeout(info.timeout);
      if (info.heartbeatTimeout) clearTimeout(info.heartbeatTimeout);
    }
    this.isolatedProcesses.clear();

    // Shutdown socket server
    if (this.socketServer) {
      await this.socketServer.shutdown();
      this.socketServer = undefined;
    }

    // Clear all inline timeouts
    for (const [instanceId, runInfo] of this.running) {
      if (runInfo.timeout) {
        clearTimeout(runInfo.timeout);
      }
    }
    this.running.clear();

    // Stop adapter (cleanup timers and prevent further DB access)
    if (this.adapter && typeof (this.adapter as any).stop === "function") {
      (this.adapter as any).stop();
    }
  }

  // ============================================
  // Execution Engine
  // ============================================

  private async executeWorkflow(
    instanceId: string,
    definition: WorkflowDefinition
  ): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) return;

    // Mark as running
    if (instance.status === "pending") {
      await this.adapter.updateInstance(instanceId, {
        status: "running",
        startedAt: new Date(),
      });
    }

    // Set up workflow timeout
    if (definition.timeout) {
      const timeout = setTimeout(async () => {
        await this.failWorkflow(instanceId, "Workflow timed out");
      }, definition.timeout);
      this.running.set(instanceId, { timeout });
    } else {
      this.running.set(instanceId, {});
    }

    // Execute current step
    await this.executeStep(instanceId, definition);
  }

  private async executeStep(
    instanceId: string,
    definition: WorkflowDefinition
  ): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance || instance.status !== "running") return;

    const stepName = instance.currentStep;
    if (!stepName) {
      await this.completeWorkflow(instanceId);
      return;
    }

    const step = definition.steps.get(stepName);
    if (!step) {
      await this.failWorkflow(instanceId, `Step "${stepName}" not found`);
      return;
    }

    // Build context
    const ctx = this.buildContext(instance, definition);

    // Emit step started event
    await this.emitEvent("workflow.step.started", {
      instanceId,
      workflowName: instance.workflowName,
      stepName,
      stepType: step.type,
    });

    // Broadcast via SSE
    if (this.sse) {
      this.sse.broadcast(`workflow:${instanceId}`, "step.started", { stepName });
      this.sse.broadcast("workflows:all", "workflow.step.started", {
        instanceId,
        workflowName: instance.workflowName,
        stepName,
      });
    }

    // Update step result as running
    const stepResult: StepResult = {
      stepName,
      status: "running",
      startedAt: new Date(),
      attempts: (instance.stepResults[stepName]?.attempts ?? 0) + 1,
    };
    await this.adapter.updateInstance(instanceId, {
      stepResults: { ...instance.stepResults, [stepName]: stepResult },
    });

    try {
      let output: any;

      switch (step.type) {
        case "task":
          output = await this.executeTaskStep(instanceId, step, ctx, definition);
          break;
        case "parallel":
          output = await this.executeParallelStep(instanceId, step, ctx, definition);
          break;
        case "choice":
          output = await this.executeChoiceStep(instanceId, step, ctx, definition);
          break;
        case "pass":
          output = await this.executePassStep(instanceId, step, ctx);
          break;
      }

      // Step completed successfully
      await this.completeStep(instanceId, stepName, output, step, definition);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.handleStepError(instanceId, stepName, errorMsg, step, definition);
    }
  }

  private async executeTaskStep(
    instanceId: string,
    step: TaskStepDefinition,
    ctx: WorkflowContext,
    definition: WorkflowDefinition
  ): Promise<any> {
    // Determine which API is being used
    const useInlineHandler = !!step.handler;

    if (useInlineHandler) {
      // === NEW API: Inline handler with Zod schemas ===
      let input: any;

      if (step.inputSchema) {
        if (typeof step.inputSchema === "function") {
          // inputSchema is a mapper function: (prev, workflowInput) => input
          input = step.inputSchema(ctx.prev, ctx.input);
        } else {
          // inputSchema is a Zod schema - validate workflow input
          const parseResult = step.inputSchema.safeParse(ctx.input);
          if (!parseResult.success) {
            throw new Error(`Input validation failed: ${parseResult.error.message}`);
          }
          input = parseResult.data;
        }
      } else {
        // No input schema, use workflow input directly
        input = ctx.input;
      }

      // Update step with input
      const instance = await this.adapter.getInstance(instanceId);
      if (instance) {
        const stepResult = instance.stepResults[step.name];
        if (stepResult) {
          stepResult.input = input;
          await this.adapter.updateInstance(instanceId, {
            stepResults: { ...instance.stepResults, [step.name]: stepResult },
          });
        }
      }

      // Execute the inline handler
      let result = await step.handler!(input, ctx);

      // Validate output if schema provided
      if (step.outputSchema) {
        const parseResult = step.outputSchema.safeParse(result);
        if (!parseResult.success) {
          throw new Error(`Output validation failed: ${parseResult.error.message}`);
        }
        result = parseResult.data;
      }

      return result;
    } else {
      // === LEGACY API: Job-based execution ===
      if (!this.jobs) {
        throw new Error("Jobs service not configured");
      }

      if (!step.job) {
        throw new Error("Task step requires either 'handler' or 'job'");
      }

      // Prepare job input
      const jobInput = step.input ? step.input(ctx) : ctx.input;

      // Update step with input
      const instance = await this.adapter.getInstance(instanceId);
      if (instance) {
        const stepResult = instance.stepResults[step.name];
        if (stepResult) {
          stepResult.input = jobInput;
          await this.adapter.updateInstance(instanceId, {
            stepResults: { ...instance.stepResults, [step.name]: stepResult },
          });
        }
      }

      // Enqueue the job
      const jobId = await this.jobs.enqueue(step.job, {
        ...jobInput,
        _workflowInstanceId: instanceId,
        _workflowStepName: step.name,
      });

      // Wait for job completion
      const result = await this.waitForJob(jobId, step.timeout);

      // Transform output if needed
      return step.output ? step.output(result, ctx) : result;
    }
  }

  private async waitForJob(jobId: string, timeout?: number): Promise<any> {
    if (!this.jobs) {
      throw new Error("Jobs service not configured");
    }

    const startTime = Date.now();

    while (true) {
      const job = await this.jobs.get(jobId);

      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      if (job.status === "completed") {
        return job.result;
      }

      if (job.status === "failed") {
        throw new Error(job.error ?? "Job failed");
      }

      // Check timeout
      if (timeout && Date.now() - startTime > timeout) {
        throw new Error("Job timed out");
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }
  }

  private async executeParallelStep(
    instanceId: string,
    step: ParallelStepDefinition,
    ctx: WorkflowContext,
    definition: WorkflowDefinition
  ): Promise<any> {
    const branchPromises: Promise<{ name: string; result: any }>[] = [];
    const branchInstanceIds: string[] = [];

    for (const branchDef of step.branches) {
      // Register branch workflow if not already
      if (!this.definitions.has(branchDef.name)) {
        this.definitions.set(branchDef.name, branchDef);
      }

      // Start branch as sub-workflow
      const branchInstanceId = await this.adapter.createInstance({
        workflowName: branchDef.name,
        status: "pending",
        currentStep: branchDef.startAt,
        input: ctx.input,
        stepResults: {},
        createdAt: new Date(),
        parentId: instanceId,
        branchName: branchDef.name,
      });

      branchInstanceIds.push(branchInstanceId.id);

      // Execute branch
      const branchPromise = (async () => {
        await this.executeWorkflow(branchInstanceId.id, branchDef);

        // Wait for branch completion
        while (true) {
          const branchInstance = await this.adapter.getInstance(branchInstanceId.id);
          if (!branchInstance) {
            throw new Error(`Branch instance ${branchInstanceId.id} not found`);
          }

          if (branchInstance.status === "completed") {
            return { name: branchDef.name, result: branchInstance.output };
          }

          if (branchInstance.status === "failed") {
            throw new Error(branchInstance.error ?? `Branch ${branchDef.name} failed`);
          }

          await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
        }
      })();

      branchPromises.push(branchPromise);
    }

    // Track branch instances
    await this.adapter.updateInstance(instanceId, {
      branchInstances: {
        ...((await this.adapter.getInstance(instanceId))?.branchInstances ?? {}),
        [step.name]: branchInstanceIds,
      },
    });

    // Wait for all branches
    if (step.onError === "wait-all") {
      const results = await Promise.allSettled(branchPromises);
      const output: Record<string, any> = {};
      const errors: string[] = [];

      for (const result of results) {
        if (result.status === "fulfilled") {
          output[result.value.name] = result.value.result;
        } else {
          errors.push(result.reason?.message ?? "Branch failed");
        }
      }

      if (errors.length > 0) {
        throw new Error(`Parallel branches failed: ${errors.join(", ")}`);
      }

      return output;
    } else {
      // fail-fast (default)
      const results = await Promise.all(branchPromises);
      const output: Record<string, any> = {};
      for (const result of results) {
        output[result.name] = result.result;
      }
      return output;
    }
  }

  private async executeChoiceStep(
    instanceId: string,
    step: ChoiceStepDefinition,
    ctx: WorkflowContext,
    definition: WorkflowDefinition
  ): Promise<string> {
    // Evaluate conditions in order
    for (const choice of step.choices) {
      try {
        if (choice.condition(ctx)) {
          // Update current step and continue
          await this.adapter.updateInstance(instanceId, {
            currentStep: choice.next,
          });

          // Mark choice step as complete
          const instance = await this.adapter.getInstance(instanceId);
          if (instance) {
            const stepResult = instance.stepResults[step.name];
            if (stepResult) {
              stepResult.status = "completed";
              stepResult.output = { chosen: choice.next };
              stepResult.completedAt = new Date();
              await this.adapter.updateInstance(instanceId, {
                stepResults: { ...instance.stepResults, [step.name]: stepResult },
              });
            }
          }

          // Emit progress
          await this.emitEvent("workflow.step.completed", {
            instanceId,
            workflowName: (await this.adapter.getInstance(instanceId))?.workflowName,
            stepName: step.name,
            output: { chosen: choice.next },
          });

          // Execute next step
          await this.executeStep(instanceId, definition);
          return choice.next;
        }
      } catch {
        // Condition threw, try next
      }
    }

    // No condition matched, use default
    if (step.default) {
      await this.adapter.updateInstance(instanceId, {
        currentStep: step.default,
      });

      // Mark choice step as complete
      const instance = await this.adapter.getInstance(instanceId);
      if (instance) {
        const stepResult = instance.stepResults[step.name];
        if (stepResult) {
          stepResult.status = "completed";
          stepResult.output = { chosen: step.default };
          stepResult.completedAt = new Date();
          await this.adapter.updateInstance(instanceId, {
            stepResults: { ...instance.stepResults, [step.name]: stepResult },
          });
        }
      }

      await this.emitEvent("workflow.step.completed", {
        instanceId,
        workflowName: instance?.workflowName,
        stepName: step.name,
        output: { chosen: step.default },
      });

      await this.executeStep(instanceId, definition);
      return step.default;
    }

    throw new Error("No choice condition matched and no default specified");
  }

  private async executePassStep(
    instanceId: string,
    step: PassStepDefinition,
    ctx: WorkflowContext
  ): Promise<any> {
    if (step.result !== undefined) {
      return step.result;
    }

    if (step.transform) {
      return step.transform(ctx);
    }

    return ctx.input;
  }

  private buildContext(instance: WorkflowInstance, definition: WorkflowDefinition): WorkflowContext {
    // Build steps object with outputs
    const steps: Record<string, any> = {};
    for (const [name, result] of Object.entries(instance.stepResults)) {
      if (result.status === "completed" && result.output !== undefined) {
        steps[name] = result.output;
      }
    }

    // Find the previous step's output by tracing the workflow path
    let prev: any = undefined;
    if (instance.currentStep) {
      // Find which step comes before current step
      for (const [stepName, stepDef] of definition.steps) {
        if (stepDef.next === instance.currentStep && steps[stepName] !== undefined) {
          prev = steps[stepName];
          break;
        }
      }
      // If no explicit next found, use most recent completed step output
      if (prev === undefined) {
        const completedSteps = Object.entries(instance.stepResults)
          .filter(([, r]) => r.status === "completed" && r.output !== undefined)
          .sort((a, b) => {
            const aTime = a[1].completedAt?.getTime() ?? 0;
            const bTime = b[1].completedAt?.getTime() ?? 0;
            return bTime - aTime;
          });
        if (completedSteps.length > 0) {
          prev = completedSteps[0][1].output;
        }
      }
    }

    // Metadata snapshot (mutable reference for setMetadata updates)
    const metadata = { ...(instance.metadata ?? {}) };

    return {
      input: instance.input,
      steps,
      prev,
      instance,
      getStepResult: <T = any>(stepName: string): T | undefined => {
        return steps[stepName] as T | undefined;
      },
      core: this.core!,
      plugins: this.plugins,
      metadata,
      setMetadata: async (key: string, value: any): Promise<void> => {
        // Update local snapshot
        metadata[key] = value;
        // Persist to database
        await this.adapter.updateInstance(instance.id, {
          metadata: { ...metadata },
        });
      },
      getMetadata: <T = any>(key: string): T | undefined => {
        return metadata[key] as T | undefined;
      },
    };
  }

  private async completeStep(
    instanceId: string,
    stepName: string,
    output: any,
    step: StepDefinition,
    definition: WorkflowDefinition
  ): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) return;

    // Check if workflow is still running (not cancelled/failed/timed out)
    if (instance.status !== "running") {
      console.log(`[Workflows] Ignoring step completion for ${instanceId}, status is ${instance.status}`);
      return;
    }

    // Update step result
    const stepResult = instance.stepResults[stepName] ?? {
      stepName,
      status: "pending",
      attempts: 0,
    };
    stepResult.status = "completed";
    stepResult.output = output;
    stepResult.completedAt = new Date();

    await this.adapter.updateInstance(instanceId, {
      stepResults: { ...instance.stepResults, [stepName]: stepResult },
    });

    // Emit step completed event
    await this.emitEvent("workflow.step.completed", {
      instanceId,
      workflowName: instance.workflowName,
      stepName,
      output,
    });

    // Broadcast step completed via SSE
    if (this.sse) {
      this.sse.broadcast(`workflow:${instanceId}`, "step.completed", {
        stepName,
        output,
      });
      this.sse.broadcast("workflows:all", "workflow.step.completed", {
        instanceId,
        workflowName: instance.workflowName,
        stepName,
      });
    }

    // Calculate and emit progress
    const totalSteps = definition.steps.size;
    const completedSteps = Object.values(instance.stepResults).filter(
      (r) => r.status === "completed"
    ).length + 1; // +1 for current step
    const progress = Math.round((completedSteps / totalSteps) * 100);

    await this.emitEvent("workflow.progress", {
      instanceId,
      workflowName: instance.workflowName,
      progress,
      currentStep: stepName,
      completedSteps,
      totalSteps,
    });

    // Broadcast progress via SSE
    if (this.sse) {
      this.sse.broadcast(`workflow:${instanceId}`, "progress", {
        progress,
        currentStep: stepName,
        completedSteps,
        totalSteps,
      });
      this.sse.broadcast("workflows:all", "workflow.progress", {
        instanceId,
        workflowName: instance.workflowName,
        progress,
        currentStep: stepName,
      });
    }

    // Move to next step or complete
    if (step.end) {
      await this.completeWorkflow(instanceId, output);
    } else if (step.next) {
      await this.adapter.updateInstance(instanceId, {
        currentStep: step.next,
      });
      await this.executeStep(instanceId, definition);
    } else {
      // No next step, complete
      await this.completeWorkflow(instanceId, output);
    }
  }

  private async handleStepError(
    instanceId: string,
    stepName: string,
    error: string,
    step: StepDefinition,
    definition: WorkflowDefinition
  ): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) return;

    const stepResult = instance.stepResults[stepName] ?? {
      stepName,
      status: "pending",
      attempts: 0,
    };

    // Check retry config
    const retry = step.retry ?? definition.defaultRetry;
    if (retry && stepResult.attempts < retry.maxAttempts) {
      // Retry with backoff
      const backoffRate = retry.backoffRate ?? 2;
      const intervalMs = retry.intervalMs ?? 1000;
      const maxIntervalMs = retry.maxIntervalMs ?? 30000;
      const delay = Math.min(
        intervalMs * Math.pow(backoffRate, stepResult.attempts - 1),
        maxIntervalMs
      );

      console.log(
        `[Workflows] Retrying step ${stepName} in ${delay}ms (attempt ${stepResult.attempts}/${retry.maxAttempts})`
      );

      await this.emitEvent("workflow.step.retry", {
        instanceId,
        workflowName: instance.workflowName,
        stepName,
        attempt: stepResult.attempts,
        maxAttempts: retry.maxAttempts,
        delay,
        error,
      });

      // Update step result
      stepResult.error = error;
      await this.adapter.updateInstance(instanceId, {
        stepResults: { ...instance.stepResults, [stepName]: stepResult },
      });

      // Retry after delay
      setTimeout(() => {
        this.executeStep(instanceId, definition);
      }, delay);

      return;
    }

    // No more retries, fail the step
    stepResult.status = "failed";
    stepResult.error = error;
    stepResult.completedAt = new Date();

    await this.adapter.updateInstance(instanceId, {
      stepResults: { ...instance.stepResults, [stepName]: stepResult },
    });

    await this.emitEvent("workflow.step.failed", {
      instanceId,
      workflowName: instance.workflowName,
      stepName,
      error,
      attempts: stepResult.attempts,
    });

    // Broadcast step failed via SSE
    if (this.sse) {
      this.sse.broadcast(`workflow:${instanceId}`, "step.failed", {
        stepName,
        error,
      });
      this.sse.broadcast("workflows:all", "workflow.step.failed", {
        instanceId,
        workflowName: instance.workflowName,
        stepName,
        error,
      });
    }

    // Fail the workflow
    await this.failWorkflow(instanceId, `Step "${stepName}" failed: ${error}`);
  }

  private async completeWorkflow(instanceId: string, output?: any): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) return;

    // Check if workflow is still running (not cancelled/failed/timed out)
    if (instance.status !== "running") {
      console.log(`[Workflows] Ignoring workflow completion for ${instanceId}, status is ${instance.status}`);
      return;
    }

    // Clear timeout
    const runInfo = this.running.get(instanceId);
    if (runInfo?.timeout) {
      clearTimeout(runInfo.timeout);
    }
    this.running.delete(instanceId);

    await this.adapter.updateInstance(instanceId, {
      status: "completed",
      output,
      completedAt: new Date(),
      currentStep: undefined,
    });

    await this.emitEvent("workflow.completed", {
      instanceId,
      workflowName: instance.workflowName,
      output,
    });

    // Broadcast via SSE
    if (this.sse) {
      this.sse.broadcast(`workflow:${instanceId}`, "completed", { output });
      this.sse.broadcast("workflows:all", "workflow.completed", {
        instanceId,
        workflowName: instance.workflowName,
      });
    }
  }

  private async failWorkflow(instanceId: string, error: string): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) return;

    // Clear timeout
    const runInfo = this.running.get(instanceId);
    if (runInfo?.timeout) {
      clearTimeout(runInfo.timeout);
    }
    this.running.delete(instanceId);

    await this.adapter.updateInstance(instanceId, {
      status: "failed",
      error,
      completedAt: new Date(),
    });

    await this.emitEvent("workflow.failed", {
      instanceId,
      workflowName: instance.workflowName,
      error,
    });

    // Broadcast via SSE
    if (this.sse) {
      this.sse.broadcast(`workflow:${instanceId}`, "failed", { error });
      this.sse.broadcast("workflows:all", "workflow.failed", {
        instanceId,
        workflowName: instance.workflowName,
        error,
      });
    }
  }

  private async emitEvent(event: string, data: any): Promise<void> {
    if (this.events) {
      await this.events.emit(event, data);
    }
  }

  // ============================================
  // Isolated Execution Engine
  // ============================================

  /**
   * Execute a workflow in an isolated subprocess
   */
  private async executeIsolatedWorkflow(
    instanceId: string,
    definition: WorkflowDefinition,
    input: any,
    modulePath: string
  ): Promise<void> {
    const socketServer = this.getSocketServer();

    // Create socket for this workflow instance
    const { socketPath, tcpPort } = await socketServer.createSocket(instanceId);

    // Mark workflow as running
    await this.adapter.updateInstance(instanceId, {
      status: "running",
      startedAt: new Date(),
    });

    // Get the executor path
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const executorPath = join(currentDir, "workflow-executor.ts");

    // Prepare config for the executor
    const config = {
      instanceId,
      workflowName: definition.name,
      input,
      socketPath,
      tcpPort,
      modulePath,
      dbPath: this.dbPath,
    };

    // Spawn the subprocess
    const proc = Bun.spawn(["bun", "run", executorPath], {
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        // Ensure the subprocess can import from the same paths
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
      },
    });

    // Send config via stdin
    proc.stdin.write(JSON.stringify(config));
    proc.stdin.end();

    // Track the process
    this.isolatedProcesses.set(instanceId, {
      pid: proc.pid,
      lastHeartbeat: Date.now(),
    });

    // Set up workflow timeout
    if (definition.timeout) {
      const timeoutHandle = setTimeout(async () => {
        await this.handleIsolatedTimeout(instanceId, proc.pid);
      }, definition.timeout);
      const info = this.isolatedProcesses.get(instanceId);
      if (info) info.timeout = timeoutHandle;
    }

    // Set up heartbeat timeout
    this.resetHeartbeatTimeout(instanceId, proc.pid);

    // Handle process exit
    proc.exited.then(async (exitCode) => {
      const info = this.isolatedProcesses.get(instanceId);
      if (info) {
        if (info.timeout) clearTimeout(info.timeout);
        if (info.heartbeatTimeout) clearTimeout(info.heartbeatTimeout);
        this.isolatedProcesses.delete(instanceId);
      }
      await socketServer.closeSocket(instanceId);

      // Check if workflow is still running (crashed before completion)
      const instance = await this.adapter.getInstance(instanceId);
      if (instance && instance.status === "running") {
        console.error(`[Workflows] Isolated workflow ${instanceId} crashed with exit code ${exitCode}`);
        await this.failWorkflow(instanceId, `Subprocess crashed with exit code ${exitCode}`);
      }
    });
  }

  /**
   * Handle events from isolated workflow subprocess
   */
  private async handleIsolatedEvent(event: WorkflowEvent): Promise<void> {
    const { instanceId, type } = event;

    // Reset heartbeat timeout on any event
    const info = this.isolatedProcesses.get(instanceId);
    if (info) {
      info.lastHeartbeat = Date.now();
      this.resetHeartbeatTimeout(instanceId, info.pid);
    }

    switch (type) {
      case "started":
        // Already marked as running in executeIsolatedWorkflow
        break;

      case "heartbeat":
        // Heartbeat handled above
        break;

      case "step.started": {
        const instance = await this.adapter.getInstance(instanceId);
        if (!instance) break;

        // Update current step and step results in DB
        const stepResult = {
          stepName: event.stepName!,
          status: "running" as const,
          startedAt: new Date(),
          attempts: (instance.stepResults[event.stepName!]?.attempts ?? 0) + 1,
        };
        await this.adapter.updateInstance(instanceId, {
          currentStep: event.stepName,
          stepResults: { ...instance.stepResults, [event.stepName!]: stepResult },
        });

        await this.emitEvent("workflow.step.started", {
          instanceId,
          workflowName: instance?.workflowName,
          stepName: event.stepName,
        });
        // Broadcast via SSE
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "step.started", {
            stepName: event.stepName,
          });
          this.sse.broadcast("workflows:all", "workflow.step.started", {
            instanceId,
            workflowName: instance?.workflowName,
            stepName: event.stepName,
          });
        }
        break;
      }

      case "step.completed": {
        const instance = await this.adapter.getInstance(instanceId);
        if (!instance) break;

        // Update step results in DB
        const stepResult = instance.stepResults[event.stepName!] ?? {
          stepName: event.stepName!,
          status: "pending" as const,
          startedAt: new Date(),
          attempts: 0,
        };
        stepResult.status = "completed";
        stepResult.output = event.output;
        stepResult.completedAt = new Date();

        await this.adapter.updateInstance(instanceId, {
          stepResults: { ...instance.stepResults, [event.stepName!]: stepResult },
          currentStep: event.nextStep,
        });

        await this.emitEvent("workflow.step.completed", {
          instanceId,
          workflowName: instance?.workflowName,
          stepName: event.stepName,
          output: event.output,
        });
        // Broadcast via SSE
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "step.completed", {
            stepName: event.stepName,
            output: event.output,
          });
          this.sse.broadcast("workflows:all", "workflow.step.completed", {
            instanceId,
            workflowName: instance?.workflowName,
            stepName: event.stepName,
            output: event.output,
          });
        }
        break;
      }

      case "step.failed": {
        const instance = await this.adapter.getInstance(instanceId);
        if (!instance) break;

        // Update step results in DB
        const stepResult = instance.stepResults[event.stepName!] ?? {
          stepName: event.stepName!,
          status: "pending" as const,
          startedAt: new Date(),
          attempts: 0,
        };
        stepResult.status = "failed";
        stepResult.error = event.error;
        stepResult.completedAt = new Date();

        await this.adapter.updateInstance(instanceId, {
          stepResults: { ...instance.stepResults, [event.stepName!]: stepResult },
        });

        await this.emitEvent("workflow.step.failed", {
          instanceId,
          workflowName: instance?.workflowName,
          stepName: event.stepName,
          error: event.error,
        });
        // Broadcast via SSE
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "step.failed", {
            stepName: event.stepName,
            error: event.error,
          });
          this.sse.broadcast("workflows:all", "workflow.step.failed", {
            instanceId,
            workflowName: instance?.workflowName,
            stepName: event.stepName,
            error: event.error,
          });
        }
        break;
      }

      case "progress": {
        const instance = await this.adapter.getInstance(instanceId);
        await this.emitEvent("workflow.progress", {
          instanceId,
          workflowName: instance?.workflowName,
          progress: event.progress,
          completedSteps: event.completedSteps,
          totalSteps: event.totalSteps,
        });
        // Broadcast via SSE
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "progress", {
            progress: event.progress,
            completedSteps: event.completedSteps,
            totalSteps: event.totalSteps,
          });
          this.sse.broadcast("workflows:all", "workflow.progress", {
            instanceId,
            workflowName: instance?.workflowName,
            progress: event.progress,
            completedSteps: event.completedSteps,
            totalSteps: event.totalSteps,
          });
        }
        break;
      }

      case "completed":
        await this.completeWorkflowIsolated(instanceId, event.output);
        break;

      case "failed":
        await this.failWorkflowIsolated(instanceId, event.error ?? "Unknown error");
        break;
    }
  }

  /**
   * Handle proxy calls from isolated subprocess
   */
  private async handleProxyCall(request: ProxyRequest): Promise<any> {
    const { target, service, method, args } = request;

    if (target === "plugin") {
      const plugin = this.plugins[service];
      if (!plugin) {
        throw new Error(`Plugin "${service}" not found`);
      }
      const fn = plugin[method];
      if (typeof fn !== "function") {
        throw new Error(`Method "${method}" not found on plugin "${service}"`);
      }
      return fn.apply(plugin, args);
    } else if (target === "core") {
      if (!this.core) {
        throw new Error("Core services not available");
      }
      const coreService = (this.core as any)[service];
      if (!coreService) {
        throw new Error(`Core service "${service}" not found`);
      }
      const fn = coreService[method];
      if (typeof fn !== "function") {
        throw new Error(`Method "${method}" not found on core service "${service}"`);
      }
      return fn.apply(coreService, args);
    } else {
      throw new Error(`Unknown proxy target: ${target}`);
    }
  }

  /**
   * Reset heartbeat timeout for an isolated workflow
   */
  private resetHeartbeatTimeout(instanceId: string, pid: number): void {
    const info = this.isolatedProcesses.get(instanceId);
    if (!info) return;

    // Clear existing timeout
    if (info.heartbeatTimeout) {
      clearTimeout(info.heartbeatTimeout);
    }

    // Set new timeout
    info.heartbeatTimeout = setTimeout(async () => {
      // Check if process is still alive
      if (!isProcessAlive(pid)) {
        return; // Process already dead, exit handler will handle it
      }

      console.error(`[Workflows] No heartbeat from isolated workflow ${instanceId} for ${this.heartbeatTimeoutMs}ms`);
      await this.handleIsolatedTimeout(instanceId, pid);
    }, this.heartbeatTimeoutMs);
  }

  /**
   * Handle timeout for isolated workflow (workflow timeout or heartbeat timeout)
   */
  private async handleIsolatedTimeout(instanceId: string, pid: number): Promise<void> {
    const info = this.isolatedProcesses.get(instanceId);
    if (!info) return;

    // Kill the process
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process might already be dead
    }

    // Clean up
    if (info.timeout) clearTimeout(info.timeout);
    if (info.heartbeatTimeout) clearTimeout(info.heartbeatTimeout);
    this.isolatedProcesses.delete(instanceId);
    await this.getSocketServer().closeSocket(instanceId);

    // Fail the workflow
    await this.failWorkflow(instanceId, "Workflow timed out");
  }

  /**
   * Complete an isolated workflow (called from event handler)
   */
  private async completeWorkflowIsolated(instanceId: string, output?: any): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) return;

    // Clean up isolated process tracking (process should have exited)
    const info = this.isolatedProcesses.get(instanceId);
    if (info) {
      if (info.timeout) clearTimeout(info.timeout);
      if (info.heartbeatTimeout) clearTimeout(info.heartbeatTimeout);
      this.isolatedProcesses.delete(instanceId);
    }

    await this.adapter.updateInstance(instanceId, {
      status: "completed",
      output,
      completedAt: new Date(),
      currentStep: undefined,
    });

    await this.emitEvent("workflow.completed", {
      instanceId,
      workflowName: instance.workflowName,
      output,
    });

    // Broadcast via SSE
    if (this.sse) {
      this.sse.broadcast(`workflow:${instanceId}`, "completed", { output });
      this.sse.broadcast("workflows:all", "workflow.completed", {
        instanceId,
        workflowName: instance.workflowName,
        output,
      });
    }
  }

  /**
   * Fail an isolated workflow (called from event handler)
   */
  private async failWorkflowIsolated(instanceId: string, error: string): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) return;

    // Clean up isolated process tracking
    const info = this.isolatedProcesses.get(instanceId);
    if (info) {
      if (info.timeout) clearTimeout(info.timeout);
      if (info.heartbeatTimeout) clearTimeout(info.heartbeatTimeout);
      this.isolatedProcesses.delete(instanceId);
    }

    await this.adapter.updateInstance(instanceId, {
      status: "failed",
      error,
      completedAt: new Date(),
    });

    await this.emitEvent("workflow.failed", {
      instanceId,
      workflowName: instance.workflowName,
      error,
    });

    // Broadcast via SSE
    if (this.sse) {
      this.sse.broadcast(`workflow:${instanceId}`, "failed", { error });
      this.sse.broadcast("workflows:all", "workflow.failed", {
        instanceId,
        workflowName: instance.workflowName,
        error,
      });
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createWorkflows(config?: WorkflowsConfig): Workflows {
  return new WorkflowsImpl(config);
}
