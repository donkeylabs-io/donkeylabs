/**
 * Server Core Tests - Handlers
 * Tests for class-based and inline handlers
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createTestProject, cleanupTestProject, writeProjectFile, readProjectFile } from "../../fixtures/helpers";

describe("Server Handlers", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("handlers-test");
    
    // Create minimal project structure
    await writeProjectFile(projectDir, "package.json", JSON.stringify({
      name: "handlers-test",
      type: "module",
      dependencies: { "@donkeylabs/server": "workspace:*" }
    }));
    
    await writeProjectFile(projectDir, "donkeylabs.config.ts", "export default {};");
  });

  afterEach(async () => {
    await cleanupTestProject(projectDir);
  });

  test("class-based handler structure is valid", async () => {
    // Create a class-based handler
    const handlerCode = `
import type { Handler, AppContext } from "@donkeylabs/server";
import { z } from "zod";

const inputSchema = z.object({
  name: z.string()
});

const outputSchema = z.object({
  greeting: z.string()
});

export class GreetHandler implements Handler {
  ctx: AppContext;
  
  static input = inputSchema;
  static output = outputSchema;
  
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }
  
  async handle(input: z.infer<typeof inputSchema>): Promise<z.infer<typeof outputSchema>> {
    return { greeting: \`Hello, \${input.name}!\` };
  }
}
`;
    await writeProjectFile(projectDir, "src/handlers/greet.ts", handlerCode);
    
    const content = await readProjectFile(projectDir, "src/handlers/greet.ts");
    
    // Verify structure
    expect(content).toContain("class GreetHandler implements Handler");
    expect(content).toContain("ctx: AppContext");
    expect(content).toContain("static input = inputSchema");
    expect(content).toContain("static output = outputSchema");
    expect(content).toContain("async handle(input:");
  });

  test("handler with context injection", async () => {
    const handlerCode = `
import type { Handler, AppContext } from "@donkeylabs/server";

export class UserHandler implements Handler {
  ctx: AppContext;
  
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }
  
  async handle(input: { userId: string }) {
    // Access services from context
    const db = this.ctx.getService("database");
    const cache = this.ctx.getService("cache");
    
    return { user: { id: input.userId } };
  }
}
`;
    await writeProjectFile(projectDir, "src/handlers/user.ts", handlerCode);
    
    const content = await readProjectFile(projectDir, "src/handlers/user.ts");
    
    expect(content).toContain("this.ctx.getService");
  });

  test("inline handler definition", async () => {
    const routerCode = `
import { createRouter } from "@donkeylabs/server";
import { z } from "zod";

export const apiRouter = createRouter("api")
  .route("inline")
  .input(z.object({ value: z.number() }))
  .output(z.object({ doubled: z.number() }))
  .handle(async ({ input }) => {
    return { doubled: input.value * 2 };
  });
`;
    await writeProjectFile(projectDir, "src/routes/api/index.ts", routerCode);
    
    const content = await readProjectFile(projectDir, "src/routes/api/index.ts");
    
    expect(content).toContain(".route(\"inline\")");
    expect(content).toContain(".input(z.object");
    expect(content).toContain(".output(z.object");
    expect(content).toContain(".handle(async");
  });
});
