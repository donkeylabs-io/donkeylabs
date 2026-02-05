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
import { sql } from "kysely";
import type { CoreServices } from "../core";
import type { Logger, LogLevel } from "./logger";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createWorkflowSocketServer,
  type WorkflowSocketServer,
  type WorkflowEvent,
  type ProxyRequest,
} from "./workflow-socket";
import { isProcessAlive } from "./external-jobs";
import { WorkflowStateMachine, type StateMachineEvents } from "./workflow-state-machine";

// ============================================
// Auto-detect caller module for isolated workflows
// ============================================

const WORKFLOWS_FILE = resolve(fileURLToPath(import.meta.url));

/**
 * Walk the call stack to find the file that invoked build().
 * Returns a file:// URL string or undefined if detection fails.
 */
function captureCallerUrl(): string | undefined {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    const match = line.match(/at\s+(?:.*?\s+\(?)?([^\s():]+):\d+:\d+/);
    if (match) {
      let filePath = match[1];
      if (filePath.startsWith("file://")) filePath = fileURLToPath(filePath);
      if (filePath.startsWith("native")) continue;
      filePath = resolve(filePath);
      if (filePath !== WORKFLOWS_FILE) return pathToFileURL(filePath).href;
    }
  }
  return undefined;
}

// Type helper for Zod schema inference
type ZodSchema = z.ZodTypeAny;
type InferZodOutput<T extends ZodSchema> = z.infer<T>;

// ============================================
// Step Types
// ============================================

export type StepType = "task" | "parallel" | "choice" | "pass" | "poll" | "loop";

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

export interface PollStepResult<T = any> {
  done: boolean;
  result?: T;
}

export interface PollStepDefinition<
  TInput extends ZodSchema = ZodSchema,
  TOutput extends ZodSchema = ZodSchema,
> extends BaseStepDefinition {
  type: "poll";
  /** Wait duration between checks in ms */
  interval: number;
  /** Max total time before failing this step (ms) */
  timeout?: number;
  /** Max number of check cycles before failing */
  maxAttempts?: number;
  /** Input schema or mapper */
  inputSchema?: TInput | ((prev: any, workflowInput: any) => InferZodOutput<TInput>);
  /** Output schema for the final result */
  outputSchema?: TOutput;
  /** Check handler: return done:true to proceed */
  check: (
    input: InferZodOutput<TInput>,
    ctx: WorkflowContext
  ) => Promise<PollStepResult<InferZodOutput<TOutput>>> | PollStepResult<InferZodOutput<TOutput>>;
}

export interface LoopStepDefinition extends BaseStepDefinition {
  type: "loop";
  /** Condition to continue looping */
  condition: (ctx: WorkflowContext) => boolean;
  /** Step name to jump back to when condition is true */
  target: string;
  /** Optional delay before looping (ms) */
  interval?: number;
  /** Max total time before failing this loop (ms) */
  timeout?: number;
  /** Max number of loop iterations before failing */
  maxIterations?: number;
}

