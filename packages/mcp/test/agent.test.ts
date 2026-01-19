
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { join, resolve } from "path";
import { mkdir, writeFile, rm, readFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { z } from "zod";

const TEST_DIR = resolve(import.meta.dir, "agent_project_v2");

// Helper to create the in-process MCP server with add_route tool
function createDonkeyMcpServer() {
  return createSdkMcpServer({
    name: "donkey-server",
    version: "0.1.0",
    tools: [
      tool(
        "add_route",
        "Add a new route to a @donkeylabs/server router file with a class-based handler",
        {
          routerFile: z.string().describe("Path to the router file (relative to project root)"),
          routeName: z.string().describe("Name of the route (e.g., 'hello', 'users')"),
          method: z.enum(["get", "post", "put", "delete"]).optional().describe("HTTP method, defaults to post"),
          inputSchema: z.string().optional().describe("Zod schema for input validation (e.g., 'z.object({ name: z.string() })')"),
          outputDescription: z.string().optional().describe("Description of what the handler returns"),
          handlerBody: z.string().describe("The handler implementation code")
        },
        async (args) => {
          const { routerFile, routeName, method = "post", inputSchema, outputDescription, handlerBody } = args;
          const fullPath = join(TEST_DIR, routerFile);
          
          if (!existsSync(fullPath)) {
            return { 
              content: [{ type: "text", text: `Error: Router file not found: ${routerFile}` }], 
              isError: true 
            };
          }

          const content = await readFile(fullPath, "utf-8");
          
          // Create handlers directory
          const routerDir = join(TEST_DIR, routerFile.replace(/\/[^/]+$/, ""));
          const handlersDir = join(routerDir, "handlers");
          if (!existsSync(handlersDir)) {
            mkdirSync(handlersDir, { recursive: true });
          }

          // Generate handler class
          const handlerClassName = routeName.charAt(0).toUpperCase() + routeName.slice(1) + "Handler";
          const handlerFileContent = `// Auto-generated handler for ${routeName} route
import type { Handler, AppContext } from "@donkeylabs/server";

export class ${handlerClassName} implements Handler {
  ctx: AppContext;
  
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }
  
  async handle(input: ${inputSchema ? `z.infer<typeof ${inputSchema}>` : "unknown"}): Promise<${outputDescription || "unknown"}> {
    ${handlerBody}
  }
}
`;
          const handlerFileName = routeName.toLowerCase().replace(/[^a-z0-9]/g, "-");
          await writeFile(join(handlersDir, `${handlerFileName}.ts`), handlerFileContent);

          // Update router file
          const importStatement = `import { ${handlerClassName} } from "./handlers/${handlerFileName}";\n`;
          
          // Find the last occurrence of the router variable and add the route
          const routerMatch = content.match(/export\s+const\s+(\w+Router)\s*=/);
          if (!routerMatch) {
            return { 
              content: [{ type: "text", text: "Error: Could not find router export in file" }], 
              isError: true 
            };
          }

          const routerName = routerMatch[1];
          const methodChain = method !== "post" ? `.${method}()` : "";
          const newRoute = `\n  .route("${routeName}")${methodChain}.typed({ handle: ${handlerClassName} })`;
          
          // Insert import at top and route before final semicolon
          let newContent = content;
          if (!newContent.includes(importStatement)) {
            newContent = importStatement + newContent;
          }
          
          const lastSemicolon = newContent.lastIndexOf(";");
          if (lastSemicolon !== -1) {
            newContent = newContent.slice(0, lastSemicolon) + newRoute + newContent.slice(lastSemicolon);
          }
          
          await writeFile(fullPath, newContent);

          return { 
            content: [{ 
              type: "text", 
              text: `Successfully added route "${routeName}" to ${routerFile}\n- Created handler: handlers/${handlerFileName}.ts\n- Handler class: ${handlerClassName}` 
            }]
          };
        }
      ),
      tool(
        "list_routes",
        "List all routes defined in a router file",
        {
          routerFile: z.string().describe("Path to the router file")
        },
        async (args) => {
          const fullPath = join(TEST_DIR, args.routerFile);
          
          if (!existsSync(fullPath)) {
            return { 
              content: [{ type: "text", text: `Error: File not found: ${args.routerFile}` }], 
              isError: true 
            };
          }

          const content = await readFile(fullPath, "utf-8");
          const routes = content.match(/\.route\("([^"]+)"\)/g) || [];
          const routeNames = routes.map(r => r.match(/\.route\("([^"]+)"\)/)?.[1]).filter(Boolean);
          
          return { 
            content: [{ 
              type: "text", 
              text: routeNames.length > 0 
                ? `Found ${routeNames.length} routes: ${routeNames.join(", ")}`
                : "No routes found in this file"
            }]
          };
        }
      ),
      tool(
        "get_project_info",
        "Get information about the @donkeylabs/server project",
        {},
        async () => {
          const configPath = join(TEST_DIR, "donkeylabs.config.ts");
          const pkgPath = join(TEST_DIR, "package.json");
          
          const info: string[] = ["Project Information:"];
          
          if (existsSync(configPath)) {
            info.push("- donkeylabs.config.ts: Present");
          }
          
          if (existsSync(pkgPath)) {
            const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
            info.push(`- Package: ${pkg.name || "unnamed"}`);
          }
          
          // List route files
          const routesDir = join(TEST_DIR, "src/routes");
          if (existsSync(routesDir)) {
            info.push("- Routes directory: Present");
          }
          
          return { content: [{ type: "text", text: info.join("\n") }] };
        }
      )
    ]
  });
}

describe("Claude Agent SDK Integration", () => {
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
  });

  beforeEach(async () => {
    // Clean setup for each test
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(join(TEST_DIR, "src/routes/api"), { recursive: true });
    await writeFile(join(TEST_DIR, "donkeylabs.config.ts"), "export default {};");
    await writeFile(
      join(TEST_DIR, "src/routes/api/index.ts"),
      `import { createRouter } from "@donkeylabs/server";\nexport const apiRouter = createRouter("api");`
    );
    process.chdir(TEST_DIR);
  });

  afterAll(async () => {
    if (originalCwd) process.chdir(originalCwd);
    // Cleanup
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("Agent connects to MCP server and sees tools", async () => {
    const mcpServer = createDonkeyMcpServer();
    
    const q = query({
      prompt: "List the available MCP tools. Just tell me their names.",
      options: {
        cwd: TEST_DIR,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    let mcpConnected = false;
    let tools: string[] = [];

    for await (const msg of q) {
      if (msg.type === "system" && (msg as any).subtype === "init") {
        const initMsg = msg as any;
        mcpConnected = initMsg.mcp_servers?.some((s: any) => s.status === "connected");
        tools = initMsg.tools || [];
      }
    }

    expect(mcpConnected).toBe(true);
    // Should have MCP tools prefixed with mcp__donkey-server__
    expect(tools.some(t => t.includes("donkey-server"))).toBe(true);
  }, 30000);

  test("Agent uses add_route to create a simple route", async () => {
    const mcpServer = createDonkeyMcpServer();
    
    const q = query({
      prompt: `Use the add_route tool to add a route named "hello" to "src/routes/api/index.ts".
The handler should return { message: "Hello World!" }.`,
      options: {
        cwd: TEST_DIR,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    let toolCalled = false;
    let toolResult = "";

    for await (const msg of q) {
      if (msg.type === "assistant" && (msg as any).message?.content) {
        for (const block of (msg as any).message.content) {
          if (block.type === "tool_use" && block.name?.includes("add_route")) {
            toolCalled = true;
          }
        }
      }
      if (msg.type === "user" && (msg as any).tool_use_result) {
        const result = (msg as any).tool_use_result;
        if (Array.isArray(result)) {
          toolResult = result.map((r: any) => r.text).join("");
        } else if (typeof result === "string") {
          toolResult = result;
        }
      }
    }

    expect(toolCalled).toBe(true);
    expect(toolResult).toContain("Successfully added route");

    // Verify files
    const handlerPath = join(TEST_DIR, "src/routes/api/handlers/hello.ts");
    expect(existsSync(handlerPath)).toBe(true);

    const handlerContent = await readFile(handlerPath, "utf-8");
    expect(handlerContent).toContain("HelloHandler");
    expect(handlerContent).toContain("Hello World!");

    const routerContent = await readFile(join(TEST_DIR, "src/routes/api/index.ts"), "utf-8");
    expect(routerContent).toContain('import { HelloHandler }');
    expect(routerContent).toContain('.route("hello")');
    expect(routerContent).toContain('.typed({ handle: HelloHandler })');
  }, 60000);

  test("Agent adds multiple routes correctly", async () => {
    const mcpServer = createDonkeyMcpServer();
    
    const q = query({
      prompt: `Add two routes to "src/routes/api/index.ts":
1. A route named "users" that returns { users: [] }
2. A route named "health" that returns { status: "ok" }`,
      options: {
        cwd: TEST_DIR,
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
        if (text.includes("Successfully added route")) {
          routesAdded++;
        }
      }
    }

    expect(routesAdded).toBe(2);

    // Verify both handlers exist
    expect(existsSync(join(TEST_DIR, "src/routes/api/handlers/users.ts"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "src/routes/api/handlers/health.ts"))).toBe(true);

    // Verify router has both routes
    const routerContent = await readFile(join(TEST_DIR, "src/routes/api/index.ts"), "utf-8");
    expect(routerContent).toContain('.route("users")');
    expect(routerContent).toContain('.route("health")');
  }, 90000);

  test("Agent uses list_routes to check existing routes", async () => {
    // First add a route manually
    const routerContent = `import { createRouter } from "@donkeylabs/server";
export const apiRouter = createRouter("api")
  .route("existing-route").typed({ handle: class {} });`;
    await writeFile(join(TEST_DIR, "src/routes/api/index.ts"), routerContent);

    const mcpServer = createDonkeyMcpServer();
    
    const q = query({
      prompt: `Use the list_routes tool to check what routes exist in "src/routes/api/index.ts".`,
      options: {
        cwd: TEST_DIR,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    let foundRoutes = false;

    for await (const msg of q) {
      if (msg.type === "user" && (msg as any).tool_use_result) {
        const result = (msg as any).tool_use_result;
        const text = Array.isArray(result) ? result.map((r: any) => r.text).join("") : String(result);
        if (text.includes("existing-route")) {
          foundRoutes = true;
        }
      }
    }

    expect(foundRoutes).toBe(true);
  }, 30000);

  test("Agent handles file not found error gracefully", async () => {
    const mcpServer = createDonkeyMcpServer();
    
    const q = query({
      prompt: `Try to add a route to "src/routes/nonexistent/index.ts". Report what happens.`,
      options: {
        cwd: TEST_DIR,
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

  test("Agent uses get_project_info to understand project structure", async () => {
    const mcpServer = createDonkeyMcpServer();
    
    const q = query({
      prompt: `Use the get_project_info tool to learn about this project.`,
      options: {
        cwd: TEST_DIR,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        mcpServers: { "donkey-server": mcpServer }
      }
    });

    let gotInfo = false;

    for await (const msg of q) {
      if (msg.type === "user" && (msg as any).tool_use_result) {
        const result = (msg as any).tool_use_result;
        const text = Array.isArray(result) ? result.map((r: any) => r.text).join("") : String(result);
        if (text.includes("donkeylabs.config.ts")) {
          gotInfo = true;
        }
      }
    }

    expect(gotInfo).toBe(true);
  }, 30000);
});
