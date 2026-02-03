#!/usr/bin/env bun
// Workflow Executor - Subprocess Entry Point
// Thin shell that creates a WorkflowStateMachine with IPC event bridge.
// The state machine owns all execution logic and persistence.

import { connect } from "node:net";
import type { Socket } from "node:net";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import Database from "bun:sqlite";
import type { WorkflowEvent } from "./workflow-socket";
import { WorkflowProxyConnection, createPluginsProxy, createCoreServicesProxy } from "./workflow-proxy";
import type { WorkflowDefinition } from "./workflows";
import { KyselyWorkflowAdapter } from "./workflow-adapter-kysely";
import { WorkflowStateMachine, type StateMachineEvents } from "./workflow-state-machine";

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
  dbPath: string;
}

// ============================================
// Main Executor
// ============================================

async function main(): Promise<void> {
  // Read config from stdin
  const stdin = await Bun.stdin.text();
  const config: ExecutorConfig = JSON.parse(stdin);

  const { instanceId, workflowName, socketPath, tcpPort, modulePath, dbPath } = config;

  // Connect to IPC socket
  const socket = await connectToSocket(socketPath, tcpPort);
  const proxyConnection = new WorkflowProxyConnection(socket);

  // Create database connection + adapter (subprocess owns its own persistence)
  const sqlite = new Database(dbPath);
  sqlite.run("PRAGMA busy_timeout = 5000");
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: sqlite }),
  });
  const adapter = new KyselyWorkflowAdapter(db, { cleanupDays: 0 });

  // Start heartbeat
  const heartbeatInterval = setInterval(() => {
    sendEvent(socket, {
      type: "heartbeat",
      instanceId,
      timestamp: Date.now(),
    });
  }, 5000);

  try {
    // Send started event
    sendEvent(socket, {
      type: "started",
      instanceId,
      timestamp: Date.now(),
    });

    // Import the workflow module to get the definition
    const module = await import(modulePath);
    const definition = findWorkflowDefinition(module, workflowName, modulePath);

    // Create proxy objects for plugin/core access via IPC
    const plugins = createPluginsProxy(proxyConnection);
    const coreServices = createCoreServicesProxy(proxyConnection);

    // Wrap coreServices proxy so that `db` resolves locally instead of via IPC.
    // Spreading a Proxy with no ownKeys trap loses all proxied properties.
    const coreWithDb = new Proxy(coreServices, {
      get(target, prop, receiver) {
        if (prop === "db") return db;
        return Reflect.get(target, prop, receiver);
      },
    });

    // Create state machine with IPC event bridge
    const sm = new WorkflowStateMachine({
      adapter,
      core: coreWithDb as any,
      plugins,
      events: createIpcEventBridge(socket, instanceId),
      pollInterval: 1000,
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
    process.exit(1);
  } finally {
    clearInterval(heartbeatInterval);
    proxyConnection.close();
    socket.end();
    adapter.stop();
    await db.destroy();
  }

  process.exit(0);
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
    onStepRetry: () => {
      // Retry is internal to the state machine - no IPC event needed
    },
    onProgress: (id, progress, currentStep, completed, total) => {
      sendEvent(socket, {
        type: "progress",
        instanceId: id,
        timestamp: Date.now(),
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
