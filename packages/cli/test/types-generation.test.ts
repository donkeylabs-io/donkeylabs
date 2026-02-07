import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const TEST_FILE_DIR = dirname(new URL(import.meta.url).pathname);
const PACKAGE_ROOT = join(TEST_FILE_DIR, "..");
const TEST_DIR = join(PACKAGE_ROOT, "test", ".temp-types-gen");

describe("Type Generation", () => {
  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it("generates middleware and handler types that type-check in router usage", async () => {
    const projectDir = join(TEST_DIR, "router-types");
    const pluginDir = join(projectDir, "src/plugins/auth");

    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(projectDir, "donkeylabs.config.ts"),
      `
export default {
  plugins: ["./src/plugins/**/index.ts"],
  outDir: ".test-output",
  entry: "./src/index.ts",
};
`
    );

    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(
      join(projectDir, "src/index.ts"),
      `
if (process.env.DONKEYLABS_GENERATE === "1") {
  console.log(JSON.stringify({ routes: [] }));
  process.exit(0);
}
`
    );

    await writeFile(
      join(pluginDir, "index.ts"),
      `
import { createPlugin, createMiddleware, createHandler } from "@donkeylabs/server";

type XmlFn = (input: { id: string }, ctx: any) => Promise<string> | string;

export const authPlugin = createPlugin.define({
  name: "auth",
  middleware: (ctx, service) => ({
    auth: createMiddleware<{ required: boolean }>(async (req, reqCtx, next, config) => next()),
    optionalAuth: createMiddleware(async (req, reqCtx, next) => next()),
  }),
  handlers: {
    xml: createHandler<XmlFn>(async (req, def, handle, ctx) => {
      const result = await handle({ id: "ok" }, ctx);
      return new Response(result, { headers: { "Content-Type": "application/xml" } });
    }),
  },
  service: async () => ({}),
});
`
    );

    await writeFile(
      join(projectDir, "src/usage.ts"),
      `
/// <reference path="../.test-output/registry.d.ts" />
import { createRouter } from "@donkeylabs/server";

const authedRouter = createRouter("paper").middleware.auth({ required: true });

authedRouter.route("doc").xml({
  handle: async (input, ctx) => {
    return "<ok />";
  },
});

// @ts-expect-error required must be boolean
createRouter("paper").middleware.auth({ required: "yes" });
`
    );

    await writeFile(
      join(projectDir, "tsconfig.json"),
      `
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ESNext", "DOM"],
    "baseUrl": ".",
    "paths": {
      "@donkeylabs/server": ["../../../../server/src/index.ts"],
      "@donkeylabs/server/*": ["../../../../server/src/*"]
    }
  },
  "include": ["src/**/*.ts", ".test-output/**/*.d.ts"]
}
`
    );

    const generateProc = Bun.spawn(["bun", join(PACKAGE_ROOT, "src/index.ts"), "generate"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const generateStderr = await new Response(generateProc.stderr).text();
    const generateCode = await generateProc.exited;

    expect(generateCode).toBe(0);
    expect(generateStderr).toBe("");

    const tscProc = Bun.spawn(["bun", "--bun", "tsc", "--noEmit", "-p", join(projectDir, "tsconfig.json")], {
      cwd: PACKAGE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    const tscStdout = await new Response(tscProc.stdout).text();
    const tscStderr = await new Response(tscProc.stderr).text();
    const tscCode = await tscProc.exited;

    if (tscCode !== 0) {
      throw new Error(`tsc failed\nstdout:\n${tscStdout}\nstderr:\n${tscStderr}`);
    }
    expect(tscCode).toBe(0);
    expect(tscStdout).toBe("");
    expect(tscStderr).toBe("");
  });
});
