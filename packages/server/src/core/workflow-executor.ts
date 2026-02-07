#!/usr/bin/env bun
// Workflow Executor - Subprocess Entry Point
// Bootstraps core services and plugins locally for isolated workflows.

import { connect } from "node:net";
import type { Socket } from "node:net";
import type { WorkflowEvent } from "./workflow-socket";
import type { WorkflowDefinition } from "./workflows";
import { WorkflowStateMachine, type StateMachineEvents } from "./workflow-state-machine";
import { bootstrapSubprocess } from "./subprocess-bootstrap";

// ============================================
// Types
// ============================================

interface ExecutorConfig {
  instanceId: string;
  workflowName: string;
  input: any;
  socketPath?: string;
  tcpPort?: number;
  modulePath: string;
  dbPath?: string;
  pluginNames: string[];
  pluginModulePaths: Record<string, string>;
  pluginConfigs: Record<string, any>;
  coreConfig?: Record<string, any>;
  sqlitePragmas?: {
    busyTimeout?: number;
    synchronous?: "OFF" | "NORMAL" | "FULL" | "EXTRA";
    journalMode?: "DELETE" | "TRUNCATE" | "PERSIST" | "MEMORY" | "WAL" | "OFF";
  };
  database?: {
    type: "sqlite" | "postgres" | "mysql";
    connectionString: string;
  };
}

// ============================================
// Main Executor
// ============================================

async function main(): Promise<void> {
  // Read config from stdin
  const stdin = await Bun.stdin.text();
  const config: ExecutorConfig = JSON.parse(stdin);

  const {
    instanceId,
    workflowName,
    socketPath,
    tcpPort,
    modulePath,
    dbPath,
    pluginNames,
    pluginModulePaths,
    pluginConfigs,
    coreConfig,
    sqlitePragmas,
    database,
  } = config;

  const socket = await connectToSocket(socketPath, tcpPort);

  let cleanup: (() => Promise<void>) | undefined;
  let exitCode = 0;

  // Start heartbeat
  const heartbeatInterval = setInterval(() => {
    sendEvent(socket, {
      type: "heartbeat",
      instanceId,
      timestamp: Date.now(),
    });
  }, 5000);

  try {
    // Import the workflow module to get the definition
    const module = await import(modulePath);
    const definition = findWorkflowDefinition(module, workflowName, modulePath);

    const bootstrap = await bootstrapSubprocess({
      dbPath,
      database,
      coreConfig,
      sqlitePragmas,
      pluginMetadata: {
        names: pluginNames,
        modulePaths: pluginModulePaths,
        configs: pluginConfigs,
      },
    });
    cleanup = bootstrap.cleanup;

    sendEvent(socket, {
      type: "ready",
      instanceId,
      timestamp: Date.now(),
    });

    const sm = new WorkflowStateMachine({
      adapter: bootstrap.workflowAdapter,
      core: bootstrap.core as any,
      plugins: bootstrap.manager.getServices(),
      events: createIpcEventBridge(socket, instanceId),
      pollInterval: 1000,
      emitCustomEvent: async (payload) => {
        sendEvent(socket, {
          type: "event",
          instanceId: payload.instanceId,
          workflowName: payload.workflowName,
          timestamp: Date.now(),
          event: payload.event,
          data: payload.data,
        });
      },
      emitLog: async (payload) => {
        sendEvent(socket, {
          type: "log",
          instanceId: payload.instanceId,
          workflowName: payload.workflowName,
          timestamp: Date.now(),
          level: payload.level,
          message: payload.message,
          data: payload.data,
        });
      },
    });

    sendEvent(socket, {
      type: "started",
      instanceId,
      timestamp: Date.now(),
    });

    // Run the state machine to completion
    const result = await sm.run(instanceId, definition);

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
    exitCode = 1;
  } finally {
    clearInterval(heartbeatInterval);
    socket.end();
    if (cleanup) {
      await cleanup();
    }
  }

  process.exit(exitCode);
}

// ============================================
// IPC Event Bridge
// ============================================

function createIpcEventBridge(socket: Socket, instanceId: string): StateMachineEvents {
  return {
    onStepStarted: (id, stepName, stepType) => {
      sendEvent(socket, {
        type: "step.started",
        instanceId: id,
        timestamp: Date.now(),
        stepName,
        stepType,
      });
    },
    onStepCompleted: (id, stepName, output, nextStep) => {
      sendEvent(socket, {
        type: "step.completed",
        instanceId: id,
        timestamp: Date.now(),
        stepName,
        output,
        nextStep,
      });
    },
    onStepFailed: (id, stepName, error, attempts) => {
      sendEvent(socket, {
        type: "step.failed",
        instanceId: id,
        timestamp: Date.now(),
        stepName,
        error,
      });
    },
    onStepPoll: (id, stepName, pollCount, done, result) => {
      sendEvent(socket, {
        type: "step.poll",
        instanceId: id,
        timestamp: Date.now(),
        stepName,
        pollCount,
        done,
        result,
      });
    },
    onStepLoop: (id, stepName, loopCount, target) => {
      sendEvent(socket, {
        type: "step.loop",
        instanceId: id,
        timestamp: Date.now(),
        stepName,
        loopCount,
        target,
      });
    },
    onStepRetry: () => {
      // Retry is internal to the state machine - no IPC event needed
    },
    onProgress: (id, progress, currentStep, completed, total) => {
      sendEvent(socket, {
        type: "progress",
        instanceId: id,
        timestamp: Date.now(),
        stepName: currentStep,
        progress,
        completedSteps: completed,
        totalSteps: total,
      });
    },
    onCompleted: () => {
      // Handled by the main try/catch after sm.run() returns
    },
    onFailed: () => {
      // Handled by the main try/catch after sm.run() throws
    },
  };
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
// Helpers
// ============================================

function sendEvent(socket: Socket, event: WorkflowEvent): void {
  socket.write(JSON.stringify(event) + "\n");
}

function findWorkflowDefinition(
  module: any,
  workflowName: string,
  modulePath: string,
): WorkflowDefinition {
  // Try named exports
  for (const key of Object.keys(module)) {
    const exported = module[key];
    if (isWorkflowDefinition(exported) && exported.name === workflowName) {
      return exported;
    }
  }

  // Try default export
  if (module.default && isWorkflowDefinition(module.default) && module.default.name === workflowName) {
    return module.default;
  }

  throw new Error(`Workflow "${workflowName}" not found in module ${modulePath}`);
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
