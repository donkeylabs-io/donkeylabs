/**
 * Template Recreation Tests
 * 
 * These tests verify that the agent generates code matching the quality
 * and patterns of the actual templates (starter, sveltekit-app).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { 
  createTestProject, 
  cleanupTestProject, 
  copyTemplate,
  writeProjectFile, 
  readProjectFile, 
  projectFileExists 
} from "../../fixtures/helpers";
import { createDonkeyMcpServer } from "../../fixtures/mcp-server";
import { readFile } from "fs/promises";
import { join, resolve } from "path";

const TEMPLATES_DIR = resolve(import.meta.dir, "../../../cli/templates");

describe("Template Recreation - Starter", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("template-recreation-starter");
    
    // Start with a minimal project
    await writeProjectFile(projectDir, "package.json", JSON.stringify({
      name: "test-project",
      type: "module",
      dependencies: { "@donkeylabs/server": "workspace:*" }
    }));
    await writeProjectFile(projectDir, "donkeylabs.config.ts", "export default {};");
    await writeProjectFile(
      projectDir,
      "src/routes/health/index.ts",
      `import { createRouter } from "@donkeylabs/server";\nexport const healthRouter = createRouter("health");`
    );
  });

  afterEach(async () => {
    await cleanupTestProject(projectDir);
  });

  test("recreate ping route with class handler", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    // Ask agent to recreate the starter template's ping route
    const q = query({
      prompt: `Add a "ping" route to "src/routes/health/index.ts" with a class-based handler.
The handler should:
- Return an object with: status (literal "ok"), timestamp (ISO string), and optional echo field
- Accept input with: name (string), cool (number), echo (optional string)

Use the class handler pattern with proper typing.`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    for await (const _ of q) {}

    // Verify handler was created
    expect(projectFileExists(projectDir, "src/routes/health/handlers/ping.ts")).toBe(true);

    // Read the actual template handler for comparison
    const templateHandler = await readFile(
      join(TEMPLATES_DIR, "starter/src/routes/health/handlers/ping.ts"),
      "utf-8"
    );
    
    const generatedHandler = await readProjectFile(
      projectDir, 
      "src/routes/health/handlers/ping.ts"
    );

    // Verify key patterns match the template
    console.log("=== Generated Handler ===");
    console.log(generatedHandler);
    console.log("=== Template Handler ===");
    console.log(templateHandler);

    // Structural checks - these should match the template patterns
    expect(generatedHandler).toContain("class");
    expect(generatedHandler).toContain("PingHandler");
    expect(generatedHandler).toContain("implements Handler");
    expect(generatedHandler).toContain("ctx: AppContext");
    expect(generatedHandler).toContain("constructor(ctx: AppContext)");
    expect(generatedHandler).toContain("handle(");
    expect(generatedHandler).toContain("status:");
    expect(generatedHandler).toContain("timestamp:");

    // Verify router was updated
    const routerContent = await readProjectFile(projectDir, "src/routes/health/index.ts");
    expect(routerContent).toContain('.route("ping")');
    expect(routerContent).toContain("PingHandler");
  }, 90000);
});

describe("Template Recreation - SvelteKit Counter", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("template-recreation-sveltekit");
    
    await writeProjectFile(projectDir, "package.json", JSON.stringify({
      name: "test-project",
      type: "module",
      dependencies: { "@donkeylabs/server": "workspace:*" }
    }));
    await writeProjectFile(projectDir, "donkeylabs.config.ts", "export default {};");
    await writeProjectFile(
      projectDir,
      "src/routes/counter/index.ts",
      `import { createRouter } from "@donkeylabs/server";\nconst router = createRouter("api");\nexport default router;`
    );
  });

  afterEach(async () => {
    await cleanupTestProject(projectDir);
  });

  test("recreate counter increment/decrement routes", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    // Ask agent to create counter routes like the sveltekit template
    const q = query({
      prompt: `Add routes to "src/routes/counter/index.ts" for a counter:
1. "counter.get" - returns { count: number }
2. "counter.increment" - returns { count: number }
3. "counter.decrement" - returns { count: number }

Each should have a class-based handler. The handlers should manage a counter value.`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    for await (const _ of q) {}

    // Read the template for comparison
    const templateRouter = await readFile(
      join(TEMPLATES_DIR, "sveltekit-app/src/server/routes/counter/index.ts"),
      "utf-8"
    );
    const templateHandler = await readFile(
      join(TEMPLATES_DIR, "sveltekit-app/src/server/routes/counter/handlers/decrement.ts"),
      "utf-8"
    );

    console.log("=== Template Router ===");
    console.log(templateRouter);
    console.log("=== Template Handler ===");
    console.log(templateHandler);

    // Verify router has all routes
    const routerContent = await readProjectFile(projectDir, "src/routes/counter/index.ts");
    console.log("=== Generated Router ===");
    console.log(routerContent);

    expect(routerContent).toContain("counter.get");
    expect(routerContent).toContain("counter.increment");
    expect(routerContent).toContain("counter.decrement");
  }, 120000);
});

describe("Template Pattern Validation", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("template-patterns");
    await writeProjectFile(projectDir, "package.json", JSON.stringify({
      name: "test-project",
      type: "module",
      dependencies: { "@donkeylabs/server": "workspace:*" }
    }));
    await writeProjectFile(projectDir, "donkeylabs.config.ts", "export default {};");
    await writeProjectFile(
      projectDir,
      "src/routes/api/index.ts",
      `import { createRouter } from "@donkeylabs/server";\nexport const apiRouter = createRouter("api");`
    );
  });

  afterEach(async () => {
    await cleanupTestProject(projectDir);
  });

  test("generated handler follows class handler pattern", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    const q = query({
      prompt: `Add a "users" route to "src/routes/api/index.ts" that returns { users: [], total: 0 }.`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    for await (const _ of q) {}

    const handlerContent = await readProjectFile(projectDir, "src/routes/api/handlers/users.ts");
    
    // Pattern checks based on templates
    const requiredPatterns = [
      { pattern: /class \w+Handler/, name: "Class with Handler suffix" },
      { pattern: /implements Handler/, name: "Implements Handler interface" },
      { pattern: /ctx: AppContext/, name: "Context property" },
      { pattern: /constructor\(ctx: AppContext\)/, name: "Constructor with context" },
      { pattern: /async handle\(|handle\(/, name: "Handle method" },
      { pattern: /return \{/, name: "Returns object" }
    ];

    const results: { name: string; passed: boolean }[] = [];
    for (const { pattern, name } of requiredPatterns) {
      const passed = pattern.test(handlerContent);
      results.push({ name, passed });
      console.log(`${passed ? "✅" : "❌"} ${name}`);
    }

    // All patterns should match
    expect(results.every(r => r.passed)).toBe(true);
  }, 60000);
});
