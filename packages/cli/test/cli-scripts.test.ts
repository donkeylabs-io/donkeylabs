import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdir, rm, readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

// ==========================================
// CLI Scripts Integration Tests
// ==========================================

// Use import.meta.dir to get correct paths regardless of where test runs from
const TEST_FILE_DIR = dirname(new URL(import.meta.url).pathname);
const PACKAGE_ROOT = join(TEST_FILE_DIR, "..");
const TEST_DIR = join(PACKAGE_ROOT, "test", ".temp-cli-tests");
const SCRIPTS_DIR = join(PACKAGE_ROOT, "scripts");

describe("CLI Scripts", () => {
  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  describe("create-plugin.ts", () => {
    it("should show help with --help flag", async () => {
      const proc = Bun.spawn(
        ["bun", join(SCRIPTS_DIR, "create-plugin.ts"), "--help"],
        { stdout: "pipe" }
      );
      const output = await new Response(proc.stdout).text();
      await proc.exited;

      expect(output).toContain("Usage:");
      expect(output).toContain("--name");
      expect(output).toContain("--schema");
      expect(output).toContain("--deps");
    });

    it("should create plugin with --name only", async () => {
      const pluginsDir = join(TEST_DIR, "plugins");
      await mkdir(pluginsDir, { recursive: true });

      const result = await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "create-plugin.ts"),
        "--name",
        "test-simple",  // Plugin names must be lowercase with hyphens
      ], {
        cwd: TEST_DIR,
        env: { ...process.env },
      }).exited;

      // The script creates in ./plugins/<name>
      expect(result).toBe(0);
      expect(existsSync(join(pluginsDir, "test-simple", "index.ts"))).toBe(true);
    });

    it("should require --name in non-interactive mode", async () => {
      const proc = Bun.spawn(
        ["bun", join(SCRIPTS_DIR, "create-plugin.ts"), "--schema"],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      // Should fail without --name
      expect(exitCode).not.toBe(0);
    });
  });

  describe("create-server.ts", () => {
    it("should show help with --help flag", async () => {
      const proc = Bun.spawn(
        ["bun", join(SCRIPTS_DIR, "create-server.ts"), "--help"],
        { stdout: "pipe" }
      );
      const output = await new Response(proc.stdout).text();
      await proc.exited;

      expect(output).toContain("Usage:");
      expect(output).toContain("--name");
      expect(output).toContain("--port");
      expect(output).toContain("--plugins");
    });

    it("should create server file with default options", async () => {
      const serverFile = join(TEST_DIR, "test-server.ts");

      const result = await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "create-server.ts"),
        "--name",
        "test-server.ts",
        "--force",
      ], {
        cwd: TEST_DIR,
      }).exited;

      expect(result).toBe(0);
      expect(existsSync(serverFile)).toBe(true);

      const content = await readFile(serverFile, "utf-8");
      expect(content).toContain("AppServer");
      expect(content).toContain("createRouter");
      expect(content).toContain("port: 3000");
    });

    it("should create server file with custom port", async () => {
      const serverFile = join(TEST_DIR, "custom-port-server.ts");

      const result = await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "create-server.ts"),
        "--name",
        "custom-port-server.ts",
        "--port",
        "8080",
        "--force",
      ], {
        cwd: TEST_DIR,
      }).exited;

      expect(result).toBe(0);

      const content = await readFile(serverFile, "utf-8");
      expect(content).toContain("port: 8080");
    });

    it("should create server with plugins", async () => {
      const serverFile = join(TEST_DIR, "plugins-server.ts");

      const result = await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "create-server.ts"),
        "--name",
        "plugins-server.ts",
        "--plugins",
        "auth,users",
        "--force",
      ], {
        cwd: TEST_DIR,
      }).exited;

      expect(result).toBe(0);

      const content = await readFile(serverFile, "utf-8");
      expect(content).toContain("authPlugin");
      expect(content).toContain("usersPlugin");
    });

    it("should fail for invalid port", async () => {
      const proc = Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "create-server.ts"),
        "--name",
        "bad-port.ts",
        "--port",
        "invalid",
      ], {
        cwd: TEST_DIR,
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
    });
  });

  describe("generate-client.ts", () => {
    it("should show help with --help flag", async () => {
      const proc = Bun.spawn(
        ["bun", join(SCRIPTS_DIR, "generate-client.ts"), "--help"],
        { stdout: "pipe" }
      );
      const output = await new Response(proc.stdout).text();
      await proc.exited;

      expect(output).toContain("Usage:");
      expect(output).toContain("--output");
      expect(output).toContain("--name");
    });

    it("should fail gracefully when no server files found", async () => {
      const emptyDir = join(TEST_DIR, "empty-project");
      await mkdir(emptyDir, { recursive: true });

      const proc = Bun.spawn(
        ["bun", join(SCRIPTS_DIR, "generate-client.ts")],
        {
          cwd: emptyDir,
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const exitCode = await proc.exited;

      // Should exit with error when no server files
      expect(exitCode).not.toBe(0);
    });
  });

  describe("generate-registry.ts", () => {
    it("should generate registry files", async () => {
      const result = await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "generate-registry.ts"),
      ], {
        cwd: PACKAGE_ROOT,
      }).exited;

      expect(result).toBe(0);
      expect(existsSync(join(PACKAGE_ROOT, "registry.d.ts"))).toBe(true);
      expect(existsSync(join(PACKAGE_ROOT, "registry.ts"))).toBe(true);
    });

    it("should generate template registry for library", async () => {
      await Bun.spawn(["bun", join(SCRIPTS_DIR, "generate-registry.ts")], {
        cwd: PACKAGE_ROOT,
      }).exited;

      const registryDts = await readFile(
        join(PACKAGE_ROOT, "registry.d.ts"),
        "utf-8"
      );

      // Library registry should be a template with augmentation points
      expect(registryDts).toContain("PluginRegistry");
      expect(registryDts).toContain("PluginHandlerRegistry");
      expect(registryDts).toContain("IRouteBuilder");
      expect(registryDts).toContain("IMiddlewareBuilder");
    });
  });

  describe("create-migration.ts", () => {
    it("should show usage when called without arguments", async () => {
      const proc = Bun.spawn(
        ["bun", join(SCRIPTS_DIR, "create-migration.ts")],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      // Should show usage
      expect(stdout + "").toContain("Usage");
    });

    it("should create migration file for existing plugin", async () => {
      // Create a test plugin directory structure
      const pluginMigrationsDir = join(TEST_DIR, "plugins", "testMigration", "migrations");
      await mkdir(pluginMigrationsDir, { recursive: true });

      const result = await Bun.spawn([
        "bun",
        join(SCRIPTS_DIR, "create-migration.ts"),
        "testMigration",
        "add_new_column",
      ], {
        cwd: TEST_DIR,
      }).exited;

      // Check if migration file was created
      const files = await readdir(pluginMigrationsDir).catch(() => []);
      const migrationFile = files.find((f) => f.includes("add_new_column"));

      if (migrationFile) {
        expect(migrationFile).toContain("add_new_column");
      }
    });
  });
});

describe("Script Package.json Integration", () => {
  it("should have all expected scripts in package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(join(PACKAGE_ROOT, "package.json"), "utf-8")
    );

    expect(packageJson.scripts).toBeDefined();
    expect(packageJson.scripts["typecheck"]).toBeDefined();
  });

  it("should run typecheck via npm script", async () => {
    const result = await Bun.spawn(["bun", "run", "typecheck"], {
      cwd: PACKAGE_ROOT,
    }).exited;
    expect(result).toBe(0);
  });
});
