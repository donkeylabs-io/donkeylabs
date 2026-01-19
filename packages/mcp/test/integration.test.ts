
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdir, writeFile, rm, readFile } from "fs/promises";
import { existsSync } from "fs";

const TEST_DIR = join(import.meta.dir, "temp_project");
const ROUTER_FILE = join(TEST_DIR, "src/routes/test/index.ts");
const CONFIG_FILE = join(TEST_DIR, "donkeylabs.config.ts");

describe("MCP Server Integration", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    // Setup test project structure
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(join(TEST_DIR, "src/routes/test"), { recursive: true });
    
    // Create dummy config to identify project root
    await writeFile(CONFIG_FILE, "export default {};");

    // Create dummy router
    await writeFile(
      ROUTER_FILE,
      `
import { createRouter } from "@donkeylabs/server";

export const testRouter = createRouter("test");
`
    );

    // Start MCP Server
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "../../src/server.ts"], // Relative to this test file
      cwd: TEST_DIR // Run in the context of the test project
    });

    client = new Client(
      {
        name: "test-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    // Cleanup
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("should list available tools", async () => {
    const result = await client.listTools();
    const toolNames = result.tools.map(t => t.name);
    
    expect(toolNames).toContain("add_route");
    expect(toolNames).toContain("create_plugin");
  });

  test("add_route should generate Class Handler and update router", async () => {
    const result = await client.callTool({
      name: "add_route",
      arguments: {
        routerFile: "src/routes/test/index.ts",
        routeName: "hello",
        handler: "return { message: 'success' };",
        useClassHandler: true
      }
    });

    // Check successful result
    expect(result.isError).toBeFalsy();
    
    // 1. Check Handler File Creation in handlers/hello.ts (kebab-case)
    const handlerPath = join(TEST_DIR, "src/routes/test/handlers/hello.ts");
    expect(existsSync(handlerPath)).toBe(true);
    
    const handlerContent = await readFile(handlerPath, "utf-8");
    expect(handlerContent).toContain("class HelloHandler");
    expect(handlerContent).toContain("implements Handler");
    expect(handlerContent).toContain("return { message: 'success' };");

    // 2. Check Router Update
    const routerContent = await readFile(ROUTER_FILE, "utf-8");
    
    // Check Import
    expect(routerContent).toContain('import { HelloHandler } from "./handlers/hello";');
    
    // Check Route Definition
    expect(routerContent).toContain('.route("hello").typed');
    expect(routerContent).toContain('handle: HelloHandler');
  });

  test("add_route should fall back to inline handler if useClassHandler is false", async () => {
    const result = await client.callTool({
      name: "add_route",
      arguments: {
        routerFile: "src/routes/test/index.ts",
        routeName: "inline",
        handler: "return 'inline';",
        useClassHandler: false
      }
    });

    expect(result.isError).toBeFalsy();

    const routerContent = await readFile(ROUTER_FILE, "utf-8");
    
    // Should NOT have imported a handler
    expect(routerContent).not.toContain('import { InlineHandler }');
    
    // Should have inline handler
    expect(routerContent).toContain('.route("inline").typed');
    expect(routerContent).toContain('handle: async (');
  });
});
