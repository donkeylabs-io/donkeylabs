import { describe, it, expect } from "bun:test";

/**
 * Generator Tests
 *
 * Tests that the client generator correctly includes both typed and raw routes
 */

// Import the generator function
import { generateClient, type RouteInfo } from "../src/generator/index";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const TEST_OUTPUT_DIR = join(import.meta.dir, ".test-output");
const TEST_OUTPUT_PATH = join(TEST_OUTPUT_DIR, "api.ts");

// Clean up test output before/after tests
async function cleanup() {
  if (existsSync(TEST_OUTPUT_DIR)) {
    await rm(TEST_OUTPUT_DIR, { recursive: true });
  }
}

describe("Client Generator", () => {
  describe("raw routes", () => {
    it("should include raw routes in the generated client", async () => {
      await cleanup();

      const routes: RouteInfo[] = [
        {
          name: "api.users.list",
          prefix: "api.users",
          routeName: "list",
          handler: "typed",
          inputSource: "z.object({ page: z.number() })",
          outputSource: "z.array(z.object({ id: z.string(), name: z.string() }))",
        },
        {
          name: "api.cameras.stream",
          prefix: "api.cameras",
          routeName: "stream",
          handler: "raw",
        },
        {
          name: "api.files.download",
          prefix: "api.files",
          routeName: "download",
          handler: "raw",
        },
      ];

      await generateClient({}, routes, TEST_OUTPUT_PATH);

      const content = await readFile(TEST_OUTPUT_PATH, "utf-8");

      // Should include typed route with typed method
      expect(content).toContain("users = {");
      expect(content).toContain('list: (input:');
      expect(content).toContain('this.request("api.users.list"');

      // Should include raw routes with rawRequest
      expect(content).toContain("cameras = {");
      expect(content).toContain("stream: (init?: RequestInit)");
      expect(content).toContain('this.rawRequest("api.cameras.stream"');

      expect(content).toContain("files = {");
      expect(content).toContain("download: (init?: RequestInit)");
      expect(content).toContain('this.rawRequest("api.files.download"');

      await cleanup();
    });

    it("should generate raw routes that return Promise<Response>", async () => {
      await cleanup();

      const routes: RouteInfo[] = [
        {
          name: "api.stream",
          prefix: "api",
          routeName: "stream",
          handler: "raw",
        },
      ];

      await generateClient({}, routes, TEST_OUTPUT_PATH);

      const content = await readFile(TEST_OUTPUT_PATH, "utf-8");

      // Raw routes should return Promise<Response>
      expect(content).toContain("stream: (init?: RequestInit): Promise<Response>");

      await cleanup();
    });

    it("should handle mixed typed and raw routes in the same namespace", async () => {
      await cleanup();

      const routes: RouteInfo[] = [
        {
          name: "api.media.list",
          prefix: "api.media",
          routeName: "list",
          handler: "typed",
          inputSource: "z.object({})",
          outputSource: "z.array(z.string())",
        },
        {
          name: "api.media.stream",
          prefix: "api.media",
          routeName: "stream",
          handler: "raw",
        },
        {
          name: "api.media.thumbnail",
          prefix: "api.media",
          routeName: "thumbnail",
          handler: "raw",
        },
        {
          name: "api.media.upload",
          prefix: "api.media",
          routeName: "upload",
          handler: "typed",
          inputSource: "z.object({ name: z.string() })",
          outputSource: "z.object({ id: z.string() })",
        },
      ];

      await generateClient({}, routes, TEST_OUTPUT_PATH);

      const content = await readFile(TEST_OUTPUT_PATH, "utf-8");

      // All routes should be in the same namespace
      expect(content).toContain("media = {");

      // Typed routes
      expect(content).toContain('list: (input:');
      expect(content).toContain('this.request("api.media.list"');
      expect(content).toContain('upload: (input:');
      expect(content).toContain('this.request("api.media.upload"');

      // Raw routes
      expect(content).toContain("stream: (init?: RequestInit)");
      expect(content).toContain('this.rawRequest("api.media.stream"');
      expect(content).toContain("thumbnail: (init?: RequestInit)");
      expect(content).toContain('this.rawRequest("api.media.thumbnail"');

      await cleanup();
    });

    it("should only generate types for typed routes, not raw routes", async () => {
      await cleanup();

      const routes: RouteInfo[] = [
        {
          name: "api.users.get",
          prefix: "api.users",
          routeName: "get",
          handler: "typed",
          inputSource: "z.object({ id: z.string() })",
          outputSource: "z.object({ id: z.string(), name: z.string() })",
        },
        {
          name: "api.users.avatar",
          prefix: "api.users",
          routeName: "avatar",
          handler: "raw",
        },
      ];

      await generateClient({}, routes, TEST_OUTPUT_PATH);

      const content = await readFile(TEST_OUTPUT_PATH, "utf-8");

      // Should generate types for typed route
      expect(content).toContain("export namespace Users");
      expect(content).toContain("export namespace Get");
      expect(content).toContain("export type Input");
      expect(content).toContain("export type Output");

      // Should NOT generate types for raw route (raw routes don't have typed I/O)
      expect(content).not.toContain("export namespace Avatar");

      await cleanup();
    });

    it("should handle routes with only raw handlers", async () => {
      await cleanup();

      const routes: RouteInfo[] = [
        {
          name: "api.webhooks.stripe",
          prefix: "api.webhooks",
          routeName: "stripe",
          handler: "raw",
        },
        {
          name: "api.webhooks.github",
          prefix: "api.webhooks",
          routeName: "github",
          handler: "raw",
        },
      ];

      await generateClient({}, routes, TEST_OUTPUT_PATH);

      const content = await readFile(TEST_OUTPUT_PATH, "utf-8");

      // Should still generate a namespace for the routes
      expect(content).toContain("webhooks = {");
      expect(content).toContain('stripe: (init?: RequestInit): Promise<Response> => this.rawRequest("api.webhooks.stripe"');
      expect(content).toContain('github: (init?: RequestInit): Promise<Response> => this.rawRequest("api.webhooks.github"');

      await cleanup();
    });

    it("should strip common prefix from route names in the client", async () => {
      await cleanup();

      const routes: RouteInfo[] = [
        {
          name: "api.data.export",
          prefix: "api.data",
          routeName: "export",
          handler: "raw",
        },
      ];

      await generateClient({}, routes, TEST_OUTPUT_PATH);

      const content = await readFile(TEST_OUTPUT_PATH, "utf-8");

      // The full route name should be used in the actual request
      expect(content).toContain('this.rawRequest("api.data.export"');

      // But the client namespace should be simplified
      expect(content).toContain("data = {");
      expect(content).toContain("export:");

      await cleanup();
    });
  });

  describe("edge cases", () => {
    it("should handle empty routes array", async () => {
      await cleanup();

      const routes: RouteInfo[] = [];

      await generateClient({}, routes, TEST_OUTPUT_PATH);

      const content = await readFile(TEST_OUTPUT_PATH, "utf-8");

      // Should still generate a valid client
      expect(content).toContain("export class ApiClient");
      expect(content).toContain("export function createApi");

      await cleanup();
    });

    it("should handle route names with hyphens", async () => {
      await cleanup();

      const routes: RouteInfo[] = [
        {
          name: "api.auth.sign-in",
          prefix: "api.auth",
          routeName: "sign-in",
          handler: "typed",
          inputSource: "z.object({ email: z.string() })",
          outputSource: "z.object({ token: z.string() })",
        },
        {
          name: "api.files.get-thumbnail",
          prefix: "api.files",
          routeName: "get-thumbnail",
          handler: "raw",
        },
      ];

      await generateClient({}, routes, TEST_OUTPUT_PATH);

      const content = await readFile(TEST_OUTPUT_PATH, "utf-8");

      // Hyphenated names should be converted to camelCase
      expect(content).toContain("signIn:");
      expect(content).toContain("getThumbnail:");

      // But the route names in requests should stay as-is
      expect(content).toContain('"api.auth.sign-in"');
      expect(content).toContain('"api.files.get-thumbnail"');

      await cleanup();
    });
  });
});