export type StepDefinition =
  | TaskStepDefinition
  | ParallelStepDefinition
  | ChoiceStepDefinition
  | PassStepDefinition
  | PollStepDefinition
  | LoopStepDefinition;

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
  /** Auto-detected module URL where this workflow was built. Used as fallback for isolated execution. */
  sourceModule?: string;
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
  pollCount?: number;
  lastPolledAt?: Date;
  loopCount?: number;
  lastLoopedAt?: Date;
  loopStartedAt?: Date;
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
  /** Scoped logger for this workflow instance (source=workflow, sourceId=instanceId) */
  logger?: Logger;
  /** Emit a workflow-scoped custom event */
  emit?: (event: string, data?: Record<string, any>) => Promise<void>;
  /** Write a scoped log entry for this workflow instance */
  log?: (level: LogLevel, message: string, data?: Record<string, any>) => void;
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

  loop(
    name: string,
    config: {
      condition: (ctx: WorkflowContext) => boolean;
      target: string;
      interval?: number;
      timeout?: number;
      maxIterations?: number;
      next?: string;
      end?: boolean;
    }
  ): this {
    const step: LoopStepDefinition = {
      name,
      type: "loop",
      condition: config.condition,
      target: config.target,
      interval: config.interval,
      timeout: config.timeout,
      maxIterations: config.maxIterations,
      next: config.next,
      end: config.end,
    };

    this.addStep(step);
    return this;
  }

  poll<TInput extends ZodSchema = ZodSchema, TOutput extends ZodSchema = ZodSchema>(
    name: string,
    config: {
      check: (
        input: InferZodOutput<TInput>,
        ctx: WorkflowContext
      ) => Promise<PollStepResult<InferZodOutput<TOutput>>> | PollStepResult<InferZodOutput<TOutput>>;
      interval: number;
      timeout?: number;
      maxAttempts?: number;
      inputSchema?: TInput | ((prev: any, workflowInput: any) => InferZodOutput<TInput>);
      outputSchema?: TOutput;
      retry?: RetryConfig;
      next?: string;
      end?: boolean;
    }
  ): this {
    const step: PollStepDefinition<TInput, TOutput> = {
      name,
      type: "poll",
      check: config.check,
      interval: config.interval,
      timeout: config.timeout,
      maxAttempts: config.maxAttempts,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      retry: config.retry,
      next: config.next,
      end: config.end,
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
      sourceModule: captureCallerUrl(),
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
  /** Timeout waiting for isolated subprocess readiness (ms, default: 10000) */
  readyTimeout?: number;
  /** Grace period before SIGKILL when terminating isolated subprocesses (ms, default: 5000) */
  killGraceMs?: number;
  /** SQLite pragmas for isolated subprocess connections */
  sqlitePragmas?: SqlitePragmaConfig;
  /** Disable in-process watchdog timers (use external watchdog instead) */
  useWatchdog?: boolean;
  /** Resume strategy for orphaned workflows (default: "blocking") */
  resumeStrategy?: WorkflowResumeStrategy;
}

export type WorkflowResumeStrategy = "blocking" | "background" | "skip";

export interface SqlitePragmaConfig {
  busyTimeout?: number;
  synchronous?: "OFF" | "NORMAL" | "FULL" | "EXTRA";
  journalMode?: "DELETE" | "TRUNCATE" | "PERSIST" | "MEMORY" | "WAL" | "OFF";
}

/** Options for registering a workflow */
export interface WorkflowRegisterOptions {
  /**
   * Module path for isolated workflows.
   * Auto-detected from the call site of `build()` in most cases.
   * Only needed if the workflow definition is re-exported from a different
   * module than the one that calls `build()`.
   *
   * @example
   * // Usually not needed — auto-detected:
   * workflows.register(myWorkflow);
   *
   * // Override when re-exporting from another module:
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
  resume(options?: { strategy?: WorkflowResumeStrategy }): Promise<void>;
  /** Stop the workflow service */
  stop(): Promise<void>;
  /** Set core services (called after initialization to resolve circular dependency) */
  setCore(core: CoreServices): void;
  /** Resolve dbPath from the database instance (call after setCore, before resume) */
  resolveDbPath(): Promise<void>;
  /** Set plugin services (called after plugins are initialized) */
  setPlugins(plugins: Record<string, any>): void;
  /** Update metadata for a workflow instance (used by isolated workflows) */
  updateMetadata(instanceId: string, key: string, value: any): Promise<void>;
  /** Set plugin metadata for local instantiation in isolated workflows */
  setPluginMetadata(metadata: PluginMetadata): void;
  /** Get resolved SQLite db path (for watchdog) */
  getDbPath(): string | undefined;
}

export interface PluginMetadata {
  names: string[];
  modulePaths: Record<string, string>;
  configs: Record<string, any>;
  dependencies: Record<string, string[]>;
  customErrors: Record<string, Record<string, any>>;
}

// ============================================
// Workflow Service Implementation (Supervisor)
// ============================================

interface IsolatedProcessInfo {
  pid: number;
  timeout?: ReturnType<typeof setTimeout>;
  heartbeatTimeout?: ReturnType<typeof setTimeout>;
  lastHeartbeat: number;
}

class WorkflowsImpl implements Workflows {
  private adapter: WorkflowAdapter;
  private eventsService?: Events;
  private jobs?: Jobs;
  private sse?: SSE;
  private core?: CoreServices;
  private plugins: Record<string, any> = {};
  private definitions = new Map<string, WorkflowDefinition>();
  private running = new Map<string, { timeout?: ReturnType<typeof setTimeout>; sm?: WorkflowStateMachine }>();
  private pollInterval: number;

  // Isolated execution state
  private socketServer?: WorkflowSocketServer;
  private socketDir: string;
  private tcpPortRange: [number, number];
  private dbPath?: string;
  private heartbeatTimeoutMs: number;
  private readyTimeoutMs: number;
  private killGraceMs: number;
  private sqlitePragmas?: SqlitePragmaConfig;
  private useWatchdog: boolean;
  private resumeStrategy!: WorkflowResumeStrategy;
  private workflowModulePaths = new Map<string, string>();
  private isolatedProcesses = new Map<string, IsolatedProcessInfo>();
  private readyWaiters = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  // Plugin metadata for local instantiation in isolated workflows
  private pluginNames: string[] = [];
  private pluginModulePaths: Record<string, string> = {};
  private pluginConfigs: Record<string, any> = {};
  private pluginDependencies: Record<string, string[]> = {};
  private pluginCustomErrors: Record<string, Record<string, any>> = {};

  constructor(config: WorkflowsConfig = {}) {
    this.adapter = config.adapter ?? new MemoryWorkflowAdapter();
    this.eventsService = config.events;
    this.jobs = config.jobs;
    this.sse = config.sse;
    this.core = config.core;
    this.pollInterval = config.pollInterval ?? 1000;

    // Isolated execution config
    this.socketDir = config.socketDir ?? "/tmp/donkeylabs-workflows";
    this.tcpPortRange = config.tcpPortRange ?? [49152, 65535];
    this.dbPath = config.dbPath;
    this.heartbeatTimeoutMs = config.heartbeatTimeout ?? 60000;
    this.readyTimeoutMs = config.readyTimeout ?? 10000;
    this.killGraceMs = config.killGraceMs ?? 5000;
    this.sqlitePragmas = config.sqlitePragmas;
    this.useWatchdog = config.useWatchdog ?? false;
    this.resumeStrategy = config.resumeStrategy ?? "blocking";
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
  }

  async resolveDbPath(): Promise<void> {
    if (this.dbPath) return;
    if (!this.core?.db) return;

    // Use PRAGMA database_list to get the file path — works with any SQLite dialect
    try {
      const result = await sql<{ name: string; file: string }>`PRAGMA database_list`.execute(this.core.db);
      const main = result.rows.find((r) => r.name === "main");
      if (main?.file && main.file !== "" && main.file !== ":memory:") {
        this.dbPath = main.file;
      }
    } catch {
      // Not a SQLite database or PRAGMA not supported — dbPath stays unset
    }
  }

  setPlugins(plugins: Record<string, any>): void {
    this.plugins = plugins;
  }

  setPluginMetadata(metadata: PluginMetadata): void {
    this.pluginNames = metadata.names;
    this.pluginModulePaths = metadata.modulePaths;
    this.pluginConfigs = metadata.configs;
    this.pluginDependencies = metadata.dependencies;
    this.pluginCustomErrors = metadata.customErrors;
  }

  getDbPath(): string | undefined {
    return this.dbPath;
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

    // Resolve module path: explicit option > auto-detected sourceModule
    const modulePath = options?.modulePath ?? definition.sourceModule;
    if (modulePath) {
      this.workflowModulePaths.set(definition.name, modulePath);
    } else if (definition.isolated !== false) {
      // Warn only if neither explicit nor auto-detected path is available
      console.warn(
        `[Workflows] Workflow "${definition.name}" is isolated but no modulePath could be detected. ` +
        `Pass { modulePath: import.meta.url } to register().`
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
      await this.executeIsolatedWorkflow(instance.id, definition, input, modulePath);
    } else {
      // Execute inline using state machine
      if (isIsolated && !modulePath) {
        console.warn(
          `[Workflows] Workflow "${workflowName}" falling back to inline execution (no modulePath)`
        );
      } else if (isIsolated && modulePath && !this.dbPath) {
        console.warn(
          `[Workflows] Workflow "${workflowName}" falling back to inline execution (dbPath could not be auto-detected). ` +
            `Set workflows.dbPath in your server config to enable isolated execution.`
        );
      }
      this.startInlineWorkflow(instance.id, definition);
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
      await killProcessWithGrace(isolatedInfo.pid, this.killGraceMs);
      if (isolatedInfo.timeout) clearTimeout(isolatedInfo.timeout);
      if (isolatedInfo.heartbeatTimeout) clearTimeout(isolatedInfo.heartbeatTimeout);
      this.isolatedProcesses.delete(instanceId);
      await this.getSocketServer().closeSocket(instanceId);
    }

    // Cancel inline state machine if running
    const runInfo = this.running.get(instanceId);
    if (runInfo?.sm) {
      runInfo.sm.cancel(instanceId);
    }
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

  async resume(options?: { strategy?: WorkflowResumeStrategy }): Promise<void> {
    const strategy = options?.strategy ?? this.resumeStrategy;
    const running = await this.adapter.getRunningInstances();

    if (this.dbPath) {
      await this.getSocketServer().cleanOrphanedSockets(
        new Set(running.map((instance) => instance.id))
      );
    }

    if (strategy === "skip") {
      await this.markOrphanedAsFailed(running, "Workflow resume skipped");
      return;
    }

    const resumeInstance = async (instance: WorkflowInstance) => {
      const definition = this.definitions.get(instance.workflowName);
      if (!definition) {
        await this.adapter.updateInstance(instance.id, {
          status: "failed",
          error: "Workflow definition not found after restart",
          completedAt: new Date(),
        });
        return;
      }

      console.log(`[Workflows] Resuming workflow instance ${instance.id}`);

      const isIsolated = definition.isolated !== false;
      const modulePath = this.workflowModulePaths.get(instance.workflowName);

      if (isIsolated && modulePath && this.dbPath) {
        await this.executeIsolatedWorkflow(instance.id, definition, instance.input, modulePath);
      } else {
        this.startInlineWorkflow(instance.id, definition);
      }
    };

    if (strategy === "background") {
      for (const instance of running) {
        resumeInstance(instance).catch((error) => {
          console.error(
            `[Workflows] Failed to resume workflow ${instance.id}:`,
            error instanceof Error ? error.message : String(error)
          );
        });
      }
      return;
    }

    for (const instance of running) {
      try {
        await resumeInstance(instance);
      } catch (error) {
        console.error(
          `[Workflows] Failed to resume workflow ${instance.id}:`,
          error instanceof Error ? error.message : String(error)
        );
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

    // Clear all inline timeouts and cancel state machines
    for (const [instanceId, runInfo] of this.running) {
      if (runInfo.sm) {
        runInfo.sm.cancel(instanceId);
      }
      if (runInfo.timeout) {
        clearTimeout(runInfo.timeout);
      }
    }
    this.running.clear();

    for (const [instanceId, waiter] of this.readyWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(`Workflows stopped before ready: ${instanceId}`));
    }
    this.readyWaiters.clear();

    // Stop adapter (cleanup timers and prevent further DB access)
    if (this.adapter && typeof (this.adapter as any).stop === "function") {
      (this.adapter as any).stop();
    }
  }

  // ============================================
  // Inline Execution via State Machine
  // ============================================

  private startInlineWorkflow(
    instanceId: string,
    definition: WorkflowDefinition,
  ): void {
    const sm = new WorkflowStateMachine({
      adapter: this.adapter,
      core: this.core,
      plugins: this.plugins,
      events: this.createInlineEventHandler(instanceId),
      jobs: this.jobs,
      pollInterval: this.pollInterval,
    });

    // Set up workflow timeout
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (definition.timeout) {
      timeout = setTimeout(async () => {
        sm.cancel(instanceId);
        await this.adapter.updateInstance(instanceId, {
          status: "failed",
          error: "Workflow timed out",
          completedAt: new Date(),
        });
        await this.emitEvent("workflow.failed", {
          instanceId,
          workflowName: definition.name,
          error: "Workflow timed out",
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "failed", { error: "Workflow timed out" });
          this.sse.broadcast("workflows:all", "workflow.failed", {
            instanceId,
            workflowName: definition.name,
            error: "Workflow timed out",
          });
        }
        this.running.delete(instanceId);
      }, definition.timeout);
    }

    this.running.set(instanceId, { timeout, sm });

    // Run the state machine (fire and forget - events handle communication)
    sm.run(instanceId, definition).then(() => {
      // Clean up timeout on completion
      const runInfo = this.running.get(instanceId);
      if (runInfo?.timeout) {
        clearTimeout(runInfo.timeout);
      }
      this.running.delete(instanceId);
    }).catch(() => {
      // State machine already persisted the failure - just clean up
      const runInfo = this.running.get(instanceId);
      if (runInfo?.timeout) {
        clearTimeout(runInfo.timeout);
      }
      this.running.delete(instanceId);
    });
  }

  /**
   * Create an event handler that bridges state machine events to Events service + SSE
   */
  private createInlineEventHandler(instanceId: string): StateMachineEvents {
    return {
      onStepStarted: (id, stepName, stepType) => {
        this.emitEvent("workflow.step.started", {
          instanceId: id,
          stepName,
          stepType,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${id}`, "step.started", { stepName });
          this.sse.broadcast("workflows:all", "workflow.step.started", {
            instanceId: id,
            stepName,
          });
        }
      },
      onStepCompleted: (id, stepName, output, nextStep) => {
        this.emitEvent("workflow.step.completed", {
          instanceId: id,
          stepName,
          output,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${id}`, "step.completed", { stepName, output });
          this.sse.broadcast("workflows:all", "workflow.step.completed", {
            instanceId: id,
            stepName,
          });
        }
      },
      onStepFailed: (id, stepName, error, attempts) => {
        this.emitEvent("workflow.step.failed", {
          instanceId: id,
          stepName,
          error,
          attempts,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${id}`, "step.failed", { stepName, error });
          this.sse.broadcast("workflows:all", "workflow.step.failed", {
            instanceId: id,
            stepName,
            error,
          });
        }
      },
      onStepPoll: (id, stepName, pollCount, done, result) => {
        this.emitEvent("workflow.step.poll", {
          instanceId: id,
          stepName,
          pollCount,
          done,
          result,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${id}`, "step.poll", {
            stepName,
            pollCount,
            done,
            result,
          });
          this.sse.broadcast("workflows:all", "workflow.step.poll", {
            instanceId: id,
            stepName,
            pollCount,
            done,
            result,
          });
        }
      },
      onStepLoop: (id, stepName, loopCount, target) => {
        this.emitEvent("workflow.step.loop", {
          instanceId: id,
          stepName,
          loopCount,
          target,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${id}`, "step.loop", {
            stepName,
            loopCount,
            target,
          });
          this.sse.broadcast("workflows:all", "workflow.step.loop", {
            instanceId: id,
            stepName,
            loopCount,
            target,
          });
        }
      },
      onStepRetry: (id, stepName, attempt, max, delayMs) => {
        this.emitEvent("workflow.step.retry", {
          instanceId: id,
          stepName,
          attempt,
          maxAttempts: max,
          delay: delayMs,
        });
      },
      onProgress: (id, progress, currentStep, completed, total) => {
        this.emitEvent("workflow.progress", {
          instanceId: id,
          progress,
          currentStep,
          completedSteps: completed,
          totalSteps: total,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${id}`, "progress", {
            progress,
            currentStep,
            completedSteps: completed,
            totalSteps: total,
          });
          this.sse.broadcast("workflows:all", "workflow.progress", {
            instanceId: id,
            progress,
            currentStep,
          });
        }
      },
      onCompleted: (id, output) => {
        this.emitEvent("workflow.completed", {
          instanceId: id,
          output,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${id}`, "completed", { output });
          this.sse.broadcast("workflows:all", "workflow.completed", {
            instanceId: id,
          });
        }
      },
      onFailed: (id, error) => {
        this.emitEvent("workflow.failed", {
          instanceId: id,
          error,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${id}`, "failed", { error });
          this.sse.broadcast("workflows:all", "workflow.failed", {
            instanceId: id,
            error,
          });
        }
      },
    };
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

    const pluginNames = this.pluginNames.length > 0
      ? this.pluginNames
      : Object.keys(this.pluginModulePaths);

    if (pluginNames.length === 0 && Object.keys(this.plugins).length > 0) {
      throw new Error(
        "[Workflows] Plugin metadata is required for isolated workflows. " +
          "Call workflows.setPluginMetadata() during server initialization."
      );
    }

    const missingModulePaths = pluginNames.filter((name) => !this.pluginModulePaths[name]);
    if (missingModulePaths.length > 0) {
      throw new Error(
        `[Workflows] Missing module paths for plugins: ${missingModulePaths.join(", ")}. ` +
          `Ensure plugins are created with createPlugin.define() and registered before workflows start.`
      );
    }

    const pluginConfigs = serializePluginConfigsOrThrow(this.pluginConfigs, pluginNames);
    const coreConfig = serializeCoreConfigOrThrow(this.core?.config);

    // Create socket for this workflow instance
    const { socketPath, tcpPort } = await socketServer.createSocket(instanceId);

    // Get the executor path
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const executorPath = join(currentDir, "workflow-executor.ts");

    // Prepare config for the executor, including plugin metadata for local instantiation
    const config = {
      instanceId,
      workflowName: definition.name,
      input,
      socketPath,
      tcpPort,
      modulePath,
      dbPath: this.dbPath,
      pluginNames,
      pluginModulePaths: this.pluginModulePaths,
      pluginConfigs,
      coreConfig,
      sqlitePragmas: this.sqlitePragmas,
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

    const instance = await this.adapter.getInstance(instanceId);
    const metadata = { ...(instance?.metadata ?? {}) } as Record<string, any>;
    metadata.__watchdog = {
      ...(metadata.__watchdog ?? {}),
      pid: proc.pid,
      socketPath,
      tcpPort,
      lastHeartbeat: new Date().toISOString(),
    };
    await this.adapter.updateInstance(instanceId, { metadata });

    const exitBeforeReady = proc.exited.then((exitCode) => {
      throw new Error(`Subprocess exited before ready (code ${exitCode})`);
    });

    try {
      await Promise.race([this.waitForIsolatedReady(instanceId), exitBeforeReady]);
    } catch (error) {
      await this.handleIsolatedStartFailure(instanceId, proc.pid, error);
      exitBeforeReady.catch(() => undefined);
      throw error;
    }
    exitBeforeReady.catch(() => undefined);

    // Handle process exit
    proc.exited.then(async (exitCode) => {
      const info = this.isolatedProcesses.get(instanceId);
      if (info) {
        if (info.timeout) clearTimeout(info.timeout);
        if (info.heartbeatTimeout) clearTimeout(info.heartbeatTimeout);
        this.isolatedProcesses.delete(instanceId);
      }
      await socketServer.closeSocket(instanceId);

      // Check if workflow is still pending/running (crashed before completion)
      const instance = await this.adapter.getInstance(instanceId);
      if (instance && (instance.status === "running" || instance.status === "pending")) {
        console.error(`[Workflows] Isolated workflow ${instanceId} crashed with exit code ${exitCode}`);
        await this.adapter.updateInstance(instanceId, {
          status: "failed",
          error: `Subprocess crashed with exit code ${exitCode}`,
          completedAt: new Date(),
        });
        await this.emitEvent("workflow.failed", {
          instanceId,
          workflowName: instance.workflowName,
          error: `Subprocess crashed with exit code ${exitCode}`,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "failed", {
            error: `Subprocess crashed with exit code ${exitCode}`,
          });
          this.sse.broadcast("workflows:all", "workflow.failed", {
            instanceId,
            workflowName: instance.workflowName,
            error: `Subprocess crashed with exit code ${exitCode}`,
          });
        }
      }
    });
  }

  /**
   * Handle events from isolated workflow subprocess.
   * The subprocess owns persistence via its own adapter - we only forward events to SSE/Events.
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
      case "ready": {
        this.resolveIsolatedReady(instanceId);
        break;
      }

      case "started":
      case "heartbeat":
        // Update heartbeat tracking metadata
        await this.updateWatchdogHeartbeat(instanceId);
        break;

      case "step.started": {
        await this.emitEvent("workflow.step.started", {
          instanceId,
          stepName: event.stepName,
          stepType: event.stepType,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "step.started", {
            stepName: event.stepName,
          });
          this.sse.broadcast("workflows:all", "workflow.step.started", {
            instanceId,
            stepName: event.stepName,
          });
        }
        break;
      }

      case "step.completed": {
        await this.emitEvent("workflow.step.completed", {
          instanceId,
          stepName: event.stepName,
          output: event.output,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "step.completed", {
            stepName: event.stepName,
            output: event.output,
          });
          this.sse.broadcast("workflows:all", "workflow.step.completed", {
            instanceId,
            stepName: event.stepName,
            output: event.output,
          });
        }
        break;
      }

      case "step.failed": {
        await this.emitEvent("workflow.step.failed", {
          instanceId,
          stepName: event.stepName,
          error: event.error,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "step.failed", {
            stepName: event.stepName,
            error: event.error,
          });
          this.sse.broadcast("workflows:all", "workflow.step.failed", {
            instanceId,
            stepName: event.stepName,
            error: event.error,
          });
        }
        break;
      }

      case "step.poll": {
        await this.emitEvent("workflow.step.poll", {
          instanceId,
          stepName: event.stepName,
          pollCount: event.pollCount,
          done: event.done,
          result: event.result,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "step.poll", {
            stepName: event.stepName,
            pollCount: event.pollCount,
            done: event.done,
            result: event.result,
          });
          this.sse.broadcast("workflows:all", "workflow.step.poll", {
            instanceId,
            stepName: event.stepName,
            pollCount: event.pollCount,
            done: event.done,
            result: event.result,
          });
        }
        break;
      }

      case "step.loop": {
        await this.emitEvent("workflow.step.loop", {
          instanceId,
          stepName: event.stepName,
          loopCount: event.loopCount,
          target: event.target,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "step.loop", {
            stepName: event.stepName,
            loopCount: event.loopCount,
            target: event.target,
          });
          this.sse.broadcast("workflows:all", "workflow.step.loop", {
            instanceId,
            stepName: event.stepName,
            loopCount: event.loopCount,
            target: event.target,
          });
        }
        break;
      }

      case "progress": {
        await this.emitEvent("workflow.progress", {
          instanceId,
          progress: event.progress,
          completedSteps: event.completedSteps,
          totalSteps: event.totalSteps,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "progress", {
            progress: event.progress,
            completedSteps: event.completedSteps,
            totalSteps: event.totalSteps,
          });
          this.sse.broadcast("workflows:all", "workflow.progress", {
            instanceId,
            progress: event.progress,
            completedSteps: event.completedSteps,
            totalSteps: event.totalSteps,
          });
        }
        break;
      }

      case "event": {
        const workflowName = event.workflowName ?? (await this.adapter.getInstance(instanceId))?.workflowName;
        const payload = {
          instanceId,
          workflowName,
          event: event.event,
          data: event.data,
        };

        const ssePayload = {
          id: `workflow_event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          event: event.event,
          stepName: event.data?.stepName,
          data: event.data,
          createdAt: new Date().toISOString(),
        };

        await this.emitEvent("workflow.event", payload);
        if (workflowName) {
          await this.emitEvent(`workflow.${workflowName}.event`, payload);
        }
        await this.emitEvent(`workflow.${instanceId}.event`, payload);

        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "event", ssePayload);
          this.sse.broadcast("workflows:all", "workflow.event", {
            ...ssePayload,
            instanceId,
            workflowName,
          });
        }
        break;
      }

      case "log": {
        const workflowName = event.workflowName ?? (await this.adapter.getInstance(instanceId))?.workflowName;

        const ssePayload = {
          id: `workflow_log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          level: event.level,
          event: "log",
          stepName: event.data?.stepName,
          message: event.message,
          data: event.data,
          createdAt: new Date().toISOString(),
        };

        if (this.core?.logs && event.level && event.message) {
          this.core.logs.write({
            level: event.level,
            message: event.message,
            source: "workflow",
            sourceId: instanceId,
            data: event.data,
            context: workflowName ? { workflowName } : undefined,
          });
        }

        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "log", ssePayload);
        }
        break;
      }

      case "completed": {
        // Clean up isolated process tracking
        this.cleanupIsolatedProcess(instanceId);
        this.resolveIsolatedReady(instanceId);

        // Subprocess already persisted state - just emit events
        await this.emitEvent("workflow.completed", {
          instanceId,
          output: event.output,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "completed", { output: event.output });
          this.sse.broadcast("workflows:all", "workflow.completed", { instanceId });
        }
        break;
      }

      case "failed": {
        // Clean up isolated process tracking
        this.cleanupIsolatedProcess(instanceId);
        this.rejectIsolatedReady(instanceId, new Error(event.error ?? "Isolated workflow failed"));

        // Subprocess already persisted state - just emit events
        await this.emitEvent("workflow.failed", {
          instanceId,
          error: event.error,
        });
        if (this.sse) {
          this.sse.broadcast(`workflow:${instanceId}`, "failed", { error: event.error });
          this.sse.broadcast("workflows:all", "workflow.failed", {
            instanceId,
            error: event.error,
          });
        }
        break;
      }
    }
  }

  private waitForIsolatedReady(instanceId: string): Promise<void> {
    const existing = this.readyWaiters.get(instanceId);
    if (existing) {
      return existing.promise;
    }

    let resolveFn!: () => void;
    let rejectFn!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const timeout = setTimeout(() => {
      this.readyWaiters.delete(instanceId);
      rejectFn(new Error(`Timed out waiting for isolated workflow ${instanceId} readiness`));
    }, this.readyTimeoutMs);

    this.readyWaiters.set(instanceId, {
      promise,
      resolve: () => resolveFn(),
      reject: (error) => rejectFn(error),
      timeout,
    });

    return promise;
  }

  private resolveIsolatedReady(instanceId: string): void {
    const waiter = this.readyWaiters.get(instanceId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.readyWaiters.delete(instanceId);
    waiter.resolve();
  }

  private rejectIsolatedReady(instanceId: string, error: Error): void {
    const waiter = this.readyWaiters.get(instanceId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.readyWaiters.delete(instanceId);
    waiter.reject(error);
  }

  private async handleIsolatedStartFailure(
    instanceId: string,
    pid: number,
    error: unknown
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process might already be dead
    }

    this.cleanupIsolatedProcess(instanceId);
    await this.getSocketServer().closeSocket(instanceId);

    const instance = await this.adapter.getInstance(instanceId);
    if (instance && (instance.status === "pending" || instance.status === "running")) {
      await this.adapter.updateInstance(instanceId, {
        status: "failed",
        error: errorMessage,
        completedAt: new Date(),
      });

      await this.emitEvent("workflow.failed", {
        instanceId,
        workflowName: instance.workflowName,
        error: errorMessage,
      });

      if (this.sse) {
        this.sse.broadcast(`workflow:${instanceId}`, "failed", { error: errorMessage });
        this.sse.broadcast("workflows:all", "workflow.failed", {
          instanceId,
          workflowName: instance.workflowName,
          error: errorMessage,
        });
      }
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
   * Clean up isolated process tracking
   */
  private cleanupIsolatedProcess(instanceId: string): void {
    const info = this.isolatedProcesses.get(instanceId);
    if (info) {
      if (info.timeout) clearTimeout(info.timeout);
      if (info.heartbeatTimeout) clearTimeout(info.heartbeatTimeout);
      this.isolatedProcesses.delete(instanceId);
    }
    this.rejectIsolatedReady(instanceId, new Error("Isolated workflow cleaned up"));
  }

  private async updateWatchdogHeartbeat(instanceId: string): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) return;
    const metadata = { ...(instance.metadata ?? {}) } as Record<string, any>;
    metadata.__watchdog = {
      ...(metadata.__watchdog ?? {}),
      lastHeartbeat: new Date().toISOString(),
    };
    await this.adapter.updateInstance(instanceId, { metadata });
  }

  private async markOrphanedAsFailed(
    instances: WorkflowInstance[],
    reason: string
  ): Promise<void> {
    for (const instance of instances) {
      await this.adapter.updateInstance(instance.id, {
        status: "failed",
        error: reason,
        completedAt: new Date(),
      });

      await this.emitEvent("workflow.failed", {
        instanceId: instance.id,
        workflowName: instance.workflowName,
        error: reason,
      });

      if (this.sse) {
        this.sse.broadcast(`workflow:${instance.id}`, "failed", { error: reason });
        this.sse.broadcast("workflows:all", "workflow.failed", {
          instanceId: instance.id,
          workflowName: instance.workflowName,
          error: reason,
        });
      }
    }
  }

  /**
   * Reset heartbeat timeout for an isolated workflow
   */
  private resetHeartbeatTimeout(instanceId: string, pid: number): void {
    if (this.useWatchdog) return;
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
      await this.emitEvent("workflow.watchdog.stale", {
        instanceId,
        reason: "heartbeat",
        timeoutMs: this.heartbeatTimeoutMs,
      });
      await this.handleIsolatedTimeout(instanceId, pid);
    }, this.heartbeatTimeoutMs);
  }

  /**
   * Handle timeout for isolated workflow (workflow timeout or heartbeat timeout)
   */
  private async handleIsolatedTimeout(instanceId: string, pid: number): Promise<void> {
    const info = this.isolatedProcesses.get(instanceId);
    if (!info) return;

    await killProcessWithGrace(pid, this.killGraceMs);
    await this.emitEvent("workflow.watchdog.killed", {
      instanceId,
      reason: "timeout",
      timeoutMs: this.heartbeatTimeoutMs,
    });

    // Clean up
    if (info.timeout) clearTimeout(info.timeout);
    if (info.heartbeatTimeout) clearTimeout(info.heartbeatTimeout);
    this.isolatedProcesses.delete(instanceId);
    await this.getSocketServer().closeSocket(instanceId);

    // Fail the workflow
    await this.adapter.updateInstance(instanceId, {
      status: "failed",
      error: "Workflow timed out",
      completedAt: new Date(),
    });
    await this.emitEvent("workflow.failed", {
      instanceId,
      error: "Workflow timed out",
    });
    if (this.sse) {
      this.sse.broadcast(`workflow:${instanceId}`, "failed", { error: "Workflow timed out" });
      this.sse.broadcast("workflows:all", "workflow.failed", {
        instanceId,
        error: "Workflow timed out",
      });
    }
  }

  private async emitEvent(event: string, data: any): Promise<void> {
    if (this.eventsService) {
      await this.eventsService.emit(event, data);
    }
  }
}

// ============================================
// Helpers
// ============================================

function serializePluginConfigsOrThrow(
  configs: Record<string, any>,
  pluginNames: string[]
): Record<string, any> {
  const result: Record<string, any> = {};
  const failures: string[] = [];

  for (const name of pluginNames) {
    if (!(name in configs)) continue;
    try {
      assertJsonSerializable(configs[name], `pluginConfigs.${name}`);
      const serialized = JSON.stringify(configs[name]);
      result[name] = JSON.parse(serialized);
    } catch {
      failures.push(name);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[Workflows] Non-serializable plugin config(s): ${failures.join(", ")}. ` +
        `Provide JSON-serializable configs for isolated workflows.`
    );
  }

  return result;
}

function serializeCoreConfigOrThrow(config?: Record<string, any>): Record<string, any> | undefined {
  if (!config) return undefined;
  try {
    assertJsonSerializable(config, "coreConfig");
    const serialized = JSON.stringify(config);
    return JSON.parse(serialized);
  } catch {
    throw new Error(
      "[Workflows] Core config is not JSON-serializable. Provide JSON-serializable values for isolated workflows."
    );
  }
}

function assertJsonSerializable(value: any, path: string, seen = new WeakSet<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new Error(`[Workflows] Non-serializable value at ${path}`);
  }

  if (typeof value === "bigint") {
    throw new Error(`[Workflows] Non-serializable bigint at ${path}`);
  }

  if (value instanceof Date) {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertJsonSerializable(value[i], `${path}[${i}]`, seen);
    }
    return;
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new Error(`[Workflows] Circular reference at ${path}`);
    }
    seen.add(value);

    if (!isPlainObject(value)) {
      throw new Error(`[Workflows] Non-serializable object at ${path}`);
    }

    for (const [key, nested] of Object.entries(value)) {
      assertJsonSerializable(nested, `${path}.${key}`, seen);
    }
    return;
  }
}

function isPlainObject(value: Record<string, any>): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ============================================
// Factory Function
// ============================================

export function createWorkflows(config?: WorkflowsConfig): Workflows {
  return new WorkflowsImpl(config);
}

async function killProcessWithGrace(pid: number, graceMs: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  if (graceMs <= 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, graceMs));

  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited
  }
}
