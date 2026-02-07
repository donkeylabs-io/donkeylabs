import { describe, it, expect, afterEach } from "bun:test";
import { createTestHarness } from "../src/harness";
import { createPlugin } from "../src/core";

describe("createTestHarness", () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>> | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.db.destroy();
      harness = null;
    }
  });

  it("should create a test harness with a simple plugin", async () => {
    const testPlugin = createPlugin.define({
      name: "test-harness-plugin" as any,
      service: () => ({
        greet(name: string) {
          return `Hello, ${name}!`;
        },
      }),
    });

    harness = await createTestHarness(testPlugin);

    expect(harness).toBeDefined();
    expect(harness.db).toBeDefined();
    expect(harness.core).toBeDefined();
    expect(harness.manager).toBeDefined();

    // Verify core services are present
    expect(harness.core.logger).toBeDefined();
    expect(harness.core.cache).toBeDefined();
    expect(harness.core.events).toBeDefined();
    expect(harness.core.cron).toBeDefined();
    expect(harness.core.jobs).toBeDefined();
    expect(harness.core.sse).toBeDefined();
    expect(harness.core.rateLimiter).toBeDefined();
    expect(harness.core.errors).toBeDefined();
    expect(harness.core.workflows).toBeDefined();
    expect(harness.core.processes).toBeDefined();
    expect(harness.core.audit).toBeDefined();
    expect(harness.core.websocket).toBeDefined();
    expect(harness.core.storage).toBeDefined();
    expect(harness.core.logs).toBeDefined();
    expect(harness.core.health).toBeDefined();
  });

  it("should register dependencies before the target plugin", async () => {
    const depPlugin = createPlugin.define({
      name: "dep-plugin" as any,
      service: () => ({ value: 42 }),
    });

    const mainPlugin = createPlugin.define({
      name: "main-plugin" as any,
      dependencies: ["dep-plugin" as any] as const,
      service: () => ({ ok: true }),
    });

    harness = await createTestHarness(mainPlugin, [depPlugin]);
    expect(harness).toBeDefined();
  });

  it("should run migrations and init plugins", async () => {
    let initCalled = false;

    const plugin = createPlugin.define({
      name: "init-test-plugin" as any,
      service: () => ({ ready: true }),
      init: () => {
        initCalled = true;
      },
    });

    harness = await createTestHarness(plugin);
    expect(initCalled).toBe(true);
  });
});
