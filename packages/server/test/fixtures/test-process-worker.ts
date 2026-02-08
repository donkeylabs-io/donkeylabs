#!/usr/bin/env bun
/**
 * Test Worker Script for ProcessClient Integration Tests
 *
 * This script is spawned by the Processes service during tests.
 * It uses ProcessClient to communicate back to the server.
 */

import { ProcessClient } from "../../src/process-client";

// Parse command line args to determine test scenario
const scenario = process.argv[2] ?? "default";
const exitAfter = process.argv[3] ? parseInt(process.argv[3], 10) : 0;

async function main() {
  // Collect server messages for scenarios that need them
  const serverMessages: any[] = [];

  // Test auto-connect via environment variables
  const client = await ProcessClient.connect({
    heartbeatInterval: 1000, // 1 second for faster testing
    reconnectInterval: 500,
    maxReconnectAttempts: 10,
    onMessage: async (message) => {
      serverMessages.push(message);
      // Echo server messages back as events so the test can observe them
      await client.emit("server-message-received", {
        received: message,
        receivedAt: Date.now(),
      });
    },
  });

  console.log(`[TestWorker] Connected as ${client.processId}`);
  console.log(`[TestWorker] Metadata:`, client.metadata);
  console.log(`[TestWorker] Scenario: ${scenario}`);

  // Handle different test scenarios
  switch (scenario) {
    case "emit-events":
      // Emit a series of test events
      await client.emit("started", { timestamp: Date.now() });
      await new Promise((r) => setTimeout(r, 100));

      for (let i = 1; i <= 5; i++) {
        await client.emit("progress", { percent: i * 20, step: i });
        await new Promise((r) => setTimeout(r, 100));
      }

      await client.emit("complete", { result: "success", duration: 500 });
      break;

    case "heartbeat-only":
      // Just stay connected and send heartbeats (handled automatically)
      // Wait for a while to let heartbeats go through
      await new Promise((r) => setTimeout(r, 3000));
      await client.emit("done", { heartbeats: "sent" });
      break;

    case "crash-immediately":
      // Exit with error code immediately
      await client.emit("started", { willCrash: true });
      await new Promise((r) => setTimeout(r, 100));
      client.disconnect();
      process.exit(1);

    case "crash-after-events":
      // Emit some events, then crash
      await client.emit("started", {});
      await client.emit("progress", { percent: 50 });
      await new Promise((r) => setTimeout(r, 100));
      client.disconnect();
      process.exit(1);

    case "long-running":
      // Stay running until told to stop
      await client.emit("started", {});

      // Send periodic progress updates
      let count = 0;
      const interval = setInterval(async () => {
        count++;
        await client.emit("tick", { count });
      }, 500);

      // Handle graceful shutdown
      process.on("SIGTERM", async () => {
        clearInterval(interval);
        await client.emit("stopping", { totalTicks: count });
        client.disconnect();
        process.exit(0);
      });

      // Keep process alive
      await new Promise(() => {});
      break;

    case "metadata-echo":
      // Echo back the metadata we received
      await client.emit("metadata-received", client.metadata);
      break;

    case "server-message":
      // Stay running and echo back any messages from the server
      await client.emit("ready", { waitingForMessages: true });

      // Keep alive until SIGTERM or 10s timeout
      const timeout = setTimeout(() => {
        client.emit("timeout", { messagesReceived: serverMessages.length });
        client.disconnect();
        process.exit(0);
      }, 10000);

      process.on("SIGTERM", async () => {
        clearTimeout(timeout);
        await client.emit("stopping", { messagesReceived: serverMessages.length });
        client.disconnect();
        process.exit(0);
      });

      // Keep process alive
      await new Promise(() => {});
      break;

    case "reconnect-test":
      // Emit initial event, wait for disconnect, then emit more
      await client.emit("phase", { phase: 1 });

      // Wait for server to potentially restart
      await new Promise((r) => setTimeout(r, 2000));

      // If still connected, emit phase 2
      if (client.connected) {
        await client.emit("phase", { phase: 2 });
      }

      await new Promise((r) => setTimeout(r, 1000));
      await client.emit("phase", { phase: 3 });
      break;

    default:
      // Default: emit a single event and exit
      await client.emit("hello", { from: "test-worker", scenario });
      break;
  }

  // Exit after specified delay if provided
  if (exitAfter > 0) {
    await new Promise((r) => setTimeout(r, exitAfter));
  }

  // Graceful disconnect
  client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[TestWorker] Error:", err);
  process.exit(1);
});
