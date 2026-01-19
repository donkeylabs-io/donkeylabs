/**
 * MCP Agent Tests - Add Route via Agent
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createTestProject, cleanupTestProject, writeProjectFile, readProjectFile, projectFileExists } from "../../fixtures/helpers";
import { createDonkeyMcpServer } from "../../fixtures/mcp-server";

describe("MCP Agent - Add Route", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("mcp-add-route");
    
    await writeProjectFile(projectDir, "package.json", JSON.stringify({
      name: "mcp-test",
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

  test("agent adds simple route", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    const q = query({
      prompt: `Use add_route to add a route named "ping" to "src/routes/api/index.ts". Handler should return { pong: true }.`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    let toolCalled = false;
    for await (const msg of q) {
      if (msg.type === "assistant" && (msg as any).message?.content) {
        for (const block of (msg as any).message.content) {
          if (block.type === "tool_use" && block.name?.includes("add_route")) {
            toolCalled = true;
          }
        }
      }
    }

    expect(toolCalled).toBe(true);
    expect(projectFileExists(projectDir, "src/routes/api/handlers/ping.ts")).toBe(true);
    
    const routerContent = await readProjectFile(projectDir, "src/routes/api/index.ts");
    expect(routerContent).toContain('.route("ping")');
  }, 60000);

  test("agent adds route with GET method", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    const q = query({
      prompt: `Add a GET route named "health" to "src/routes/api/index.ts" that returns { status: "ok" }.`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    for await (const _ of q) {}

    const routerContent = await readProjectFile(projectDir, "src/routes/api/index.ts");
    expect(routerContent).toContain('.route("health")');
  }, 60000);

  test("agent adds multiple routes", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    const q = query({
      prompt: `Add two routes to "src/routes/api/index.ts":
1. "users" - returns { users: [] }
2. "posts" - returns { posts: [] }`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    let routesAdded = 0;
    for await (const msg of q) {
      if (msg.type === "user" && (msg as any).tool_use_result) {
        const result = (msg as any).tool_use_result;
        const text = Array.isArray(result) ? result.map((r: any) => r.text).join("") : String(result);
        if (text.includes("Added route")) routesAdded++;
      }
    }

    expect(routesAdded).toBe(2);
    expect(projectFileExists(projectDir, "src/routes/api/handlers/users.ts")).toBe(true);
    expect(projectFileExists(projectDir, "src/routes/api/handlers/posts.ts")).toBe(true);
  }, 90000);

  test("agent handles file not found gracefully", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    const q = query({
      prompt: `Try to add a route to "src/routes/nonexistent/index.ts".`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    let errorReported = false;
    for await (const msg of q) {
      if (msg.type === "user" && (msg as any).tool_use_result) {
        const result = (msg as any).tool_use_result;
        const text = Array.isArray(result) ? result.map((r: any) => r.text).join("") : String(result);
        if (text.includes("Error") || text.includes("not found")) {
          errorReported = true;
        }
      }
    }

    expect(errorReported).toBe(true);
  }, 30000);
});
