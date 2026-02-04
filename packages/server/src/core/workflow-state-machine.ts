// Workflow State Machine
// Pure state machine that runs in any context (inline or subprocess).
// Communicates through an event callback interface - no knowledge of IPC, SSE, or process management.

import type { CoreServices } from "../core";
import type { LogLevel } from "./logger";
import type { Jobs } from "./jobs";
import type {
  WorkflowAdapter,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowContext,
  StepDefinition,
  TaskStepDefinition,
  ParallelStepDefinition,
  ChoiceStepDefinition,
  PassStepDefinition,
  StepResult,
  RetryConfig,
} from "./workflows";

// ============================================
// Event Callback Interface
// ============================================

export interface StateMachineEvents {
  onStepStarted(instanceId: string, stepName: string, stepType: string): void;
  onStepCompleted(instanceId: string, stepName: string, output: any, nextStep?: string): void;
  onStepFailed(instanceId: string, stepName: string, error: string, attempts: number): void;
  onStepRetry(instanceId: string, stepName: string, attempt: number, max: number, delayMs: number): void;
  onProgress(instanceId: string, progress: number, currentStep: string, completed: number, total: number): void;
  onCompleted(instanceId: string, output: any): void;
  onFailed(instanceId: string, error: string): void;
}

// ============================================
// Configuration
// ============================================

export interface StateMachineConfig {
  adapter: WorkflowAdapter;
  core?: CoreServices;
  plugins: Record<string, any>;
  events: StateMachineEvents;
  jobs?: Jobs;
  /** Poll interval for checking job completion (ms) */
  pollInterval?: number;
  emitCustomEvent?: (payload: {
    instanceId: string;
    workflowName: string;
    event: string;
    data?: Record<string, any>;
  }) => Promise<void>;
  emitLog?: (payload: {
    instanceId: string;
    workflowName: string;
    level: LogLevel;
    message: string;
    data?: Record<string, any>;
  }) => Promise<void>;
}

// ============================================
// State Machine Implementation
// ============================================

export class WorkflowStateMachine {
  private adapter: WorkflowAdapter;
  private core?: CoreServices;
  private plugins: Record<string, any>;
  private events: StateMachineEvents;
  private jobs?: Jobs;
  private pollInterval: number;
  private emitCustomEvent?: StateMachineConfig["emitCustomEvent"];
  private emitLog?: StateMachineConfig["emitLog"];
  private cancelledInstances = new Set<string>();

  constructor(config: StateMachineConfig) {
    this.adapter = config.adapter;
    this.core = config.core;
    this.plugins = config.plugins;
    this.events = config.events;
    this.jobs = config.jobs;
    this.pollInterval = config.pollInterval ?? 1000;
    this.emitCustomEvent = config.emitCustomEvent;
    this.emitLog = config.emitLog;
  }

