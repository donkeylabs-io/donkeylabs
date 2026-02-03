#!/usr/bin/env bun
// Workflow Executor - Subprocess Entry Point
// Executes isolated workflows in a separate process to prevent blocking the main event loop

import { connect } from "node:net";
import type { Socket } from "node:net";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import Database from "bun:sqlite";
import type { WorkflowEvent, ProxyResponse } from "./workflow-socket";
import { WorkflowProxyConnection, createPluginsProxy, createCoreServicesProxy } from "./workflow-proxy";
import type { WorkflowDefinition, WorkflowContext, TaskStepDefinition, StepDefinition } from "./workflows";

// ============================================
// Types
// ============================================

interface ExecutorConfig {
  /** Workflow instance ID */
  instanceId: string;
  /** Workflow name (for importing the definition) */
  workflowName: string;
  /** Input data for the workflow */
  input: any;
  /** Unix socket path to connect to */
  socketPath?: string;
  /** TCP port for Windows */
  tcpPort?: number;
  /** Module path to import workflow definition from */
  modulePath: string;
  /** Database file path */
  dbPath: string;
  /** Initial step results (for resuming) */
  stepResults?: Record<string, any>;
  /** Current step name (for resuming) */
  currentStep?: string;
}

// ============================================
// Main Executor
// ============================================

async function main(): Promise<void> {
  // Read config from stdin
  const stdin = await Bun.stdin.text();
  const config: ExecutorConfig = JSON.parse(stdin);

  const { instanceId, workflowName, input, socketPath, tcpPort, modulePath, dbPath, stepResults, currentStep } = config;

  // Connect to IPC socket
  const socket = await connectToSocket(socketPath, tcpPort);
  const proxyConnection = new WorkflowProxyConnection(socket);

  // Create database connection for workflow adapter
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({
      database: new Database(dbPath),
    }),
  });

  try {
    // Send started event
    sendEvent(socket, {
      type: "started",
      instanceId,
      timestamp: Date.now(),
    });

    // Import the workflow module to get the definition
    const module = await import(modulePath);

    // Find the workflow definition - it could be exported various ways
    let definition: WorkflowDefinition | undefined;

    // Try common export patterns
    for (const key of Object.keys(module)) {
      const exported = module[key];
      if (isWorkflowDefinition(exported) && exported.name === workflowName) {
        definition = exported;
        break;
      }
    }

    // Also check default export
    if (!definition && module.default) {
      if (isWorkflowDefinition(module.default) && module.default.name === workflowName) {
        definition = module.default;
      }
    }

    if (!definition) {
      throw new Error(`Workflow "${workflowName}" not found in module ${modulePath}`);
    }

    // Create proxy context for plugin/core access
    const plugins = createPluginsProxy(proxyConnection);
    const coreServices = createCoreServicesProxy(proxyConnection);

    // Execute the workflow
    const result = await executeWorkflow(
      socket,
      proxyConnection,
      definition,
      instanceId,
      input,
      db,
      plugins,
      coreServices,
      stepResults ?? {},
      currentStep ?? definition.startAt
    );

    // Send completed event
    sendEvent(socket, {
      type: "completed",
      instanceId,
      timestamp: Date.now(),
      output: result,
    });
  } catch (error) {
    // Send failed event
    sendEvent(socket, {
      type: "failed",
      instanceId,
      timestamp: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  } finally {
    proxyConnection.close();
    socket.end();
    await db.destroy();
  }

  process.exit(0);
}

// ============================================
// Socket Connection
// ============================================

function connectToSocket(socketPath?: string, tcpPort?: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let socket: Socket;

    if (socketPath) {
      socket = connect(socketPath);
    } else if (tcpPort) {
      socket = connect(tcpPort, "127.0.0.1");
    } else {
      reject(new Error("No socket path or TCP port provided"));
      return;
    }

    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
  });
}

// ============================================
// Workflow Execution
// ============================================

