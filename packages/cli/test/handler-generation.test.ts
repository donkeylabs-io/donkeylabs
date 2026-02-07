import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const TEST_FILE_DIR = dirname(new URL(import.meta.url).pathname);
const PACKAGE_ROOT = join(TEST_FILE_DIR, "..");
const TEST_DIR = join(PACKAGE_ROOT, "test", ".temp-handler-gen");

async function createProject(projectName: string, pluginSource: string): Promise<string> {
  const projectDir = join(TEST_DIR, projectName);
  const pluginDir = join(projectDir, "src/plugins/example");

  await mkdir(pluginDir, { recursive: true });

  const config = `
export default {
  plugins: ["./src/plugins/**/index.ts"],
  outDir: ".test-output",
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

describe("Handler Generation", () => {
  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it("generates handler methods from direct handlers object", async () => {
    const pluginSource = `
import { createPlugin, createHandler } from "@donkeylabs/server";

export const examplePlugin = createPlugin.define({
  name: "example",
  handlers: {
    xml: createHandler<any>(async (req, def, handle, ctx) => {
      return new Response("ok");
    }),
    csv: createHandler(async (req, def, handle, ctx) => new Response("ok")),
  },
  service: async () => ({}),
});
`;

    const projectDir = await createProject("object-handlers", pluginSource);
    const registry = await runGenerate(projectDir);

    expect(registry).toContain("export type AvailableHandlers =");
    expect(registry).toContain('"xml"');
    expect(registry).toContain('"csv"');
    expect(registry).toContain("xml(config:");
    expect(registry).toContain("csv(config:");
  });

  it("generates handler methods from handlers factory arrow", async () => {
    const pluginSource = `
import { createPlugin, createHandler } from "@donkeylabs/server";

export const examplePlugin = createPlugin.define({
  name: "example",
  handlers: (ctx) => ({
    xml: createHandler<any>(async (req, def, handle, reqCtx) => new Response("ok")),
    markdown: createHandler(async (req, def, handle, reqCtx) => new Response("ok")),
  }),
  service: async () => ({}),
});
`;

    const projectDir = await createProject("arrow-handlers", pluginSource);
    const registry = await runGenerate(projectDir);

    expect(registry).toContain('"xml"');
    expect(registry).toContain('"markdown"');
    expect(registry).toContain("xml(config:");
    expect(registry).toContain("markdown(config:");
  });

  it("generates handler methods from handlers factory block return", async () => {
    const pluginSource = `
import { createPlugin, createHandler } from "@donkeylabs/server";

export const examplePlugin = createPlugin.define({
  name: "example",
  handlers: (ctx) => {
    return {
      xml: createHandler<any>(async (req, def, handle, reqCtx) => new Response("ok")),
      custom: createHandler(async (req, def, handle, reqCtx) => new Response("ok")),
    };
  },
  service: async () => ({}),
});
`;

    const projectDir = await createProject("block-handlers", pluginSource);
    const registry = await runGenerate(projectDir);

    expect(registry).toContain('"xml"');
    expect(registry).toContain('"custom"');
    expect(registry).toContain("xml(config:");
    expect(registry).toContain("custom(config:");
  });
});
