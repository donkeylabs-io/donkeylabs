/**
 * Full Journey Test - Complete User Workflow
 * 
 * Simulates: Init → Add Routes → Create Plugin → Generate Client → Verify
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

describe("Full Journey - Starter Project", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("full-journey");
  });

  afterEach(async () => {
    await cleanupTestProject(projectDir);
  });

  test("complete project setup via agent", async () => {
    // Step 1: Copy starter template (simulating `donkeylabs init`)
    await copyTemplate("starter", projectDir);
    
    expect(projectFileExists(projectDir, "package.json")).toBe(true);
    expect(projectFileExists(projectDir, "donkeylabs.config.ts")).toBe(true);
    expect(projectFileExists(projectDir, "src/index.ts")).toBe(true);
    
    // Step 2: Add routes via MCP agent
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    // Ensure router exists
    await writeProjectFile(
      projectDir,
      "src/routes/api/index.ts",
      `import { createRouter } from "@donkeylabs/server";\nexport const apiRouter = createRouter("api");`
    );
    
    const q = query({
      prompt: `Set up a complete API:
1. Add a "users" route that returns { users: [] }
2. Add a "posts" route that returns { posts: [] }
3. Create an "auth" plugin with a service`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    let actionsCompleted = 0;
    for await (const msg of q) {
      if (msg.type === "user" && (msg as any).tool_use_result) {
        const result = (msg as any).tool_use_result;
        const text = Array.isArray(result) ? result.map((r: any) => r.text).join("") : String(result);
        if (text.includes("Added route") || text.includes("Created plugin")) {
          actionsCompleted++;
        }
      }
    }

    expect(actionsCompleted).toBeGreaterThanOrEqual(2);
    
    // Step 3: Verify generated files
    expect(projectFileExists(projectDir, "src/routes/api/handlers/users.ts")).toBe(true);
    expect(projectFileExists(projectDir, "src/routes/api/handlers/posts.ts")).toBe(true);
    
    const routerContent = await readProjectFile(projectDir, "src/routes/api/index.ts");
    expect(routerContent).toContain('.route("users")');
    expect(routerContent).toContain('.route("posts")');
    
    // Verify handler content
    const usersHandler = await readProjectFile(projectDir, "src/routes/api/handlers/users.ts");
    expect(usersHandler).toContain("class UsersHandler");
    expect(usersHandler).toContain("users: []");
  }, 120000);
});

describe("Full Journey - Plugin Workflow", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("plugin-journey");
    await copyTemplate("starter", projectDir);
  });

  afterEach(async () => {
    await cleanupTestProject(projectDir);
  });

  test("create and integrate plugin", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    // Create plugin via agent
    const q = query({
      prompt: `Create a "notifications" plugin with both a service and handlers.`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    for await (const _ of q) {}

    // Verify plugin structure
    expect(projectFileExists(projectDir, "src/plugins/notifications/index.ts")).toBe(true);
    expect(projectFileExists(projectDir, "src/plugins/notifications/service.ts")).toBe(true);
    expect(projectFileExists(projectDir, "src/plugins/notifications/handlers.ts")).toBe(true);
    
    // Read and verify plugin content
    const pluginIndex = await readProjectFile(projectDir, "src/plugins/notifications/index.ts");
    expect(pluginIndex).toContain('PluginBuilder("notifications")');
    expect(pluginIndex).toContain(".withService");
    expect(pluginIndex).toContain(".withHandlers");
  }, 60000);
});
