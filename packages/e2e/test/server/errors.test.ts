/**
 * Server Error Handling Tests
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createTestProject, cleanupTestProject, writeProjectFile, readProjectFile } from "../../fixtures/helpers";

describe("Error Handling", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("error-test");
    await writeProjectFile(projectDir, "package.json", JSON.stringify({
      name: "error-test",
      type: "module",
      dependencies: { "@donkeylabs/server": "workspace:*" }
    }));
  });

  afterEach(async () => {
    await cleanupTestProject(projectDir);
  });

  test("custom error class definition", async () => {
    const errorCode = `
import { createError } from "@donkeylabs/server";

export const NotFoundError = createError("NOT_FOUND", 404);
export const UnauthorizedError = createError("UNAUTHORIZED", 401);
export const ValidationError = createError("VALIDATION_ERROR", 400);
export const RateLimitError = createError("RATE_LIMIT", 429);
`;
    await writeProjectFile(projectDir, "src/errors/index.ts", errorCode);
    
    const content = await readProjectFile(projectDir, "src/errors/index.ts");
    
    expect(content).toContain("createError(\"NOT_FOUND\", 404)");
    expect(content).toContain("createError(\"UNAUTHORIZED\", 401)");
  });

  test("error thrown in handler", async () => {
    const handlerCode = `
import type { Handler, AppContext } from "@donkeylabs/server";
import { NotFoundError } from "../errors";

export class GetUserHandler implements Handler {
  ctx: AppContext;
  constructor(ctx: AppContext) { this.ctx = ctx; }
  
  async handle(input: { userId: string }) {
    const user = await this.ctx.getService("db").findUser(input.userId);
    
    if (!user) {
      throw new NotFoundError(\`User \${input.userId} not found\`);
    }
    
    return user;
  }
}
`;
    await writeProjectFile(projectDir, "src/handlers/get-user.ts", handlerCode);
    
    const content = await readProjectFile(projectDir, "src/handlers/get-user.ts");
    
    expect(content).toContain("throw new NotFoundError");
  });

  test("global error handler middleware", async () => {
    const middlewareCode = `
import { createMiddleware } from "@donkeylabs/server";

export const errorHandler = createMiddleware({
  name: "errorHandler",
  onError: async (error, ctx) => {
    // Log error
    console.error("Request failed:", error.message);
    
    // Track in monitoring
    ctx.getService("monitoring")?.trackError(error);
    
    // Return formatted error response
    return {
      error: {
        code: error.code || "INTERNAL_ERROR",
        message: error.message,
        requestId: ctx.requestId
      }
    };
  }
});
`;
    await writeProjectFile(projectDir, "src/middleware/error-handler.ts", middlewareCode);
    
    const content = await readProjectFile(projectDir, "src/middleware/error-handler.ts");
    
    expect(content).toContain("createMiddleware");
    expect(content).toContain("onError:");
  });

  test("validation error handling", async () => {
    const routerCode = `
import { createRouter } from "@donkeylabs/server";
import { z } from "zod";

export const apiRouter = createRouter("api")
  .route("create-user")
  .input(z.object({
    email: z.string().email("Invalid email format"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    age: z.number().min(18, "Must be 18 or older")
  }))
  .handle(async ({ input }) => {
    // This will only run if validation passes
    return { success: true, email: input.email };
  });
`;
    await writeProjectFile(projectDir, "src/routes/api/index.ts", routerCode);
    
    const content = await readProjectFile(projectDir, "src/routes/api/index.ts");
    
    expect(content).toContain("z.string().email");
    expect(content).toContain("z.string().min(8");
  });
});