async function executeWorkflow(
  socket: Socket,
  proxyConnection: WorkflowProxyConnection,
  definition: WorkflowDefinition,
  instanceId: string,
  input: any,
  db: Kysely<any>,
  plugins: Record<string, any>,
  coreServices: Record<string, any>,
  initialStepResults: Record<string, any>,
  startStep: string
): Promise<any> {
  const stepResults: Record<string, any> = { ...initialStepResults };
  let currentStepName: string | undefined = startStep;
  let lastOutput: any;
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  // Start heartbeat
  heartbeatInterval = setInterval(() => {
    sendEvent(socket, {
      type: "heartbeat",
      instanceId,
      timestamp: Date.now(),
    });
  }, 5000); // Every 5 seconds

  try {
    while (currentStepName) {
      const step = definition.steps.get(currentStepName);
      if (!step) {
        throw new Error(`Step "${currentStepName}" not found in workflow`);
      }

      // Send step started event
      sendEvent(socket, {
        type: "step.started",
        instanceId,
        timestamp: Date.now(),
        stepName: currentStepName,
      });

      // Build context for this step
      const ctx = buildContext(
        input,
        stepResults,
        lastOutput,
        instanceId,
        definition,
        currentStepName,
        db,
        plugins,
        coreServices
      );

      // Execute step
      let output: any;
      try {
        output = await executeStep(step, ctx);
      } catch (error) {
        // Check for retry config
        const retry = step.retry ?? definition.defaultRetry;
        const attempts = (stepResults[currentStepName]?.attempts ?? 0) + 1;

        if (retry && attempts < retry.maxAttempts) {
          // Retry logic
          const backoffRate = retry.backoffRate ?? 2;
          const intervalMs = retry.intervalMs ?? 1000;
          const maxIntervalMs = retry.maxIntervalMs ?? 30000;
          const delay = Math.min(
            intervalMs * Math.pow(backoffRate, attempts - 1),
            maxIntervalMs
          );

          stepResults[currentStepName] = {
            stepName: currentStepName,
            status: "pending",
            attempts,
            error: error instanceof Error ? error.message : String(error),
          };

          await new Promise((resolve) => setTimeout(resolve, delay));
          continue; // Retry the same step
        }

        // No more retries, send step failed event
        sendEvent(socket, {
          type: "step.failed",
          instanceId,
          timestamp: Date.now(),
          stepName: currentStepName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Store step result
      stepResults[currentStepName] = {
        stepName: currentStepName,
        status: "completed",
        output,
        completedAt: new Date(),
        attempts: (stepResults[currentStepName]?.attempts ?? 0) + 1,
      };
      lastOutput = output;

      // Send step completed event
      const completedSteps = Object.values(stepResults).filter(
        (r: any) => r.status === "completed"
      ).length;
      const totalSteps = definition.steps.size;
      const progress = Math.round((completedSteps / totalSteps) * 100);

      // Determine next step
      let nextStepName: string | undefined;
      if (step.end) {
        nextStepName = undefined;
      } else if (step.next) {
        nextStepName = step.next;
      }

      sendEvent(socket, {
        type: "step.completed",
        instanceId,
        timestamp: Date.now(),
        stepName: currentStepName,
        output,
        nextStep: nextStepName,
      });

      sendEvent(socket, {
        type: "progress",
        instanceId,
        timestamp: Date.now(),
        progress,
        completedSteps,
        totalSteps,
      });

      // Move to next step
      if (step.end) {
        currentStepName = undefined;
      } else if (step.next) {
        currentStepName = step.next;
      } else {
        currentStepName = undefined;
      }
    }

    return lastOutput;
  } finally {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  }
}

async function executeStep(step: StepDefinition, ctx: WorkflowContext): Promise<any> {
  switch (step.type) {
    case "task":
      return executeTaskStep(step as TaskStepDefinition, ctx);
    case "pass":
      return executePassStep(step, ctx);
    case "choice":
      throw new Error("Choice steps should be handled by main process flow");
    case "parallel":
      throw new Error("Parallel steps should be handled by main process");
    default:
      throw new Error(`Unknown step type: ${(step as any).type}`);
  }
}

async function executeTaskStep(step: TaskStepDefinition, ctx: WorkflowContext): Promise<any> {
  if (!step.handler) {
    throw new Error("Task step requires handler (job-based steps not supported in isolated mode)");
  }

  let input: any;

  if (step.inputSchema) {
    if (typeof step.inputSchema === "function") {
      // Input mapper function
      input = step.inputSchema(ctx.prev, ctx.input);
    } else {
      // Zod schema - validate workflow input
      const parseResult = step.inputSchema.safeParse(ctx.input);
      if (!parseResult.success) {
        throw new Error(`Input validation failed: ${parseResult.error.message}`);
      }
      input = parseResult.data;
    }
  } else {
    input = ctx.input;
  }

  // Execute handler
  let result = await step.handler(input, ctx);

  // Validate output if schema provided
  if (step.outputSchema) {
    const parseResult = step.outputSchema.safeParse(result);
    if (!parseResult.success) {
      throw new Error(`Output validation failed: ${parseResult.error.message}`);
    }
    result = parseResult.data;
  }

  return result;
}

async function executePassStep(step: any, ctx: WorkflowContext): Promise<any> {
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

function buildContext(
  input: any,
  stepResults: Record<string, any>,
  prev: any,
  instanceId: string,
  definition: WorkflowDefinition,
  currentStep: string,
  db: Kysely<any>,
  plugins: Record<string, any>,
  coreServices: Record<string, any>
): WorkflowContext {
  // Build steps object with outputs
  const steps: Record<string, any> = {};
  for (const [name, result] of Object.entries(stepResults)) {
    if ((result as any).status === "completed" && (result as any).output !== undefined) {
      steps[name] = (result as any).output;
    }
  }

  // Create a fake instance for the context
  const instance = {
    id: instanceId,
    workflowName: definition.name,
    status: "running" as const,
    currentStep,
    input,
    stepResults,
    createdAt: new Date(),
    startedAt: new Date(),
    metadata: {},
  };

  // Metadata is stored locally - setMetadata sends via proxy
  const metadata: Record<string, any> = {};

  return {
    input,
    steps,
    prev,
    instance,
    getStepResult: <T = any>(stepName: string): T | undefined => {
      return steps[stepName] as T | undefined;
    },
    core: {
      ...coreServices,
      db,
    } as any,
    plugins,
    metadata,
    setMetadata: async (key: string, value: any): Promise<void> => {
      metadata[key] = value;
      // Update via proxy to persist
      await coreServices.workflows?.updateMetadata?.(instanceId, key, value);
    },
    getMetadata: <T = any>(key: string): T | undefined => {
      return metadata[key] as T | undefined;
    },
  };
}

// ============================================
// Helpers
// ============================================

function sendEvent(socket: Socket, event: WorkflowEvent): void {
  socket.write(JSON.stringify(event) + "\n");
}

function isWorkflowDefinition(obj: any): obj is WorkflowDefinition {
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.name === "string" &&
    obj.steps instanceof Map &&
    typeof obj.startAt === "string"
  );
}

// Run main
main().catch((err) => {
  console.error("[WorkflowExecutor] Fatal error:", err);
  process.exit(1);
});
