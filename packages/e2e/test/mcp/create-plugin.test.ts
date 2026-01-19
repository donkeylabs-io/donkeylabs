/**
 * MCP Agent Tests - Create Plugin via Agent
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createTestProject, cleanupTestProject, writeProjectFile, readProjectFile, projectFileExists } from "../../fixtures/helpers";
import { createDonkeyMcpServer } from "../../fixtures/mcp-server";

describe("MCP Agent - Create Plugin", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("mcp-create-plugin");
    
    await writeProjectFile(projectDir, "package.json", JSON.stringify({
      name: "plugin-test",
      type: "module",
      dependencies: { "@donkeylabs/server": "workspace:*" }
    }));
    await writeProjectFile(projectDir, "donkeylabs.config.ts", "export default {};");
  });

  afterEach(async () => {
    await cleanupTestProject(projectDir);
  });

  test("agent creates plugin with service", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    const q = query({
      prompt: `Use create_plugin to create an "auth" plugin with description "Authentication and session management". Include a service.`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    let pluginCreated = false;
    for await (const msg of q) {
      if (msg.type === "user" && (msg as any).tool_use_result) {
        const result = (msg as any).tool_use_result;
        const text = Array.isArray(result) ? result.map((r: any) => r.text).join("") : String(result);
        if (text.includes("Created plugin")) {
          pluginCreated = true;
        }
      }
    }

    expect(pluginCreated).toBe(true);
    expect(projectFileExists(projectDir, "src/plugins/auth/index.ts")).toBe(true);
    expect(projectFileExists(projectDir, "src/plugins/auth/service.ts")).toBe(true);
  }, 60000);

  test("agent creates plugin with handlers", async () => {
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    const q = query({
      prompt: `Create a "cache" plugin with handlers but no service.`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    for await (const _ of q) {}

    expect(projectFileExists(projectDir, "src/plugins/cache/index.ts")).toBe(true);
    expect(projectFileExists(projectDir, "src/plugins/cache/handlers.ts")).toBe(true);
  }, 60000);
});
