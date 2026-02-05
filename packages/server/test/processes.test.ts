import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  createProcesses,
  createEvents,
  isProcessAlive,
  type Processes,
  type Events,
} from "../src/core/index";

// Helper to wait for a condition
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 50
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ==========================================
// isProcessAlive Tests
// ==========================================
describe("isProcessAlive Helper", () => {
  it("should return true for running process", () => {
    // Current process PID should be alive
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("should return false for non-existent PID", () => {
    // Very high PID unlikely to exist
    expect(isProcessAlive(999999999)).toBe(false);
  });
});

// ==========================================
// Processes Service Tests
// ==========================================
describe("Processes Service", () => {
  let processes: Processes;
  let events: Events;
  const testDbPath = ".donkeylabs/test-processes.db";

  beforeEach(async () => {
    // Clean up test database
    if (existsSync(testDbPath)) {
      await unlink(testDbPath).catch(() => {});
    }

    events = createEvents();
    processes = createProcesses({
      adapter: { path: testDbPath, cleanupDays: 0 },
      socket: { socketDir: "/tmp/donkeylabs-test-processes" },
      events,
      heartbeatCheckInterval: 100000, // Long interval for tests
      killGraceMs: 50,
      autoRecoverOrphans: false, // Disable for unit tests
    });
  });

  afterEach(async () => {
    await processes.shutdown();
    // Clean up test database
    if (existsSync(testDbPath)) {
      await unlink(testDbPath).catch(() => {});
    }
  });

  describe("Registration", () => {
    it("should register a process definition", () => {
      processes.register({
        name: "test-worker",
        config: {
          command: "sleep",
          args: ["10"],
        },
      });

      // Should not throw
      expect(true).toBe(true);
    });

    it("should allow registering multiple definitions", () => {
      processes.register({
        name: "worker-1",
        config: { command: "sleep", args: ["10"] },
      });

      processes.register({
        name: "worker-2",
        config: { command: "sleep", args: ["10"] },
      });

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe("Spawning", () => {
    it("should spawn a process", async () => {
      processes.register({
        name: "sleeper",
        config: {
          command: "sleep",
          args: ["10"],
        },
      });

      const processId = await processes.spawn("sleeper");

      expect(processId).toMatch(/^proc_/);

      const proc = await processes.get(processId);
      expect(proc).not.toBeNull();
      expect(proc?.name).toBe("sleeper");
      expect(proc?.status).toBe("running");
      expect(proc?.pid).toBeGreaterThan(0);
    });

    it("should throw when spawning unregistered process", async () => {
      await expect(processes.spawn("nonexistent")).rejects.toThrow(
        "Process definition 'nonexistent' not found"
      );
    });

    it("should spawn with metadata", async () => {
      processes.register({
        name: "with-meta",
        config: { command: "sleep", args: ["10"] },
      });

      const processId = await processes.spawn("with-meta", {
        metadata: { cameraId: "cam-1", rtspUrl: "rtsp://example.com" },
      });

      const proc = await processes.get(processId);
      expect(proc?.metadata).toEqual({
        cameraId: "cam-1",
        rtspUrl: "rtsp://example.com",
      });
    });

    it("should spawn with config overrides", async () => {
      processes.register({
        name: "configurable",
        config: { command: "sleep", args: ["10"] },
      });

      const processId = await processes.spawn("configurable", {
        configOverrides: { args: ["5"] },
      });

      const proc = await processes.get(processId);
      expect(proc?.config.args).toEqual(["5"]);
    });

    it("should spawn multiple instances of same definition", async () => {
      processes.register({
        name: "multi",
        config: { command: "sleep", args: ["10"] },
      });

      const id1 = await processes.spawn("multi");
      const id2 = await processes.spawn("multi");
      const id3 = await processes.spawn("multi");

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);

      const byName = await processes.getByName("multi");
      expect(byName).toHaveLength(3);
    });

    it("should terminate a process that exceeds max runtime", async () => {
      processes.register({
        name: "runtime-limited",
        config: {
          command: "sleep",
          args: ["5"],
          limits: { maxRuntimeMs: 50 },
        },
      });

      const processId = await processes.spawn("runtime-limited");

      const stopped = await waitFor(async () => {
        const proc = await processes.get(processId);
        return proc?.status === "stopped";
      }, 2000, 50);

      expect(stopped).toBe(true);
    });
  });

  describe("Stopping", () => {
    it("should stop a running process", async () => {
      processes.register({
        name: "stoppable",
        config: { command: "sleep", args: ["60"] },
      });

      const processId = await processes.spawn("stoppable");
      let proc = await processes.get(processId);
      expect(proc?.status).toBe("running");

      const stopped = await processes.stop(processId);
      expect(stopped).toBe(true);

      proc = await processes.get(processId);
      expect(proc?.status).toBe("stopped");
    });

    it("should return false for non-existent process", async () => {
      const stopped = await processes.stop("proc_nonexistent");
      expect(stopped).toBe(false);
    });

    it("should return false for already stopped process", async () => {
      processes.register({
        name: "once",
        config: { command: "sleep", args: ["60"] },
      });

      const processId = await processes.spawn("once");
      await processes.stop(processId);
      const stoppedAgain = await processes.stop(processId);
      expect(stoppedAgain).toBe(false);
    });
  });

  describe("Killing", () => {
    it("should kill a running process", async () => {
      processes.register({
        name: "killable",
        config: { command: "sleep", args: ["60"] },
      });

      const processId = await processes.spawn("killable");
      const killed = await processes.kill(processId);
      expect(killed).toBe(true);

      const proc = await processes.get(processId);
      expect(proc?.status).toBe("stopped");
    });
  });

  describe("Restarting", () => {
    it("should restart a process", async () => {
      processes.register({
        name: "restartable",
        config: { command: "sleep", args: ["60"] },
      });

      const oldId = await processes.spawn("restartable", {
        metadata: { key: "value" },
      });
      const oldProc = await processes.get(oldId);
      expect(oldProc?.restartCount).toBe(0);

      const newId = await processes.restart(oldId);

      expect(newId).not.toBe(oldId);

      const oldProcAfter = await processes.get(oldId);
      expect(oldProcAfter?.status).toBe("stopped");

      const newProc = await processes.get(newId);
      expect(newProc?.status).toBe("running");
      expect(newProc?.restartCount).toBe(1);
      expect(newProc?.metadata).toEqual({ key: "value" });
    });
  });

  describe("Querying", () => {
    it("should get process by ID", async () => {
      processes.register({
        name: "queryable",
        config: { command: "sleep", args: ["10"] },
      });

      const processId = await processes.spawn("queryable");
      const proc = await processes.get(processId);

      expect(proc?.id).toBe(processId);
      expect(proc?.name).toBe("queryable");
    });

    it("should return null for non-existent process", async () => {
      const proc = await processes.get("proc_doesnt_exist");
      expect(proc).toBeNull();
    });

    it("should get processes by name", async () => {
      processes.register({
        name: "named",
        config: { command: "sleep", args: ["10"] },
      });

      await processes.spawn("named");
      await processes.spawn("named");

      const byName = await processes.getByName("named");
      expect(byName).toHaveLength(2);
      expect(byName.every((p) => p.name === "named")).toBe(true);
    });

    it("should get running processes", async () => {
      processes.register({
        name: "runner",
        config: { command: "sleep", args: ["60"] },
      });

      await processes.spawn("runner");
      await processes.spawn("runner");

      const running = await processes.getRunning();
      expect(running.length).toBeGreaterThanOrEqual(2);
      expect(running.every((p) => p.status === "running")).toBe(true);
    });
  });

  describe("Events", () => {
    it("should emit process.spawned event", async () => {
      const emitted: any[] = [];
      events.on("process.spawned", (data) => emitted.push(data));

      processes.register({
        name: "event-spawner",
        config: { command: "sleep", args: ["10"] },
      });

      const processId = await processes.spawn("event-spawner");

      expect(emitted).toHaveLength(1);
      expect(emitted[0].processId).toBe(processId);
      expect(emitted[0].name).toBe("event-spawner");
      expect(emitted[0].pid).toBeGreaterThan(0);
    });

    it("should emit process.stopped event", async () => {
      const emitted: any[] = [];
      events.on("process.stopped", (data) => emitted.push(data));

      processes.register({
        name: "event-stopper",
        config: { command: "sleep", args: ["60"] },
      });

      const processId = await processes.spawn("event-stopper");
      await processes.stop(processId);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].processId).toBe(processId);
      expect(emitted[0].name).toBe("event-stopper");
    });

    it("should emit process.crashed event when process exits unexpectedly", async () => {
      const emitted: any[] = [];
      events.on("process.crashed", (data) => emitted.push(data));

      processes.register({
        name: "crasher",
        config: { command: "sh", args: ["-c", "exit 1"] }, // Exits with error code
      });

      const processId = await processes.spawn("crasher");

      // Wait for crash
      await waitFor(async () => {
        const proc = await processes.get(processId);
        return proc?.status === "crashed";
      }, 2000);

      expect(emitted.length).toBeGreaterThanOrEqual(1);
      expect(emitted[0].processId).toBe(processId);
      expect(emitted[0].name).toBe("crasher");
    });
  });

  describe("Callbacks", () => {
    it("should call onCrash callback when process crashes", async () => {
      const crashes: any[] = [];

      processes.register({
        name: "crash-callback",
        config: { command: "sh", args: ["-c", "exit 1"] },
        onCrash: (proc, exitCode) => {
          crashes.push({ proc, exitCode });
        },
      });

      const processId = await processes.spawn("crash-callback");

      await waitFor(() => crashes.length > 0, 2000);

      expect(crashes).toHaveLength(1);
      expect(crashes[0].proc.id).toBe(processId);
    });

    it("should call onRestart callback when process restarts", async () => {
      const restarts: any[] = [];

      processes.register({
        name: "restart-callback",
        config: { command: "sleep", args: ["60"] },
        onRestart: (oldProc, newProc, attempt) => {
          restarts.push({ oldProc, newProc, attempt });
        },
      });

      const oldId = await processes.spawn("restart-callback");
      const newId = await processes.restart(oldId);

      expect(restarts).toHaveLength(1);
      expect(restarts[0].oldProc.id).toBe(oldId);
      expect(restarts[0].newProc.id).toBe(newId);
      expect(restarts[0].attempt).toBe(1);
    });
  });

  describe("Stats", () => {
    it("should emit process.stats event when stats message received", async () => {
      const statsReceived: any[] = [];
      events.on("process.stats", (data) => statsReceived.push(data));

      processes.register({
        name: "stats-emitter",
        config: { command: "sleep", args: ["60"] },
      });

      const processId = await processes.spawn("stats-emitter");

      // Simulate stats message from process client
      // The socket server receives this and forwards to handleMessage
      const mockStats = {
        cpu: { user: 1000, system: 500, percent: 5.5 },
        memory: { rss: 50000000, heapTotal: 30000000, heapUsed: 20000000, external: 1000000 },
        uptime: 10.5,
      };

      // Send stats via the socket (simulating what ProcessClient does)
      await (processes as any).handleMessage({
        type: "stats",
        processId,
        timestamp: Date.now(),
        stats: mockStats,
      });

      expect(statsReceived).toHaveLength(1);
      expect(statsReceived[0].processId).toBe(processId);
      expect(statsReceived[0].name).toBe("stats-emitter");
      expect(statsReceived[0].stats).toEqual(mockStats);
    });

    it("should emit process.<name>.stats event", async () => {
      const statsReceived: any[] = [];
      events.on("process.stats-named.stats", (data) => statsReceived.push(data));

      processes.register({
        name: "stats-named",
        config: { command: "sleep", args: ["60"] },
      });

      const processId = await processes.spawn("stats-named");

      const mockStats = {
        cpu: { user: 2000, system: 1000, percent: 10 },
        memory: { rss: 100000000, heapTotal: 50000000, heapUsed: 40000000, external: 2000000 },
        uptime: 20,
      };

      await (processes as any).handleMessage({
        type: "stats",
        processId,
        timestamp: Date.now(),
        stats: mockStats,
      });

      expect(statsReceived).toHaveLength(1);
      expect(statsReceived[0].stats.cpu.percent).toBe(10);
    });

    it("should call onStats callback when stats received", async () => {
      const statsCallbacks: any[] = [];

      processes.register({
        name: "stats-callback",
        config: { command: "sleep", args: ["60"] },
        onStats: (proc, stats) => {
          statsCallbacks.push({ proc, stats });
        },
      });

      const processId = await processes.spawn("stats-callback");

      const mockStats = {
        cpu: { user: 500, system: 250, percent: 2.5 },
        memory: { rss: 25000000, heapTotal: 15000000, heapUsed: 10000000, external: 500000 },
        uptime: 5,
      };

      await (processes as any).handleMessage({
        type: "stats",
        processId,
        timestamp: Date.now(),
        stats: mockStats,
      });

      expect(statsCallbacks).toHaveLength(1);
      expect(statsCallbacks[0].proc.id).toBe(processId);
      expect(statsCallbacks[0].stats.cpu.percent).toBe(2.5);
      expect(statsCallbacks[0].stats.memory.rss).toBe(25000000);
    });
  });

  describe("Auto-Restart", () => {
    it("should auto-restart process when autoRestart is enabled", async () => {
      const crashes: any[] = [];
      const restarts: any[] = [];

      events.on("process.crashed", (data) => crashes.push(data));
      events.on("process.restarted", (data) => restarts.push(data));

      processes.register({
        name: "auto-restarter",
        config: {
          command: "sh",
          args: ["-c", "exit 1"], // Exit with error
          autoRestart: true,
          maxRestarts: 3,
          backoff: {
            initialDelayMs: 100,
            maxDelayMs: 500,
            multiplier: 1.5,
          },
        },
      });

      await processes.spawn("auto-restarter");

      // Wait for at least one restart
      await waitFor(() => restarts.length > 0, 3000);

      expect(crashes.length).toBeGreaterThanOrEqual(1);
      expect(restarts.length).toBeGreaterThanOrEqual(1);
    });

    it("should stop auto-restarting after max restarts", async () => {
      const restarts: any[] = [];
      events.on("process.restarted", (data) => restarts.push(data));

      // With maxRestarts=3:
      // - Initial spawn, crash #1 (failures=1), restart #1
      // - crash #2 (failures=2), restart #2
      // - crash #3 (failures=3 >= maxRestarts), NO restart, mark as dead
      processes.register({
        name: "limited-restarter",
        config: {
          command: "sh",
          args: ["-c", "exit 1"], // Exit with error
          autoRestart: true,
          maxRestarts: 3,
          backoff: {
            initialDelayMs: 50,
            maxDelayMs: 100,
            multiplier: 1,
          },
        },
      });

      await processes.spawn("limited-restarter");

      // Wait for max restarts to be reached (should see 2 restart events)
      await waitFor(() => restarts.length >= 2, 3000);

      // Give a bit more time to ensure no more restarts happen
      const countAfterWait = restarts.length;
      await new Promise((r) => setTimeout(r, 500));

      // Verify restarts stopped - should be exactly 2 restarts
      expect(restarts.length).toBe(2);
      // Should not continue after wait
      expect(restarts.length).toBe(countAfterWait);
    });
  });

  describe("Service Lifecycle", () => {
    it("should start without errors", () => {
      processes.start();
      expect(true).toBe(true);
    });

    it("should shutdown and stop all processes", async () => {
      processes.register({
        name: "lifecycle",
        config: { command: "sleep", args: ["60"] },
      });

      await processes.spawn("lifecycle");
      await processes.spawn("lifecycle");

      const runningBefore = await processes.getRunning();
      expect(runningBefore.length).toBeGreaterThanOrEqual(2);

      await processes.shutdown();

      // Note: After shutdown, the service may not be usable
      // This test just verifies shutdown doesn't throw
      expect(true).toBe(true);
    });
  });
});

// ==========================================
// Process Adapter Tests
// ==========================================
describe("SqliteProcessAdapter", () => {
  const {
    SqliteProcessAdapter,
  } = require("../src/core/process-adapter-sqlite");

  const testDbPath = ".donkeylabs/test-adapter.db";

  let adapter: typeof SqliteProcessAdapter;

  beforeEach(() => {
    // Clean up
    if (existsSync(testDbPath)) {
      Bun.spawnSync(["rm", "-f", testDbPath]);
    }

    adapter = new SqliteProcessAdapter({
      path: testDbPath,
      cleanupDays: 0,
    });
  });

  afterEach(() => {
    adapter.stop();
    if (existsSync(testDbPath)) {
      Bun.spawnSync(["rm", "-f", testDbPath]);
    }
  });

  it("should create a process record", async () => {
    const proc = await adapter.create({
      name: "test-proc",
      status: "spawning",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    expect(proc.id).toMatch(/^proc_/);
    expect(proc.name).toBe("test-proc");
  });

  it("should get a process by ID", async () => {
    const created = await adapter.create({
      name: "get-test",
      status: "running",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const retrieved = await adapter.get(created.id);
    expect(retrieved?.id).toBe(created.id);
    expect(retrieved?.name).toBe("get-test");
  });

  it("should update a process", async () => {
    const proc = await adapter.create({
      name: "update-test",
      status: "spawning",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    await adapter.update(proc.id, {
      status: "running",
      pid: 12345,
    });

    const updated = await adapter.get(proc.id);
    expect(updated?.status).toBe("running");
    expect(updated?.pid).toBe(12345);
  });

  it("should delete a process", async () => {
    const proc = await adapter.create({
      name: "delete-test",
      status: "stopped",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const deleted = await adapter.delete(proc.id);
    expect(deleted).toBe(true);

    const retrieved = await adapter.get(proc.id);
    expect(retrieved).toBeNull();
  });

  it("should get processes by name", async () => {
    await adapter.create({
      name: "same-name",
      status: "running",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    await adapter.create({
      name: "same-name",
      status: "running",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    await adapter.create({
      name: "different-name",
      status: "running",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const byName = await adapter.getByName("same-name");
    expect(byName).toHaveLength(2);
  });

  it("should get running processes", async () => {
    await adapter.create({
      name: "running-1",
      status: "running",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    await adapter.create({
      name: "stopped-1",
      status: "stopped",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const running = await adapter.getRunning();
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe("running");
  });

  it("should get orphaned processes", async () => {
    await adapter.create({
      name: "orphan-1",
      status: "running",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    await adapter.create({
      name: "orphan-2",
      status: "orphaned",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    await adapter.create({
      name: "normal",
      status: "stopped",
      config: { command: "test" },
      createdAt: new Date(),
      restartCount: 0,
      consecutiveFailures: 0,
    });

    const orphaned = await adapter.getOrphaned();
    expect(orphaned).toHaveLength(2);
  });
});
