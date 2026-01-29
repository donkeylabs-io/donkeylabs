import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { createIntegrationHarness } from "../src/harness";
import { createRouter } from "../src/router";
import { ApiClientBase } from "../src/client/base";

/**
 * Integration Harness Tests
 *
 * These tests verify the integration test harness works correctly
 * for parallel test execution with unique ports.
 */

describe("createIntegrationHarness", () => {
  it("should start a server and accept requests via harness.client.call()", async () => {
    const router = createRouter("api")
      .route("echo").typed({
        input: z.object({ message: z.string() }),
        output: z.object({ echoed: z.string() }),
        handle: async (input) => ({ echoed: input.message }),
      });

    const harness = await createIntegrationHarness({
      routers: [router],
    });

    try {
      // Use the built-in untyped client - no file generation needed!
      const result = await harness.client.call<{ echoed: string }>("api.echo", { message: "hello" });
      expect(result.echoed).toBe("hello");

      // Can also list available routes
      expect(harness.client.routes()).toContain("api.echo");
    } finally {
      await harness.shutdown();
    }
  });

  it("should work with harness.createClient() for typed clients", async () => {
    const router = createRouter("users")
      .route("create").typed({
        input: z.object({ name: z.string(), email: z.string().email() }),
        output: z.object({ id: z.number(), name: z.string(), email: z.string() }),
        handle: async (input) => ({
          id: 1,
          name: input.name,
          email: input.email,
        }),
      })
      .route("list").typed({
        input: z.object({ limit: z.number().optional() }),
        output: z.object({ users: z.array(z.object({ id: z.number(), name: z.string() })) }),
        handle: async () => ({
          users: [{ id: 1, name: "Test User" }],
        }),
      });

    const harness = await createIntegrationHarness({
      routers: [router],
    });

    try {
      // Simulate a generated client factory (like `createApiClient` from lib/api.ts)
      class TypedUsersClient extends ApiClientBase {
        users = {
          create: (input: { name: string; email: string }) =>
            this.request<typeof input, { id: number; name: string; email: string }>("users.create", input),
          list: (input: { limit?: number }) =>
            this.request<typeof input, { users: { id: number; name: string }[] }>("users.list", input),
        };
      }

      const createTypedClient = (config: { baseUrl: string }) => new TypedUsersClient(config.baseUrl);

      // Use harness.createClient() with the typed factory
      const api = harness.createClient(createTypedClient);

      // Fully typed calls!
      const user = await api.users.create({ name: "John", email: "john@example.com" });
      expect(user.id).toBe(1);
      expect(user.name).toBe("John");

      const result = await api.users.list({});
      expect(result.users).toHaveLength(1);
    } finally {
      await harness.shutdown();
    }
  });

  it("should handle parallel test execution with unique ports", async () => {
    // Start 3 servers in parallel
    const [harness1, harness2, harness3] = await Promise.all([
      createIntegrationHarness({ routers: [] }),
      createIntegrationHarness({ routers: [] }),
      createIntegrationHarness({ routers: [] }),
    ]);

    try {
      // All ports should be different
      const ports = [harness1.port, harness2.port, harness3.port];
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(3);

      // All servers should be accessible
      const responses = await Promise.all([
        fetch(`${harness1.baseUrl}/nonexistent`),
        fetch(`${harness2.baseUrl}/nonexistent`),
        fetch(`${harness3.baseUrl}/nonexistent`),
      ]);

      // Should get 404s (server is running, route doesn't exist)
      expect(responses.every((r) => r.status === 404)).toBe(true);
    } finally {
      await Promise.all([
        harness1.shutdown(),
        harness2.shutdown(),
        harness3.shutdown(),
      ]);
    }
  });

  it("should provide access to core services", async () => {
    const harness = await createIntegrationHarness({});

    try {
      // Core services should be available
      expect(harness.core).toBeDefined();
      expect(harness.core.logger).toBeDefined();
      expect(harness.core.cache).toBeDefined();
      expect(harness.core.events).toBeDefined();
      expect(harness.core.jobs).toBeDefined();

      // DB should be accessible
      expect(harness.db).toBeDefined();

      // Plugins object should exist (empty if no plugins registered)
      expect(harness.plugins).toBeDefined();
    } finally {
      await harness.shutdown();
    }
  });
});
