import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

// ==========================================
// Integration Tests for Event Generation
// ==========================================

const TEST_FILE_DIR = dirname(new URL(import.meta.url).pathname);
const PACKAGE_ROOT = join(TEST_FILE_DIR, "..");
const TEST_DIR = join(PACKAGE_ROOT, "test", ".temp-events-gen");

describe("Event Generation", () => {
  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  describe("Event Extraction", () => {
    it("should extract events from defineEvents() call", async () => {
      const eventsContent = `
import { z } from "zod";
import { defineEvents } from "@donkeylabs/server";

export const events = defineEvents({
  "order.created": z.object({
    orderId: z.string(),
    total: z.number(),
  }),
  "user.signup": z.object({
    userId: z.string(),
    email: z.string(),
  }),
});
`;
      const eventsFile = join(TEST_DIR, "src/server/events.ts");
      await mkdir(dirname(eventsFile), { recursive: true });
      await writeFile(eventsFile, eventsContent);

      // Create minimal config
      const configContent = `
export default {
  plugins: [],
  outDir: ".test-output",
};
`;
      await writeFile(join(TEST_DIR, "donkeylabs.config.ts"), configContent);

      // Run generate command
      const result = await Bun.spawn([
        "bun",
        join(PACKAGE_ROOT, "src/index.ts"),
        "generate",
      ], {
        cwd: TEST_DIR,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      expect(result).toBe(0);

      // Check generated events.ts exists
      const eventsOutputPath = join(TEST_DIR, ".test-output", "events.ts");
      expect(existsSync(eventsOutputPath)).toBe(true);

      const generatedEvents = await readFile(eventsOutputPath, "utf-8");

      // Verify namespace structure
      expect(generatedEvents).toContain("export namespace Order");
      expect(generatedEvents).toContain("export namespace User");

      // Verify event types
      expect(generatedEvents).toContain("export type Created");
      expect(generatedEvents).toContain("export type Signup");

      // Verify EventMap
      expect(generatedEvents).toContain("export interface EventMap");
      expect(generatedEvents).toContain('"order.created": Order.Created');
      expect(generatedEvents).toContain('"user.signup": User.Signup');

      // Verify EventName union
      expect(generatedEvents).toContain("export type EventName");
      expect(generatedEvents).toContain('"order.created"');
      expect(generatedEvents).toContain('"user.signup"');

      // Verify module augmentation
      expect(generatedEvents).toContain('declare module "@donkeylabs/server"');
      expect(generatedEvents).toContain("interface EventRegistry");
    });

    it("should handle events with complex schemas", async () => {
      const eventsContent = `
import { z } from "zod";
import { defineEvents } from "@donkeylabs/server";

export const events = defineEvents({
  "order.shipped": z.object({
    orderId: z.string(),
    trackingNumber: z.string(),
    carrier: z.string(),
  }),
});
`;
      const eventsFile = join(TEST_DIR, "complex-events/src/server/events.ts");
      await mkdir(dirname(eventsFile), { recursive: true });
      await writeFile(eventsFile, eventsContent);

      const configContent = `
export default {
  plugins: [],
  outDir: ".test-output",
};
`;
      await writeFile(join(TEST_DIR, "complex-events/donkeylabs.config.ts"), configContent);

      const result = await Bun.spawn([
        "bun",
        join(PACKAGE_ROOT, "src/index.ts"),
        "generate",
      ], {
        cwd: join(TEST_DIR, "complex-events"),
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      expect(result).toBe(0);

      const eventsOutputPath = join(TEST_DIR, "complex-events/.test-output/events.ts");
      const generatedEvents = await readFile(eventsOutputPath, "utf-8");

      // Verify complex type is converted
      expect(generatedEvents).toContain("orderId: string");
      expect(generatedEvents).toContain("trackingNumber: string");
      expect(generatedEvents).toContain("carrier: string");
    });

    it("should generate empty events file when no events defined", async () => {
      // Create project without events file
      const configContent = `
export default {
  plugins: [],
  outDir: ".test-output",
};
`;
      await mkdir(join(TEST_DIR, "no-events"), { recursive: true });
      await writeFile(join(TEST_DIR, "no-events/donkeylabs.config.ts"), configContent);

      const result = await Bun.spawn([
        "bun",
        join(PACKAGE_ROOT, "src/index.ts"),
        "generate",
      ], {
        cwd: join(TEST_DIR, "no-events"),
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      expect(result).toBe(0);

      const eventsOutputPath = join(TEST_DIR, "no-events/.test-output/events.ts");
      expect(existsSync(eventsOutputPath)).toBe(true);

      const generatedEvents = await readFile(eventsOutputPath, "utf-8");

      // Should have empty EventMap and EventName = never
      expect(generatedEvents).toContain("export interface EventMap {}");
      expect(generatedEvents).toContain("export type EventName = never");
    });

    it("should handle multiple events in same namespace", async () => {
      const eventsContent = `
import { z } from "zod";
import { defineEvents } from "@donkeylabs/server";

export const events = defineEvents({
  "user.created": z.object({ userId: z.string() }),
  "user.updated": z.object({ userId: z.string() }),
  "user.deleted": z.object({ userId: z.string() }),
});
`;
      const eventsFile = join(TEST_DIR, "multi-events/src/server/events.ts");
      await mkdir(dirname(eventsFile), { recursive: true });
      await writeFile(eventsFile, eventsContent);

      const configContent = `
export default {
  plugins: [],
  outDir: ".test-output",
};
`;
      await writeFile(join(TEST_DIR, "multi-events/donkeylabs.config.ts"), configContent);

      const result = await Bun.spawn([
        "bun",
        join(PACKAGE_ROOT, "src/index.ts"),
        "generate",
      ], {
        cwd: join(TEST_DIR, "multi-events"),
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      expect(result).toBe(0);

      const eventsOutputPath = join(TEST_DIR, "multi-events/.test-output/events.ts");
      const generatedEvents = await readFile(eventsOutputPath, "utf-8");

      // Should have single User namespace with multiple event types
      expect(generatedEvents).toContain("export namespace User");
      expect(generatedEvents).toContain("export type Created");
      expect(generatedEvents).toContain("export type Updated");
      expect(generatedEvents).toContain("export type Deleted");

      // EventMap should have all three
      expect(generatedEvents).toContain('"user.created": User.Created');
      expect(generatedEvents).toContain('"user.updated": User.Updated');
      expect(generatedEvents).toContain('"user.deleted": User.Deleted');
    });
  });

  describe("Zod Schema to TypeScript Conversion", () => {
    it("should convert primitive types correctly", async () => {
      const eventsContent = `
import { z } from "zod";
import { defineEvents } from "@donkeylabs/server";

export const events = defineEvents({
  "test.primitives": z.object({
    str: z.string(),
    num: z.number(),
    bool: z.boolean(),
  }),
});
`;
      const eventsFile = join(TEST_DIR, "primitives/src/server/events.ts");
      await mkdir(dirname(eventsFile), { recursive: true });
      await writeFile(eventsFile, eventsContent);

      const configContent = `
export default {
  plugins: [],
  outDir: ".test-output",
};
`;
      await writeFile(join(TEST_DIR, "primitives/donkeylabs.config.ts"), configContent);

      await Bun.spawn([
        "bun",
        join(PACKAGE_ROOT, "src/index.ts"),
        "generate",
      ], {
        cwd: join(TEST_DIR, "primitives"),
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      const eventsOutputPath = join(TEST_DIR, "primitives/.test-output/events.ts");
      const generatedEvents = await readFile(eventsOutputPath, "utf-8");

      expect(generatedEvents).toContain("str: string");
      expect(generatedEvents).toContain("num: number");
      expect(generatedEvents).toContain("bool: boolean");
    });

    it("should handle optional fields", async () => {
      const eventsContent = `
import { z } from "zod";
import { defineEvents } from "@donkeylabs/server";

export const events = defineEvents({
  "test.optional": z.object({
    required: z.string(),
    optional: z.string().optional(),
  }),
});
`;
      const eventsFile = join(TEST_DIR, "optional/src/server/events.ts");
      await mkdir(dirname(eventsFile), { recursive: true });
      await writeFile(eventsFile, eventsContent);

      const configContent = `
export default {
  plugins: [],
  outDir: ".test-output",
};
`;
      await writeFile(join(TEST_DIR, "optional/donkeylabs.config.ts"), configContent);

      await Bun.spawn([
        "bun",
        join(PACKAGE_ROOT, "src/index.ts"),
        "generate",
      ], {
        cwd: join(TEST_DIR, "optional"),
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      const eventsOutputPath = join(TEST_DIR, "optional/.test-output/events.ts");
      const generatedEvents = await readFile(eventsOutputPath, "utf-8");

      expect(generatedEvents).toContain("required: string");
      expect(generatedEvents).toContain("optional?: string");
    });
  });

  describe("Event File Discovery", () => {
    it("should find events in src/server/events.ts", async () => {
      const eventsContent = `
import { z } from "zod";
import { defineEvents } from "@donkeylabs/server";

export const events = defineEvents({
  "found.event": z.object({ id: z.string() }),
});
`;
      const eventsFile = join(TEST_DIR, "server-path/src/server/events.ts");
      await mkdir(dirname(eventsFile), { recursive: true });
      await writeFile(eventsFile, eventsContent);

      const configContent = `
export default {
  plugins: [],
  outDir: ".test-output",
};
`;
      await writeFile(join(TEST_DIR, "server-path/donkeylabs.config.ts"), configContent);

      const proc = Bun.spawn([
        "bun",
        join(PACKAGE_ROOT, "src/index.ts"),
        "generate",
      ], {
        cwd: join(TEST_DIR, "server-path"),
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      expect(output).toContain("Found events in src/server/events.ts");
      expect(output).toContain("found.event");
    });

    it("should find events in src/events.ts", async () => {
      const eventsContent = `
import { z } from "zod";
import { defineEvents } from "@donkeylabs/server";

export const events = defineEvents({
  "alt.event": z.object({ id: z.string() }),
});
`;
      const eventsFile = join(TEST_DIR, "alt-path/src/events.ts");
      await mkdir(dirname(eventsFile), { recursive: true });
      await writeFile(eventsFile, eventsContent);

      const configContent = `
export default {
  plugins: [],
  outDir: ".test-output",
};
`;
      await writeFile(join(TEST_DIR, "alt-path/donkeylabs.config.ts"), configContent);

      const proc = Bun.spawn([
        "bun",
        join(PACKAGE_ROOT, "src/index.ts"),
        "generate",
      ], {
        cwd: join(TEST_DIR, "alt-path"),
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      expect(output).toContain("Found events in src/events.ts");
    });
  });
});
