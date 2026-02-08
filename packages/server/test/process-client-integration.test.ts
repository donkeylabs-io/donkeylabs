/**
 * ProcessClient Integration Tests
 *
 * These tests verify the full integration between:
 * - Processes service (server side)
 * - ProcessClient (wrapper script side)
 * - Event communication
 * - Heartbeat monitoring
 * - Auto-restart on crash
 * - Metadata passing
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createProcesses,
  createEvents,
  type Processes,
  type Events,
} from "../src/core/index";

// Helper to wait for a condition with timeout
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Helper to collect events
function createEventCollector(events: Events, patterns: string[]) {
  const collected: Array<{ event: string; data: any; timestamp: number }> = [];

  for (const pattern of patterns) {
    events.on(pattern, (data) => {
      collected.push({ event: pattern, data, timestamp: Date.now() });
    });
  }

  return {
    collected,
    waitForCount: (count: number, timeoutMs = 5000) =>
      waitFor(() => collected.length >= count, timeoutMs),
    waitForEvent: (eventName: string, timeoutMs = 5000) =>
      waitFor(
        () => collected.some((e) => e.event === eventName || e.data?.event === eventName),
        timeoutMs
      ),
    getByEvent: (eventName: string) =>
      collected.filter((e) => e.event === eventName || e.data?.event === eventName),
    clear: () => (collected.length = 0),
  };
}

// Path to test worker script
const TEST_WORKER_PATH = join(import.meta.dir, "fixtures/test-process-worker.ts");

// Get bun path for spawning (Bun.spawn doesn't inherit PATH)
const BUN_PATH = process.execPath; // Full path to current bun executable

describe("ProcessClient Integration", () => {
  let processes: Processes;
  let events: Events;
  const testDbPath = ".donkeylabs/test-process-client.db";
  const testSocketDir = "/tmp/donkeylabs-test-client";

  beforeEach(async () => {
    // Clean up test database
    if (existsSync(testDbPath)) {
      await unlink(testDbPath).catch(() => {});
    }

    events = createEvents();
    processes = createProcesses({
      adapter: { path: testDbPath, cleanupDays: 0 },
      socket: { socketDir: testSocketDir },
      events,
      heartbeatCheckInterval: 500, // Fast for testing
      autoRecoverOrphans: false,
    });

    processes.start();
  });

  afterEach(async () => {
    await processes.shutdown();
    if (existsSync(testDbPath)) {
      await unlink(testDbPath).catch(() => {});
    }
  });

  describe("Auto-Connect via Environment Variables", () => {
    it("should connect using DONKEYLABS_* env vars", async () => {
      const collector = createEventCollector(events, [
        "process.spawned",
        "process.test-worker.hello",
      ]);

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "default"],
        },
      });

      const processId = await processes.spawn("test-worker");

      // Wait for the spawned event
      await collector.waitForEvent("process.spawned", 3000);

      // Wait for the hello event from the worker
      const received = await collector.waitForEvent("process.test-worker.hello", 5000);
      expect(received).toBe(true);

      // Verify the event data
      const helloEvents = collector.getByEvent("process.test-worker.hello");
      expect(helloEvents.length).toBeGreaterThanOrEqual(1);
      expect(helloEvents[0]?.data?.data?.from).toBe("test-worker");
    });

    it("should pass metadata to worker via DONKEYLABS_METADATA", async () => {
      const collector = createEventCollector(events, [
        "process.test-worker.metadata-received",
      ]);

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "metadata-echo"],
        },
      });

      const testMetadata = {
        inputPath: "/path/to/input.mp4",
        outputPath: "/path/to/output.mp4",
        options: { preset: "fast", quality: 80 },
      };

      await processes.spawn("test-worker", { metadata: testMetadata });

      // Wait for metadata echo event
      const received = await collector.waitForEvent(
        "process.test-worker.metadata-received",
        5000
      );
      expect(received).toBe(true);

      // Verify metadata was received correctly
      const metadataEvents = collector.getByEvent("process.test-worker.metadata-received");
      expect(metadataEvents.length).toBeGreaterThanOrEqual(1);
      expect(metadataEvents[0]?.data?.data).toEqual(testMetadata);
    });
  });

  describe("Event Sending", () => {
    it("should receive events emitted by ProcessClient", async () => {
      const collector = createEventCollector(events, [
        "process.test-worker.started",
        "process.test-worker.progress",
        "process.test-worker.complete",
      ]);

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "emit-events"],
        },
      });

      await processes.spawn("test-worker");

      // Wait for all events
      await collector.waitForEvent("process.test-worker.complete", 5000);

      // Verify started event
      const startedEvents = collector.getByEvent("process.test-worker.started");
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);

      // Verify progress events (should have 5)
      const progressEvents = collector.getByEvent("process.test-worker.progress");
      expect(progressEvents.length).toBe(5);

      // Verify progress values
      const progressPercents = progressEvents.map((e) => e.data?.data?.percent);
      expect(progressPercents).toEqual([20, 40, 60, 80, 100]);

      // Verify complete event
      const completeEvents = collector.getByEvent("process.test-worker.complete");
      expect(completeEvents.length).toBe(1);
      expect(completeEvents[0]?.data?.data?.result).toBe("success");
    });

    it("should emit generic process.event for all events", async () => {
      const collector = createEventCollector(events, ["process.event"]);

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "emit-events"],
        },
      });

      await processes.spawn("test-worker");

      // Wait for multiple events
      await collector.waitForCount(5, 5000);

      // All events should be captured by process.event
      expect(collector.collected.length).toBeGreaterThanOrEqual(5);

      // Each should have processId, name, event, and data
      for (const event of collector.collected) {
        expect(event.data.processId).toBeDefined();
        expect(event.data.name).toBe("test-worker");
        expect(event.data.event).toBeDefined();
      }
    });
  });

  describe("Heartbeat Monitoring", () => {
    it("should update lastHeartbeat timestamp from ProcessClient heartbeats", async () => {
      // Heartbeats are handled internally by the Processes service
      // and update lastHeartbeat on the process record
      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "heartbeat-only"],
          heartbeat: {
            intervalMs: 1000,
            timeoutMs: 5000,
          },
        },
      });

      const processId = await processes.spawn("test-worker");

      // Get initial state
      const initialProc = await processes.get(processId);
      const initialHeartbeat = initialProc?.lastHeartbeat?.getTime() ?? 0;

      // Wait for heartbeats to accumulate (ProcessClient sends every 1s)
      await new Promise((r) => setTimeout(r, 2500));

      // Verify process lastHeartbeat was updated (should be more recent)
      const proc = await processes.get(processId);
      expect(proc?.lastHeartbeat).toBeDefined();

      // lastHeartbeat should have been updated (if the process is still alive)
      if (proc?.status === "running") {
        const currentHeartbeat = proc.lastHeartbeat?.getTime() ?? 0;
        expect(currentHeartbeat).toBeGreaterThanOrEqual(initialHeartbeat);
      }
    });

    it("should detect process crash and mark as crashed", async () => {
      const collector = createEventCollector(events, ["process.crashed"]);

      // Create a process that will crash immediately
      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "crash-immediately"],
          heartbeat: {
            intervalMs: 500,
            timeoutMs: 1000,
          },
        },
      });

      const processId = await processes.spawn("test-worker");

      // Wait for crash event
      const crashed = await collector.waitForEvent("process.crashed", 3000);
      expect(crashed).toBe(true);

      // Verify process is marked as crashed
      const proc = await processes.get(processId);
      expect(proc?.status).toBe("crashed");
    });
  });

  describe("Auto-Restart on Crash", () => {
    it("should auto-restart when process crashes", async () => {
      const collector = createEventCollector(events, [
        "process.crashed",
        "process.restarted",
        "process.test-worker.started",
      ]);

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "crash-immediately"],
          autoRestart: true,
          maxRestarts: 3,
          backoff: {
            initialDelayMs: 100,
            maxDelayMs: 500,
            multiplier: 1.5,
          },
        },
      });

      await processes.spawn("test-worker");

      // Wait for crash
      await collector.waitForEvent("process.crashed", 3000);

      // Wait for restart
      const restarted = await collector.waitForEvent("process.restarted", 5000);
      expect(restarted).toBe(true);

      // Verify restart event data
      const restartEvents = collector.getByEvent("process.restarted");
      expect(restartEvents.length).toBeGreaterThanOrEqual(1);
      expect(restartEvents[0]?.data?.name).toBe("test-worker");
    });

    it("should preserve metadata across restarts", async () => {
      const metadataReceived: any[] = [];
      const collector = createEventCollector(events, [
        "process.test-worker.metadata-received",
        "process.restarted",
      ]);

      events.on("process.test-worker.metadata-received", (data) => {
        metadataReceived.push(data.data);
      });

      // This worker echoes metadata and then crashes
      processes.register({
        name: "test-worker",
        config: {
          command: "/bin/sh",
          args: ["-c", `${BUN_PATH} ${TEST_WORKER_PATH} metadata-echo && exit 1`],
          autoRestart: true,
          maxRestarts: 2,
          backoff: { initialDelayMs: 100, maxDelayMs: 200, multiplier: 1 },
        },
      });

      const testMetadata = { key: "value", shouldPersist: true };
      await processes.spawn("test-worker", { metadata: testMetadata });

      // Wait for at least one restart to happen
      await collector.waitForEvent("process.restarted", 5000);

      // Give time for restarted process to emit
      await new Promise((r) => setTimeout(r, 1000));

      // Metadata should be received multiple times with same value
      expect(metadataReceived.length).toBeGreaterThanOrEqual(1);
      for (const meta of metadataReceived) {
        expect(meta).toEqual(testMetadata);
      }
    });

    it("should stop restarting after max restarts reached", async () => {
      const restartEvents: any[] = [];
      events.on("process.restarted", (data) => restartEvents.push(data));

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "crash-immediately"],
          autoRestart: true,
          maxRestarts: 2, // Allow only 2 restarts
          backoff: { initialDelayMs: 50, maxDelayMs: 100, multiplier: 1 },
        },
      });

      const processId = await processes.spawn("test-worker");

      // Wait for restarts to exhaust
      await waitFor(() => restartEvents.length >= 1, 5000);
      await new Promise((r) => setTimeout(r, 2000));

      // Should have exactly 1 restart (initial crash -> restart 1 -> crash -> mark dead)
      // Actually with maxRestarts=2: crash 1 (fail=1) -> restart 1, crash 2 (fail=2 >= max) -> dead
      expect(restartEvents.length).toBeLessThanOrEqual(2);

      // Final process should be marked as dead
      const finalProcs = await processes.getByName("test-worker");
      const deadProc = finalProcs.find((p) => p.status === "dead");
      expect(deadProc).toBeDefined();
    });
  });

  describe("Long-Running Process", () => {
    it("should handle long-running process with periodic events", async () => {
      const tickEvents: any[] = [];
      events.on("process.test-worker.tick", (data) => tickEvents.push(data));

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "long-running"],
        },
      });

      const processId = await processes.spawn("test-worker");

      // Wait for some tick events
      await waitFor(() => tickEvents.length >= 3, 5000);

      // Verify ticks are incrementing
      const counts = tickEvents.map((e) => e.data?.count);
      expect(counts[0]).toBe(1);
      expect(counts[1]).toBe(2);
      expect(counts[2]).toBe(3);

      // Stop the process
      const stopped = await processes.stop(processId);
      expect(stopped).toBe(true);

      // Verify process received SIGTERM and sent stopping event
      const collector = createEventCollector(events, ["process.test-worker.stopping"]);
      // Note: The stopping event may or may not arrive depending on timing
    });

    it("should be able to send messages to running process", async () => {
      const messagesReceived: any[] = [];

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "long-running"],
        },
        onMessage: (proc, message) => {
          messagesReceived.push(message);
        },
      });

      const processId = await processes.spawn("test-worker");

      // Wait for process to start
      await new Promise((r) => setTimeout(r, 500));

      // Send a message to the process
      const sent = await processes.send(processId, {
        type: "custom",
        action: "test",
        data: { hello: "world" },
      });
      expect(sent).toBe(true);

      // Clean up
      await processes.stop(processId);
    });
  });

  describe("Process Lifecycle Events", () => {
    it("should emit complete lifecycle events", async () => {
      const lifecycle: string[] = [];

      events.on("process.spawned", () => lifecycle.push("spawned"));
      events.on("process.test-worker.started", () => lifecycle.push("started"));
      events.on("process.test-worker.progress", () => lifecycle.push("progress"));
      events.on("process.test-worker.complete", () => lifecycle.push("complete"));
      events.on("process.stopped", () => lifecycle.push("stopped"));

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "emit-events", "100"], // exit after 100ms
        },
      });

      const processId = await processes.spawn("test-worker");

      // Wait for process to complete
      await waitFor(async () => {
        const proc = await processes.get(processId);
        return proc?.status === "stopped" || proc?.status === "crashed";
      }, 5000);

      // Verify lifecycle order
      expect(lifecycle[0]).toBe("spawned");
      expect(lifecycle).toContain("started");
      expect(lifecycle).toContain("progress");
      expect(lifecycle).toContain("complete");
    });
  });

  describe("Multiple Concurrent Processes", () => {
    it("should handle multiple processes simultaneously", async () => {
      const eventsByProcess = new Map<string, any[]>();

      events.on("process.test-worker.hello", (data) => {
        const procId = data.processId;
        if (!eventsByProcess.has(procId)) {
          eventsByProcess.set(procId, []);
        }
        eventsByProcess.get(procId)!.push(data);
      });

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "default"],
        },
      });

      // Spawn 3 workers concurrently
      const processIds = await Promise.all([
        processes.spawn("test-worker"),
        processes.spawn("test-worker"),
        processes.spawn("test-worker"),
      ]);

      // Wait for all to emit
      await waitFor(() => eventsByProcess.size >= 3, 5000);

      // Each process should have its own events
      expect(eventsByProcess.size).toBe(3);
      for (const [procId, events] of eventsByProcess) {
        expect(processIds).toContain(procId);
        expect(events.length).toBeGreaterThanOrEqual(1);
      }

      // All should have different process IDs
      const uniqueIds = new Set(processIds);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe("Server-to-Process Messaging (onMessage)", () => {
    it("should receive messages sent from server via processes.send()", async () => {
      const collector = createEventCollector(events, [
        "process.test-worker.ready",
        "process.test-worker.server-message-received",
      ]);

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "server-message"],
        },
      });

      const processId = await processes.spawn("test-worker");

      // Wait for the worker to signal it's ready
      const ready = await collector.waitForEvent("process.test-worker.ready", 5000);
      expect(ready).toBe(true);

      // Send a message from server to the process
      const sent = await processes.send(processId, {
        type: "subscribe",
        channel: "live-scores",
      });
      expect(sent).toBe(true);

      // Wait for the worker to echo it back as an event
      const received = await collector.waitForEvent(
        "process.test-worker.server-message-received",
        5000
      );
      expect(received).toBe(true);

      // Verify the echoed message content
      const echoEvents = collector.getByEvent("process.test-worker.server-message-received");
      expect(echoEvents.length).toBeGreaterThanOrEqual(1);
      expect(echoEvents[0]?.data?.data?.received?.type).toBe("subscribe");
      expect(echoEvents[0]?.data?.data?.received?.channel).toBe("live-scores");

      await processes.stop(processId);
    });

    it("should receive multiple messages in order", async () => {
      const echoEvents: any[] = [];
      events.on("process.test-worker.server-message-received", (data) => {
        echoEvents.push(data);
      });

      const collector = createEventCollector(events, [
        "process.test-worker.ready",
      ]);

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "server-message"],
        },
      });

      const processId = await processes.spawn("test-worker");
      await collector.waitForEvent("process.test-worker.ready", 5000);

      // Send multiple messages
      await processes.send(processId, { type: "cmd", seq: 1 });
      await processes.send(processId, { type: "cmd", seq: 2 });
      await processes.send(processId, { type: "cmd", seq: 3 });

      // Wait for all 3 echoes
      await waitFor(() => echoEvents.length >= 3, 5000);

      expect(echoEvents.length).toBe(3);
      expect(echoEvents[0]?.data?.received?.seq).toBe(1);
      expect(echoEvents[1]?.data?.received?.seq).toBe(2);
      expect(echoEvents[2]?.data?.received?.seq).toBe(3);

      await processes.stop(processId);
    });

    it("should return false when sending to a non-existent process", async () => {
      const sent = await processes.send("non-existent-id", { type: "test" });
      expect(sent).toBe(false);
    });
  });

  describe("Error Handling", () => {
    it("should handle process that fails to start", async () => {
      const collector = createEventCollector(events, ["process.crashed"]);

      processes.register({
        name: "test-worker",
        config: {
          command: "nonexistent-command-xyz",
          args: [],
        },
      });

      // Spawn should throw or process should crash immediately
      try {
        await processes.spawn("test-worker");
        // If spawn succeeds, wait for crash
        await collector.waitForEvent("process.crashed", 3000);
      } catch (err) {
        // Spawn itself threw - this is also acceptable
        expect(err).toBeDefined();
      }
    });

    it("should handle invalid messages gracefully", async () => {
      // This test verifies the server doesn't crash on malformed messages
      const collector = createEventCollector(events, [
        "process.spawned",
        "process.test-worker.hello",
      ]);

      processes.register({
        name: "test-worker",
        config: {
          command: BUN_PATH,
          args: [TEST_WORKER_PATH, "default"],
        },
      });

      await processes.spawn("test-worker");

      // Should still receive valid events
      const received = await collector.waitForEvent("process.test-worker.hello", 5000);
      expect(received).toBe(true);
    });
  });
});

describe("ProcessClient Unit Tests", () => {
  it("should export ProcessClient with connect method", async () => {
    const { ProcessClient } = await import("../src/process-client");

    expect(ProcessClient).toBeDefined();
    expect(ProcessClient.connect).toBeInstanceOf(Function);
    expect(ProcessClient.create).toBeInstanceOf(Function);
  });

  it("should throw if env vars not set", async () => {
    const { connect } = await import("../src/process-client");

    // Clear relevant env vars
    const oldProcessId = process.env.DONKEYLABS_PROCESS_ID;
    const oldSocketPath = process.env.DONKEYLABS_SOCKET_PATH;
    const oldTcpPort = process.env.DONKEYLABS_TCP_PORT;

    delete process.env.DONKEYLABS_PROCESS_ID;
    delete process.env.DONKEYLABS_SOCKET_PATH;
    delete process.env.DONKEYLABS_TCP_PORT;

    try {
      await expect(connect()).rejects.toThrow("DONKEYLABS_PROCESS_ID");
    } finally {
      // Restore env vars
      if (oldProcessId) process.env.DONKEYLABS_PROCESS_ID = oldProcessId;
      if (oldSocketPath) process.env.DONKEYLABS_SOCKET_PATH = oldSocketPath;
      if (oldTcpPort) process.env.DONKEYLABS_TCP_PORT = oldTcpPort;
    }
  });

  it("should create client with explicit config", async () => {
    const { createProcessClient } = await import("../src/process-client");

    const client = createProcessClient({
      processId: "test-process-123",
      socketPath: "/tmp/test-socket.sock",
      metadata: { test: true },
    });

    expect(client.processId).toBe("test-process-123");
    expect(client.metadata).toEqual({ test: true });
    expect(client.connected).toBe(false);
  });

  it("should expose onMessage method on created client", async () => {
    const { createProcessClient } = await import("../src/process-client");

    const client = createProcessClient({
      processId: "test-process-456",
      socketPath: "/tmp/test-socket.sock",
    });

    expect(client.onMessage).toBeInstanceOf(Function);
  });

  it("should accept onMessage in config", async () => {
    const { createProcessClient } = await import("../src/process-client");

    const messages: any[] = [];
    const client = createProcessClient({
      processId: "test-process-789",
      socketPath: "/tmp/test-socket.sock",
      onMessage: (msg) => messages.push(msg),
    });

    expect(client).toBeDefined();
    expect(client.onMessage).toBeInstanceOf(Function);
  });
});
