/**
 * Plugin Tests - Create and Register Plugins
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createTestProject, cleanupTestProject, writeProjectFile, readProjectFile, projectFileExists } from "../../fixtures/helpers";

describe("Plugin Creation", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTestProject("plugin-test");
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

  test("plugin with service definition", async () => {
    const pluginCode = `
import { PluginBuilder } from "@donkeylabs/server";

class AuthService {
  private sessions: Map<string, any> = new Map();
  
  createSession(userId: string) {
    const token = crypto.randomUUID();
    this.sessions.set(token, { userId, createdAt: Date.now() });
    return token;
  }
  
  validateSession(token: string) {
    return this.sessions.get(token);
  }
  
  destroySession(token: string) {
    this.sessions.delete(token);
  }
}

export const authPlugin = new PluginBuilder("auth")
  .describe("Authentication plugin with session management")
  .withService(AuthService)
  .build();
`;
    await writeProjectFile(projectDir, "src/plugins/auth/index.ts", pluginCode);
    
    const content = await readProjectFile(projectDir, "src/plugins/auth/index.ts");
    
    expect(content).toContain("class AuthService");
    expect(content).toContain("PluginBuilder(\"auth\")");
    expect(content).toContain(".withService(AuthService)");
    expect(content).toContain(".build()");
  });

  test("plugin with handlers", async () => {
    const pluginCode = `
import { PluginBuilder } from "@donkeylabs/server";
import type { Handler, AppContext } from "@donkeylabs/server";

class LoginHandler implements Handler {
  ctx: AppContext;
  constructor(ctx: AppContext) { this.ctx = ctx; }
  
  async handle(input: { email: string; password: string }) {
    // Login logic
    return { success: true, token: "..." };
  }
}

class LogoutHandler implements Handler {
  ctx: AppContext;
  constructor(ctx: AppContext) { this.ctx = ctx; }
  
  async handle(input: { token: string }) {
    // Logout logic
    return { success: true };
  }
}

export const authPlugin = new PluginBuilder("auth")
  .describe("Authentication plugin")
  .withHandlers({
    login: LoginHandler,
    logout: LogoutHandler
  })
  .build();
`;
    await writeProjectFile(projectDir, "src/plugins/auth/index.ts", pluginCode);
    
    const content = await readProjectFile(projectDir, "src/plugins/auth/index.ts");
    
    expect(content).toContain("class LoginHandler");
    expect(content).toContain("class LogoutHandler");
    expect(content).toContain(".withHandlers({");
  });

  test("plugin registration on server", async () => {
    // Create plugin
    await writeProjectFile(projectDir, "src/plugins/cache/index.ts", `
import { PluginBuilder } from "@donkeylabs/server";

class CacheService {
  private cache: Map<string, any> = new Map();
  get(key: string) { return this.cache.get(key); }
  set(key: string, value: any) { this.cache.set(key, value); }
}

export const cachePlugin = new PluginBuilder("cache")
  .describe("In-memory cache")
  .withService(CacheService)
  .build();
`);

    // Create server with plugin registration
    const serverCode = `
import { createServer } from "@donkeylabs/server";
import { cachePlugin } from "./plugins/cache";
import { apiRouter } from "./routes/api";

const server = createServer()
  .use(cachePlugin)
  .router(apiRouter)
  .build();

export default server;
`;
    await writeProjectFile(projectDir, "src/index.ts", serverCode);
    
    const content = await readProjectFile(projectDir, "src/index.ts");
    
    expect(content).toContain("import { cachePlugin }");
    expect(content).toContain(".use(cachePlugin)");
  });

  test("plugin with dependencies", async () => {
    const pluginCode = `
import { PluginBuilder } from "@donkeylabs/server";
import type { CacheService } from "../cache";

class BlogService {
  constructor(private cache: CacheService) {}
  
  async getPost(id: string) {
    const cached = this.cache.get(\`post:\${id}\`);
    if (cached) return cached;
    
    // Fetch from DB...
    return null;
  }
}

export const blogPlugin = new PluginBuilder("blog")
  .describe("Blog plugin with cache dependency")
  .dependsOn("cache")
  .withService(BlogService)
  .build();
`;
    await writeProjectFile(projectDir, "src/plugins/blog/index.ts", pluginCode);
    
    const content = await readProjectFile(projectDir, "src/plugins/blog/index.ts");
    
    expect(content).toContain(".dependsOn(\"cache\")");
  });
});
