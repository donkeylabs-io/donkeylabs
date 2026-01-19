/**
 * Agent-Based Verification Tests
 * 
 * Uses a second agent to review and verify the work of the first agent.
 * This provides an AI-powered quality check comparing generated code
 * against expected patterns.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { 
  createTestProject, 
  cleanupTestProject, 
  writeProjectFile, 
  readProjectFile, 
  projectFileExists 
} from "../../fixtures/helpers";
import { createDonkeyMcpServer } from "../../fixtures/mcp-server";
import { readFile } from "fs/promises";
import { join, resolve } from "path";

const TEMPLATES_DIR = resolve(import.meta.dir, "../../../cli/templates");

/**
 * Run a reviewer agent to compare generated code against template
 */
async function runReviewerAgent(
  generatedCode: string,
  templateCode: string,
  context: string
): Promise<{ score: number; passed: boolean; feedback: string }> {
  const q = query({
    prompt: `You are a code reviewer. Compare the GENERATED code against the TEMPLATE code.

Context: ${context}

=== TEMPLATE (Expected Pattern) ===
${templateCode}

=== GENERATED (To Review) ===
${generatedCode}

Evaluate based on:
1. Does it follow the same class-based handler pattern?
2. Does it have proper TypeScript typing?
3. Does it implement the Handler interface correctly?
4. Does it have the ctx: AppContext property?
5. Does it have a constructor that receives AppContext?
6. Does it have a handle() method?

Output your response as JSON:
{
  "score": <1-10>,
  "passed": <true if score >= 7>,
  "patterns_matched": ["list", "of", "matched", "patterns"],
  "patterns_missing": ["list", "of", "missing", "patterns"],
  "feedback": "Brief explanation"
}

ONLY output the JSON, nothing else.`,
    options: {
      model: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions",
      tools: [] // No tools, just reasoning
    }
  });

  let response = "";
  for await (const msg of q) {
    if (msg.type === "assistant" && (msg as any).message?.content) {
      for (const block of (msg as any).message.content) {
        if (block.type === "text") {
          response += block.text;
        }
      }
    }
  }

  // Parse JSON from response
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        score: result.score || 0,
        passed: result.passed || false,
        feedback: result.feedback || "No feedback"
      };
    }
  } catch (e) {
    console.log("Failed to parse reviewer response:", response);
  }

  return { score: 0, passed: false, feedback: "Failed to parse review" };
}

describe("Agent-Verified Code Generation", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("agent-verified");
    
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

  test("reviewer agent validates generated handler", async () => {
    // Step 1: Generator agent creates a handler
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    const generateQuery = query({
      prompt: `Add a "status" route to "src/routes/api/index.ts" that returns { healthy: true, version: "1.0.0" }.`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    for await (const _ of generateQuery) {}

    // Step 2: Read generated code
    const generatedHandler = await readProjectFile(projectDir, "src/routes/api/handlers/status.ts");
    
    // Step 3: Read template for comparison
    const templateHandler = await readFile(
      join(TEMPLATES_DIR, "starter/src/routes/health/handlers/ping.ts"),
      "utf-8"
    );

    console.log("=== Generated Handler ===");
    console.log(generatedHandler);

    // Step 4: Reviewer agent evaluates
    const review = await runReviewerAgent(
      generatedHandler,
      templateHandler,
      "Handler for a status route returning { healthy: true, version: '1.0.0' }"
    );

    console.log("=== Review Result ===");
    console.log(JSON.stringify(review, null, 2));

    expect(review.score).toBeGreaterThanOrEqual(5);
    expect(review.passed).toBe(true);
  }, 120000);

  test("two-agent workflow: generate and verify", async () => {
    // Agent 1: Generate
    const mcpServer = createDonkeyMcpServer(projectDir);
    
    const generateQuery = query({
      prompt: `Create an "auth" plugin with:
- A service class called AuthService
- Methods: login(email, password), logout(token), isAuthenticated(token)`,
      options: {
        cwd: projectDir,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    for await (const _ of generateQuery) {}

    // Read generated files
    const pluginIndex = await readProjectFile(projectDir, "src/plugins/auth/index.ts").catch(() => "");
    const serviceFile = await readProjectFile(projectDir, "src/plugins/auth/service.ts").catch(() => "");

    console.log("=== Generated Plugin ===");
    console.log(pluginIndex);
    console.log("=== Generated Service ===");
    console.log(serviceFile);

    // Agent 2: Verify structure
    const verifyQuery = query({
      prompt: `Analyze this generated plugin code and verify it follows best practices:

=== Plugin Index ===
${pluginIndex}

=== Service File ===
${serviceFile}

Check:
1. Does it use PluginBuilder?
2. Does it have a proper service class?
3. Does it export the plugin correctly?

Respond with ONLY: "PASS" if it looks good, or "FAIL: <reason>" if not.`,
      options: {
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        tools: []
      }
    });

    let verificationResult = "";
    for await (const msg of verifyQuery) {
      if (msg.type === "assistant" && (msg as any).message?.content) {
        for (const block of (msg as any).message.content) {
          if (block.type === "text") {
            verificationResult += block.text;
          }
        }
      }
    }

    console.log("=== Verification Result ===");
    console.log(verificationResult);

    expect(verificationResult.toUpperCase()).toContain("PASS");
  }, 120000);
});
