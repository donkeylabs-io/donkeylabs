import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

// ==========================================
// Integration Tests for Client Generation
// ==========================================

// Use import.meta.dir to get correct paths regardless of where test runs from
const TEST_FILE_DIR = dirname(new URL(import.meta.url).pathname);
const PACKAGE_ROOT = join(TEST_FILE_DIR, "..");
const TEST_DIR = join(PACKAGE_ROOT, "test", ".temp-client-gen");
const SCRIPTS_DIR = join(PACKAGE_ROOT, "scripts");

describe("Client Generation", () => {
  beforeAll(async () => {
    // Create temp directory for test files
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    // Clean up temp directory
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  describe("Route Extraction", () => {
    it("should extract routes from simple server file", async () => {
      const serverContent = `
import { createRouter } from "./router";
import { z } from "zod";

const router = createRouter("users")
  .route("get").typed({
    input: z.object({ id: z.number() }),
    output: z.object({ name: z.string() }),
    handle: async (input) => ({ name: "Test" }),
  });
`;
      const serverFile = join(TEST_DIR, "simple-server.ts");
      await writeFile(serverFile, serverContent);

      const result = await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "simple-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      expect(result).toBe(0);

      const generatedClient = await readFile(
        join(TEST_DIR, "simple-output", "index.ts"),
        "utf-8"
      );

      expect(generatedClient).toContain("export namespace Routes");
      expect(generatedClient).toContain("export namespace Users");
      expect(generatedClient).toContain("GetInput");
      expect(generatedClient).toContain("GetOutput");
      expect(generatedClient).toContain("id: number");
      expect(generatedClient).toContain("name: string");
    });

    it("should extract routes from multiple routers", async () => {
      const serverContent = `
import { createRouter } from "./router";
import { z } from "zod";

const usersRouter = createRouter("users")
  .route("list").typed({
    input: z.object({ page: z.number() }),
    output: z.object({ users: z.array(z.string()) }),
    handle: async () => ({ users: [] }),
  });

const ordersRouter = createRouter("orders")
  .route("create").typed({
    input: z.object({ items: z.array(z.number()) }),
    output: z.object({ orderId: z.string() }),
    handle: async () => ({ orderId: "123" }),
  });
`;
      const serverFile = join(TEST_DIR, "multi-router.ts");
      await writeFile(serverFile, serverContent);

      const result = await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "multi-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      expect(result).toBe(0);

      const generatedClient = await readFile(
        join(TEST_DIR, "multi-output", "index.ts"),
        "utf-8"
      );

      expect(generatedClient).toContain("export namespace Users");
      expect(generatedClient).toContain("export namespace Orders");
      expect(generatedClient).toContain("users = {");
      expect(generatedClient).toContain("orders = {");
    });

    it("should handle raw routes", async () => {
      const serverContent = `
import { createRouter } from "./router";

const router = createRouter("files")
  .route("download").raw({
    handle: async () => new Response("data"),
  });
`;
      const serverFile = join(TEST_DIR, "raw-server.ts");
      await writeFile(serverFile, serverContent);

      const result = await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "raw-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      expect(result).toBe(0);

      const generatedClient = await readFile(
        join(TEST_DIR, "raw-output", "index.ts"),
        "utf-8"
      );

      expect(generatedClient).toContain("download: (init?: RequestInit): Promise<Response>");
      expect(generatedClient).toContain('this.rawRequest("files.download"');
    });
  });

  describe("Zod Schema Conversion", () => {
    it("should convert primitive types", async () => {
      const serverContent = `
import { createRouter } from "./router";
import { z } from "zod";

const router = createRouter("api")
  .route("test").typed({
    input: z.object({
      str: z.string(),
      num: z.number(),
      bool: z.boolean(),
    }),
    output: z.object({ success: z.boolean() }),
    handle: async () => ({ success: true }),
  });
`;
      const serverFile = join(TEST_DIR, "primitives.ts");
      await writeFile(serverFile, serverContent);

      await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "primitives-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      const generatedClient = await readFile(
        join(TEST_DIR, "primitives-output", "index.ts"),
        "utf-8"
      );

      expect(generatedClient).toContain("str: string");
      expect(generatedClient).toContain("num: number");
      expect(generatedClient).toContain("bool: boolean");
    });

    it("should convert optional fields", async () => {
      const serverContent = `
import { createRouter } from "./router";
import { z } from "zod";

const router = createRouter("api")
  .route("test").typed({
    input: z.object({
      required: z.string(),
      optional: z.string().optional(),
    }),
    output: z.object({ id: z.number() }),
    handle: async () => ({ id: 1 }),
  });
`;
      const serverFile = join(TEST_DIR, "optional.ts");
      await writeFile(serverFile, serverContent);

      await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "optional-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      const generatedClient = await readFile(
        join(TEST_DIR, "optional-output", "index.ts"),
        "utf-8"
      );

      expect(generatedClient).toContain("required: string");
      expect(generatedClient).toContain("optional?: string");
    });

    it("should convert nested objects", async () => {
      const serverContent = `
import { createRouter } from "./router";
import { z } from "zod";

const router = createRouter("api")
  .route("test").typed({
    input: z.object({
      user: z.object({
        name: z.string(),
        age: z.number(),
      }),
    }),
    output: z.object({ saved: z.boolean() }),
    handle: async () => ({ saved: true }),
  });
`;
      const serverFile = join(TEST_DIR, "nested.ts");
      await writeFile(serverFile, serverContent);

      await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "nested-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      const generatedClient = await readFile(
        join(TEST_DIR, "nested-output", "index.ts"),
        "utf-8"
      );

      // Should have nested object structure
      expect(generatedClient).toContain("user: {");
      expect(generatedClient).toContain("name: string");
      expect(generatedClient).toContain("age: number");
    });

    it("should convert arrays", async () => {
      const serverContent = `
import { createRouter } from "./router";
import { z } from "zod";

const router = createRouter("api")
  .route("test").typed({
    input: z.object({
      tags: z.array(z.string()),
      items: z.array(z.object({ id: z.number() })),
    }),
    output: z.object({ count: z.number() }),
    handle: async () => ({ count: 0 }),
  });
`;
      const serverFile = join(TEST_DIR, "arrays.ts");
      await writeFile(serverFile, serverContent);

      await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "arrays-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      const generatedClient = await readFile(
        join(TEST_DIR, "arrays-output", "index.ts"),
        "utf-8"
      );

      expect(generatedClient).toContain("tags: string[]");
      expect(generatedClient).toContain("items: {");
      expect(generatedClient).toContain("}[]");
    });
  });

  describe("Generated Client Structure", () => {
    it("should generate valid TypeScript", async () => {
      const serverContent = `
import { createRouter } from "./router";
import { z } from "zod";

const router = createRouter("test")
  .route("echo").typed({
    input: z.object({ message: z.string() }),
    output: z.object({ echo: z.string() }),
    handle: async (input) => ({ echo: input.message }),
  });
`;
      const serverFile = join(TEST_DIR, "valid-ts.ts");
      const outputDir = join(TEST_DIR, "valid-ts-output");
      await writeFile(serverFile, serverContent);

      await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        outputDir,
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      // Verify the files were generated
      expect(existsSync(join(outputDir, "index.ts"))).toBe(true);
      expect(existsSync(join(outputDir, "base.ts"))).toBe(true);

      // Read the generated client and verify it has proper structure
      const generatedClient = await readFile(join(outputDir, "index.ts"), "utf-8");
      expect(generatedClient).toContain("export class ApiClient");
      expect(generatedClient).toContain("export function createApiClient");
      expect(generatedClient).toContain('import {');
      expect(generatedClient).toContain('} from "./base"');
    });

    it("should include base.ts in output", async () => {
      const serverContent = `
import { createRouter } from "./router";
const router = createRouter("api")
  .route("test").raw({ handle: async () => new Response("ok") });
`;
      const serverFile = join(TEST_DIR, "with-base.ts");
      await writeFile(serverFile, serverContent);

      await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "with-base-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      expect(existsSync(join(TEST_DIR, "with-base-output", "base.ts"))).toBe(true);
      expect(existsSync(join(TEST_DIR, "with-base-output", "index.ts"))).toBe(true);
    });

    it("should export createApiClient factory function", async () => {
      const serverContent = `
import { createRouter } from "./router";
const router = createRouter("api")
  .route("ping").raw({ handle: async () => new Response("pong") });
`;
      const serverFile = join(TEST_DIR, "factory.ts");
      await writeFile(serverFile, serverContent);

      await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "factory-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      const generatedClient = await readFile(
        join(TEST_DIR, "factory-output", "index.ts"),
        "utf-8"
      );

      expect(generatedClient).toContain("export function createApiClient");
      expect(generatedClient).toContain("return new ApiClient(config)");
    });

    it("should re-export error types", async () => {
      const serverContent = `
import { createRouter } from "./router";
const router = createRouter("api")
  .route("test").raw({ handle: async () => new Response("ok") });
`;
      const serverFile = join(TEST_DIR, "errors.ts");
      await writeFile(serverFile, serverContent);

      await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        join(TEST_DIR, "errors-output"),
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      const generatedClient = await readFile(
        join(TEST_DIR, "errors-output", "index.ts"),
        "utf-8"
      );

      expect(generatedClient).toContain("export { ApiError, ValidationError");
    });
  });

  describe("CLI Options", () => {
    it("should respect --output option", async () => {
      const serverContent = `
import { createRouter } from "./router";
const router = createRouter("api")
  .route("test").raw({ handle: async () => new Response("ok") });
`;
      const serverFile = join(TEST_DIR, "output-test.ts");
      const customOutput = join(TEST_DIR, "custom-output-dir");
      await writeFile(serverFile, serverContent);

      await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-client.ts"),
        "--output",
        customOutput,
        serverFile,
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      expect(existsSync(join(customOutput, "index.ts"))).toBe(true);
    });

    it("should show help with --help", async () => {
      const proc = Bun.spawn(["bun", join(SCRIPTS_DIR, "generate-client.ts"), "--help"], {
        stdout: "pipe",
        cwd: PACKAGE_ROOT,
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      expect(output).toContain("Usage:");
      expect(output).toContain("--output");
      expect(output).toContain("--name");
    });
  });
});