  /**
   * Run a workflow instance to completion.
   * Iterative while loop over steps - no recursion.
   */
  async run(instanceId: string, definition: WorkflowDefinition): Promise<any> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Workflow instance ${instanceId} not found`);
    }

    // Mark as running if pending
    if (instance.status === "pending") {
      await this.adapter.updateInstance(instanceId, {
        status: "running",
        startedAt: new Date(),
      });
    }

    let currentStepName: string | undefined = instance.currentStep ?? definition.startAt;
    let lastOutput: any;

    // Iterative step execution loop
    while (currentStepName) {
      // Capture as const so TypeScript narrows to string throughout the block
      const stepName = currentStepName;

      // Check for cancellation
      if (this.cancelledInstances.has(instanceId)) {
        this.cancelledInstances.delete(instanceId);
        return lastOutput;
      }

      const step = definition.steps.get(stepName);
      if (!step) {
        const error = `Step "${stepName}" not found in workflow`;
        await this.persistFailure(instanceId, error);
        this.events.onFailed(instanceId, error);
        throw new Error(error);
      }

      // Reload instance for fresh state (step results, metadata)
      const freshInstance = await this.adapter.getInstance(instanceId);
      if (!freshInstance || freshInstance.status !== "running") {
        return lastOutput;
      }

      // Emit step started
      this.events.onStepStarted(instanceId, stepName, step.type);

      // Update step result as running
      const stepResult: StepResult = {
        stepName,
        status: "running",
        startedAt: new Date(),
        attempts: (freshInstance.stepResults[stepName]?.attempts ?? 0) + 1,
      };
      await this.adapter.updateInstance(instanceId, {
        currentStep: stepName,
        stepResults: { ...freshInstance.stepResults, [stepName]: stepResult },
      });

      // Build context
      const ctx = this.buildContext(freshInstance, definition);

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
            output = await this.executeChoiceStep(step, ctx);
            break;
          case "pass":
            output = await this.executePassStep(step, ctx);
            break;
        }

        // Persist step completion
        await this.completeStep(instanceId, stepName, output, step, definition);
        lastOutput = output;

        // Determine next step
        if (step.type === "choice") {
          // Choice step returns { chosen: "nextStepName" }
          currentStepName = output?.chosen;
        } else if (step.end) {
          currentStepName = undefined;
        } else if (step.next) {
          currentStepName = step.next;
        } else {
          currentStepName = undefined;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check retry config
        const latestInstance = await this.adapter.getInstance(instanceId);
        if (!latestInstance) return lastOutput;

        const currentAttempts = latestInstance.stepResults[stepName]?.attempts ?? 1;
        const retry = step.retry ?? definition.defaultRetry;

        if (retry && currentAttempts < retry.maxAttempts) {
          // Retry with backoff
          const backoffRate = retry.backoffRate ?? 2;
          const intervalMs = retry.intervalMs ?? 1000;
          const maxIntervalMs = retry.maxIntervalMs ?? 30000;
          const delay = Math.min(
            intervalMs * Math.pow(backoffRate, currentAttempts - 1),
            maxIntervalMs,
          );

          // Update step with error but keep it retryable
          const retryResult: StepResult = {
            stepName,
            status: "running",
            startedAt: latestInstance.stepResults[stepName]?.startedAt ?? new Date(),
            attempts: currentAttempts,
            error: errorMsg,
          };
          await this.adapter.updateInstance(instanceId, {
            stepResults: { ...latestInstance.stepResults, [stepName]: retryResult },
          });

          this.events.onStepRetry(instanceId, stepName, currentAttempts, retry.maxAttempts, delay);

          // Wait then continue the loop (same step)
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // No more retries - fail the step and workflow
        const failedResult: StepResult = {
          stepName,
          status: "failed",
          startedAt: latestInstance.stepResults[stepName]?.startedAt ?? new Date(),
          completedAt: new Date(),
          attempts: currentAttempts,
          error: errorMsg,
        };
        await this.adapter.updateInstance(instanceId, {
          stepResults: { ...latestInstance.stepResults, [stepName]: failedResult },
        });

        this.events.onStepFailed(instanceId, stepName, errorMsg, currentAttempts);

        const fullError = `Step "${stepName}" failed: ${errorMsg}`;
        await this.persistFailure(instanceId, fullError);
        this.events.onFailed(instanceId, fullError);
        throw error;
      }
    }

    // Workflow completed
    await this.adapter.updateInstance(instanceId, {
      status: "completed",
      output: lastOutput,
      completedAt: new Date(),
      currentStep: undefined,
    });
    this.events.onCompleted(instanceId, lastOutput);

    return lastOutput;
  }

  /**
   * Cooperative cancellation - the state machine checks this flag at step boundaries.
   */
  cancel(instanceId: string): void {
    this.cancelledInstances.add(instanceId);
  }

  // ============================================
  // Step Executors
  // ============================================

  private async executeTaskStep(
    instanceId: string,
    step: TaskStepDefinition,
    ctx: WorkflowContext,
    definition: WorkflowDefinition,
  ): Promise<any> {
    if (step.handler) {
      // Inline handler with Zod schemas
      let input: any;

      if (step.inputSchema) {
        if (typeof step.inputSchema === "function") {
          input = step.inputSchema(ctx.prev, ctx.input);
        } else {
          const parseResult = step.inputSchema.safeParse(ctx.input);
          if (!parseResult.success) {
            throw new Error(`Input validation failed: ${parseResult.error.message}`);
          }
          input = parseResult.data;
        }
      } else {
        input = ctx.input;
      }

      // Persist input on step result
      const instance = await this.adapter.getInstance(instanceId);
      if (instance) {
        const sr = instance.stepResults[step.name];
        if (sr) {
          sr.input = input;
          await this.adapter.updateInstance(instanceId, {
            stepResults: { ...instance.stepResults, [step.name]: sr },
          });
        }
      }

      let result = await step.handler(input, ctx);

      if (step.outputSchema) {
        const parseResult = step.outputSchema.safeParse(result);
        if (!parseResult.success) {
          throw new Error(`Output validation failed: ${parseResult.error.message}`);
        }
        result = parseResult.data;
      }

      return result;
    }

    // Legacy job-based execution
    if (!this.jobs) {
      throw new Error("Jobs service not configured");
    }
    if (!step.job) {
      throw new Error("Task step requires either 'handler' or 'job'");
    }

    const jobInput = step.input ? step.input(ctx) : ctx.input;

    // Persist input on step result
    const instance = await this.adapter.getInstance(instanceId);
    if (instance) {
      const sr = instance.stepResults[step.name];
      if (sr) {
        sr.input = jobInput;
        await this.adapter.updateInstance(instanceId, {
          stepResults: { ...instance.stepResults, [step.name]: sr },
        });
      }
    }

    const jobId = await this.jobs.enqueue(step.job, {
      ...jobInput,
      _workflowInstanceId: instanceId,
      _workflowStepName: step.name,
    });

    const result = await this.waitForJob(jobId, step.timeout);
    return step.output ? step.output(result, ctx) : result;
  }

  private async executeChoiceStep(
    step: ChoiceStepDefinition,
    ctx: WorkflowContext,
  ): Promise<{ chosen: string }> {
    // Evaluate conditions in order
    for (const choice of step.choices) {
      try {
        if (choice.condition(ctx)) {
          return { chosen: choice.next };
        }
      } catch {
        // Condition threw, try next
      }
    }

    // No condition matched, use default
    if (step.default) {
      return { chosen: step.default };
    }

    throw new Error("No choice condition matched and no default specified");
  }

  private async executeParallelStep(
    instanceId: string,
    step: ParallelStepDefinition,
    ctx: WorkflowContext,
    definition: WorkflowDefinition,
  ): Promise<Record<string, any>> {
    const branchInstanceIds: string[] = [];

    // Create sub-instances for each branch
    const branchRuns: Promise<{ name: string; result: any }>[] = [];

    for (const branchDef of step.branches) {
      const branchInstance = await this.adapter.createInstance({
        workflowName: branchDef.name,
        status: "pending",
        currentStep: branchDef.startAt,
        input: ctx.input,
        stepResults: {},
        createdAt: new Date(),
        parentId: instanceId,
        branchName: branchDef.name,
      });
      branchInstanceIds.push(branchInstance.id);

      // Run each branch using the same state machine
      const branchPromise = (async () => {
        const result = await this.run(branchInstance.id, branchDef);
        return { name: branchDef.name, result };
      })();

      branchRuns.push(branchPromise);
    }

    // Track branch instances
    const parentInstance = await this.adapter.getInstance(instanceId);
    if (parentInstance) {
      await this.adapter.updateInstance(instanceId, {
        branchInstances: {
          ...(parentInstance.branchInstances ?? {}),
          [step.name]: branchInstanceIds,
        },
      });
    }

    // Wait for all branches
    if (step.onError === "wait-all") {
      const results = await Promise.allSettled(branchRuns);
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
    }

    // fail-fast (default)
    const results = await Promise.all(branchRuns);
    const output: Record<string, any> = {};
    for (const result of results) {
      output[result.name] = result.result;
    }
    return output;
  }

  private async executePassStep(
    step: PassStepDefinition,
    ctx: WorkflowContext,
  ): Promise<any> {
    if (step.result !== undefined) {
      return step.result;
    }
    if (step.transform) {
      return step.transform(ctx);
    }
    return ctx.input;
  }

  // ============================================
  // Context Building
  // ============================================

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

    // Metadata snapshot
    const metadata = { ...(instance.metadata ?? {}) };
    const adapter = this.adapter;
    const instanceId = instance.id;

    const scopedLogger = this.core?.logger?.scoped("workflow", instance.id);
    const emit = async (event: string, data?: Record<string, any>) => {
      const payload = {
        instanceId: instance.id,
        workflowName: instance.workflowName,
        event,
        data,
      };

      if (this.core?.events) {
        await this.core.events.emit("workflow.event", payload);
        await this.core.events.emit(`workflow.${instance.workflowName}.event`, payload);
        await this.core.events.emit(`workflow.${instance.id}.event`, payload);
      }

      if (this.emitCustomEvent) {
        await this.emitCustomEvent(payload);
      }
    };

    const log = (level: LogLevel, message: string, data?: Record<string, any>) => {
      if (scopedLogger) {
        scopedLogger[level](message, data);
      }
      if (this.emitLog) {
        return this.emitLog({
          instanceId: instance.id,
          workflowName: instance.workflowName,
          level,
          message,
          data,
        });
      }
    };

    const core = this.core
      ? {
          ...this.core,
          logger: scopedLogger ?? this.core.logger,
        }
      : this.core;

    return {
      input: instance.input,
      steps,
      prev,
      instance,
      getStepResult: <T = any>(stepName: string): T | undefined => {
        return steps[stepName] as T | undefined;
      },
      core: core!,
      logger: scopedLogger,
      emit,
      log,
      plugins: this.plugins,
      metadata,
      setMetadata: async (key: string, value: any): Promise<void> => {
        metadata[key] = value;
        await adapter.updateInstance(instanceId, {
          metadata: { ...metadata },
        });
      },
      getMetadata: <T = any>(key: string): T | undefined => {
        return metadata[key] as T | undefined;
      },
    };
  }

  // ============================================
  // Helpers
  // ============================================

  private async completeStep(
    instanceId: string,
    stepName: string,
    output: any,
    step: StepDefinition,
    definition: WorkflowDefinition,
  ): Promise<void> {
    const instance = await this.adapter.getInstance(instanceId);
    if (!instance || instance.status !== "running") return;

    // Update step result
    const stepResult = instance.stepResults[stepName] ?? {
      stepName,
      status: "pending" as const,
      attempts: 0,
    };
    stepResult.status = "completed";
    stepResult.output = output;
    stepResult.completedAt = new Date();

    await this.adapter.updateInstance(instanceId, {
      stepResults: { ...instance.stepResults, [stepName]: stepResult },
    });

    // Determine next step for event
    let nextStep: string | undefined;
    if (step.type === "choice") {
      nextStep = output?.chosen;
    } else if (!step.end && step.next) {
      nextStep = step.next;
    }

    this.events.onStepCompleted(instanceId, stepName, output, nextStep);

    // Calculate progress
    const totalSteps = definition.steps.size;
    const completedSteps = Object.values(instance.stepResults).filter(
      (r) => r.status === "completed",
    ).length + 1; // +1 for current step
    const progress = Math.round((completedSteps / totalSteps) * 100);

    this.events.onProgress(instanceId, progress, stepName, completedSteps, totalSteps);
  }

  private async persistFailure(instanceId: string, error: string): Promise<void> {
    await this.adapter.updateInstance(instanceId, {
      status: "failed",
      error,
      completedAt: new Date(),
    });
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

      if (timeout && Date.now() - startTime > timeout) {
        throw new Error("Job timed out");
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }
  }
}
