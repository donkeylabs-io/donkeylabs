import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const TEST_FILE_DIR = dirname(new URL(import.meta.url).pathname);
const PACKAGE_ROOT = join(TEST_FILE_DIR, "..");
const TEST_DIR = join(PACKAGE_ROOT, "test", ".temp-middleware-gen");

async function createProject(projectName: string, pluginSource: string): Promise<string> {
  const projectDir = join(TEST_DIR, projectName);
  const pluginDir = join(projectDir, "src/plugins/auth");
  const outDir = ".test-output";

  await mkdir(pluginDir, { recursive: true });

  const config = `
export default {
  plugins: ["./src/plugins/**/index.ts"],
  outDir: "${outDir}",
  entry: "./src/index.ts",
};
`;

  const entry = `
if (process.env.DONKEYLABS_GENERATE === "1") {
  console.log(JSON.stringify({ routes: [] }));
  process.exit(0);
}
`;

  await writeFile(join(projectDir, "donkeylabs.config.ts"), config);
  await mkdir(join(projectDir, "src"), { recursive: true });
  await writeFile(join(projectDir, "src/index.ts"), entry);
  await writeFile(join(pluginDir, "index.ts"), pluginSource);

  return projectDir;
}

async function runGenerate(projectDir: string): Promise<string> {
  const proc = Bun.spawn(["bun", join(PACKAGE_ROOT, "src/index.ts"), "generate"], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  expect(code).toBe(0);
  expect(stderr).toBe("");

  const registryPath = join(projectDir, ".test-output", "registry.d.ts");
  expect(existsSync(registryPath)).toBe(true);
  return readFile(registryPath, "utf-8");
}

describe("Middleware Generation", () => {
  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it("generates middleware methods from direct object middleware", async () => {
    const pluginSource = `
import { createPlugin } from "@donkeylabs/server";

export const authPlugin = createPlugin.define({
  name: "auth",
  middleware: {
    auth(config?: { required: boolean }) {
      return null as any;
    },
    optionalAuth: async () => null,
  },
  service: async () => ({}),
});
`;

    const projectDir = await createProject("object-middleware", pluginSource);
    const registry = await runGenerate(projectDir);

    expect(registry).toContain("export type AvailableMiddleware =");
    expect(registry).not.toContain("export type AvailableMiddleware = never;");
    expect(registry).toContain('"auth"');
    expect(registry).toContain('"optionalAuth"');
    expect(registry).toContain("auth(config?");
    expect(registry).toContain("optionalAuth(config?");
  });

  it("generates middleware methods from factory arrow middleware", async () => {
    const pluginSource = `
import { createPlugin, createMiddleware } from "@donkeylabs/server";

export const authPlugin = createPlugin.define({
  name: "auth",
  middleware: (ctx, service) => ({
    auth: createMiddleware<{ required: boolean }>(async (req, reqCtx, next, config) => {
      return next();
    }),
    optionalAuth: createMiddleware(async (req, reqCtx, next) => next()),
  }),
  service: async () => ({ verifyToken: async () => true }),
});
`;

    const projectDir = await createProject("arrow-middleware", pluginSource);
    const registry = await runGenerate(projectDir);

    expect(registry).toContain('"auth"');
    expect(registry).toContain('"optionalAuth"');
    expect(registry).toContain("auth(config?");
    expect(registry).toContain("optionalAuth(config?");
  });

  it("generates middleware methods from factory block-return middleware", async () => {
    const pluginSource = `
import { createPlugin, createMiddleware } from "@donkeylabs/server";

export const authPlugin = createPlugin.define({
  name: "auth",
  middleware: (ctx, service) => {
    return {
      auth: createMiddleware(async (req, reqCtx, next) => next()),
      adminOnly: createMiddleware(async (req, reqCtx, next) => next()),
    };
  },
  service: async () => ({ verifyToken: async () => true }),
});
`;

    const projectDir = await createProject("block-middleware", pluginSource);
    const registry = await runGenerate(projectDir);

    expect(registry).toContain('"auth"');
    expect(registry).toContain('"adminOnly"');
    expect(registry).toContain("auth(config?");
    expect(registry).toContain("adminOnly(config?");
  });
});
