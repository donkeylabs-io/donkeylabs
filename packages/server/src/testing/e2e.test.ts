// packages/server/src/testing/e2e.test.ts
import { describe, it, expect } from "bun:test";
import { defineE2EConfig, createE2EFixtures } from "./e2e";

describe("E2E Testing Utilities", () => {
  describe("defineE2EConfig", () => {
    it("should return default configuration", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
      });

      expect(config.testDir).toBe("./e2e");
      expect(config.timeout).toBe(30000);
      expect(config.expect?.timeout).toBe(5000);
      expect(config.fullyParallel).toBe(true);
      expect(config.use?.baseURL).toBe("http://localhost:3000");
      expect(config.use?.trace).toBe("on-first-retry");
      expect(config.use?.screenshot).toBe("only-on-failure");
    });

    it("should use custom port", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:4000",
        port: 4000,
      });

      expect(config.use?.baseURL).toBe("http://localhost:4000");
    });

    it("should use custom timeout", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
        timeout: 60000,
      });

      expect(config.timeout).toBe(60000);
    });

    it("should configure chromium by default", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
      });

      expect(config.projects?.length).toBe(1);
      expect(config.projects?.[0].name).toBe("chromium");
    });

    it("should add firefox when specified", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
        browsers: ["firefox"],
      });

      // Chromium + Firefox
      expect(config.projects?.length).toBe(2);
      expect(config.projects?.some((p) => p.name === "firefox")).toBe(true);
    });

    it("should add webkit when specified", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
        browsers: ["webkit"],
      });

      expect(config.projects?.some((p) => p.name === "webkit")).toBe(true);
    });

    it("should add mobile viewports when testMobile is true", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
        testMobile: true,
      });

      const mobileProjects = config.projects?.filter(
        (p) => p.name.includes("Mobile")
      );
      expect(mobileProjects?.length).toBe(2);
      expect(mobileProjects?.some((p) => p.name === "Mobile Chrome")).toBe(true);
      expect(mobileProjects?.some((p) => p.name === "Mobile Safari")).toBe(true);
    });

    it("should configure webServer for auto-start", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
        serverEntry: "./src/server.ts",
        autoStart: true,
      });

      expect(config.webServer).toBeDefined();
      expect(config.webServer?.command).toBe("bun ./src/server.ts");
      expect(config.webServer?.url).toBe("http://localhost:3000");
    });

    it("should use default dev command when no serverEntry", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
      });

      expect(config.webServer?.command).toBe("bun run dev");
    });

    it("should disable webServer when autoStart is false", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
        autoStart: false,
      });

      expect(config.webServer).toBeUndefined();
    });

    it("should configure CI settings based on environment", () => {
      const originalCI = process.env.CI;

      // Test non-CI
      delete process.env.CI;
      const nonCIConfig = defineE2EConfig({
        baseURL: "http://localhost:3000",
      });
      expect(nonCIConfig.forbidOnly).toBe(false);
      expect(nonCIConfig.retries).toBe(0);

      // Test CI
      process.env.CI = "true";
      const ciConfig = defineE2EConfig({
        baseURL: "http://localhost:3000",
      });
      expect(ciConfig.forbidOnly).toBe(true);
      expect(ciConfig.retries).toBe(2);
      expect(ciConfig.workers).toBe(1);

      // Restore
      if (originalCI) {
        process.env.CI = originalCI;
      } else {
        delete process.env.CI;
      }
    });

    it("should configure reporters", () => {
      const config = defineE2EConfig({
        baseURL: "http://localhost:3000",
      });

      expect(config.reporter).toEqual([["html"], ["list"]]);
    });
  });

  describe("createE2EFixtures", () => {
    const baseURL = "http://localhost:9999";

    it("should create api fixture with all HTTP methods", () => {
      const fixtures = createE2EFixtures(baseURL);

      expect(fixtures.api).toBeDefined();
      expect(typeof fixtures.api).toBe("function");
    });

    it("should create seed fixture", () => {
      const fixtures = createE2EFixtures(baseURL);

      expect(fixtures.seed).toBeDefined();
      expect(typeof fixtures.seed).toBe("function");
    });

    it("should create cleanup fixture", () => {
      const fixtures = createE2EFixtures(baseURL);

      expect(fixtures.cleanup).toBeDefined();
      expect(typeof fixtures.cleanup).toBe("function");
    });

    // Integration tests for fixtures would require a running server
    // These tests verify the fixture structure
  });

  describe("E2EFixtures API client", () => {
    // These tests require a mock server
    // For now we just verify the structure

    it("should have correct fixture structure", () => {
      const fixtures = createE2EFixtures("http://test:3000");

      // Verify all expected fixtures exist
      expect(Object.keys(fixtures)).toContain("api");
      expect(Object.keys(fixtures)).toContain("seed");
      expect(Object.keys(fixtures)).toContain("cleanup");
    });
  });
});
