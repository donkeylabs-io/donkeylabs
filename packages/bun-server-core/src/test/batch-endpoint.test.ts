import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Server } from "../server";
import { MagikRouter } from "../router";
import { RouterDefinition, RouteDefinition } from "@donkeylabs/core";
import { z } from "zod";
import { BATCH_ENDPOINT, BATCH_MAX_SIZE } from "@donkeylabs/core/src/client/batch";

// Test route schemas
const echoRequestSchema = z.object({ message: z.string() });
const echoResponseSchema = z.object({ echo: z.string() });

const addRequestSchema = z.object({ a: z.number(), b: z.number() });
const addResponseSchema = z.object({ result: z.number() });

// Test router definition
const testRouterDefinition: RouterDefinition = {
  routeName: "test",
  basePath: "/api/test",
  routes: {
    echo: new RouteDefinition({
      path: "/api/test/echo",
      method: "post",
      requestSchema: echoRequestSchema,
      responseSchema: echoResponseSchema,
      permissions: [],
    }),
    add: new RouteDefinition({
      path: "/api/test/add",
      method: "post",
      requestSchema: addRequestSchema,
      responseSchema: addResponseSchema,
      permissions: [],
    }),
    fail: new RouteDefinition({
      path: "/api/test/fail",
      method: "post",
      requestSchema: z.object({}),
      responseSchema: z.object({}),
      permissions: [],
    }),
  },
};

// Test dependencies type
type TestDeps = {
  testValue: string;
};

// Route map for batch endpoint
const routeMap = new Map<string, { path: string; method: string }>([
  ["test.echo", { path: "/api/test/echo", method: "post" }],
  ["test.add", { path: "/api/test/add", method: "post" }],
  ["test.fail", { path: "/api/test/fail", method: "post" }],
]);

describe("Server Batch Endpoint", () => {
  let server: Server<TestDeps>;
  const testPort = 9001;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  beforeAll(async () => {
    server = new Server<TestDeps>({ testValue: "test" }, ["*"], { disableTrustProxy: true });

    // Create and register a test router
    const createTestRouter = (deps: TestDeps) => {
      const router = new MagikRouter(testRouterDefinition, undefined as any);

      // Register echo route
      router.handle("echo", async (input, ctx) => {
        ctx.res.json({ echo: input.message });
      });

      // Register add route
      router.handle("add", async (input, ctx) => {
        ctx.res.json({ result: input.a + input.b });
      });

      // Register fail route that throws
      router.handle("fail", async (input, ctx) => {
        throw new Error("Intentional test error");
      });

      return router;
    };

    server.registerRouter(createTestRouter);
    server.registerBatchEndpoint(routeMap);
    server.listen(testPort);

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    await server.shutdown();
  });

  describe("valid batch requests", () => {
    it("executes single request in batch", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-1",
          failFast: false,
          requests: [{ id: "req1", router: "test", route: "echo", params: { message: "hello" } }],
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.traceId).toBeDefined();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].ok).toBe(true);
      expect(data.results[0].data).toEqual({ echo: "hello" });
      expect(data.results[0].ms).toBeDefined();
    });

    it("executes multiple requests in batch", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-2",
          failFast: false,
          requests: [
            { id: "req1", router: "test", route: "echo", params: { message: "first" } },
            { id: "req2", router: "test", route: "add", params: { a: 2, b: 3 } },
            { id: "req3", router: "test", route: "echo", params: { message: "third" } },
          ],
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.results).toHaveLength(3);
      expect(data.results[0].ok).toBe(true);
      expect(data.results[0].data).toEqual({ echo: "first" });
      expect(data.results[1].ok).toBe(true);
      expect(data.results[1].data).toEqual({ result: 5 });
      expect(data.results[2].ok).toBe(true);
      expect(data.results[2].data).toEqual({ echo: "third" });
    });

    it("returns totalMs in response", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-3",
          failFast: false,
          requests: [{ id: "req1", router: "test", route: "echo", params: { message: "test" } }],
        }),
      });

      const data = await response.json();
      expect(data.totalMs).toBeDefined();
      expect(typeof data.totalMs).toBe("number");
    });
  });

  describe("error handling", () => {
    it("returns error for unknown route", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-4",
          failFast: false,
          requests: [{ id: "req1", router: "unknown", route: "unknown", params: {} }],
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.results).toHaveLength(1);
      expect(data.results[0].ok).toBe(false);
      expect(data.results[0].error.type).toBe("NOT_FOUND");
      expect(data.results[0].error.message).toContain("Route unknown.unknown not found");
    });

    it("handles route errors gracefully", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-5",
          failFast: false,
          requests: [{ id: "req1", router: "test", route: "fail", params: {} }],
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.results).toHaveLength(1);
      expect(data.results[0].ok).toBe(false);
      // Error is returned from internal request
      expect(data.results[0].error).toBeDefined();
    });

    it("mixes successful and failed requests", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-6",
          failFast: false,
          requests: [
            { id: "req1", router: "test", route: "echo", params: { message: "success" } },
            { id: "req2", router: "unknown", route: "route", params: {} },
            { id: "req3", router: "test", route: "add", params: { a: 1, b: 2 } },
          ],
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.results).toHaveLength(3);
      expect(data.results[0].ok).toBe(true);
      expect(data.results[1].ok).toBe(false);
      expect(data.results[2].ok).toBe(true);
    });
  });

  describe("validation", () => {
    it("rejects invalid batch request schema", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Missing required fields
          requests: "not an array",
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.type).toBe("VALIDATION_ERROR");
    });

    it("rejects batch exceeding max size", async () => {
      const requests = Array.from({ length: BATCH_MAX_SIZE + 1 }, (_, i) => ({
        id: `req${i}`,
        router: "test",
        route: "echo",
        params: { message: "test" },
      }));

      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-7",
          failFast: false,
          requests,
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.type).toBe("VALIDATION_ERROR");
      // Schema validation with .max(10) triggers before server's manual check
      expect(data.message).toContain("Invalid batch request");
    });

    it("handles empty requests array", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-8",
          failFast: false,
          requests: [],
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.results).toHaveLength(0);
    });
  });

  describe("failFast mode", () => {
    it("returns all results when failFast is false", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-9",
          failFast: false,
          requests: [
            { id: "req1", router: "test", route: "echo", params: { message: "first" } },
            { id: "req2", router: "unknown", route: "route", params: {} },
            { id: "req3", router: "test", route: "echo", params: { message: "third" } },
          ],
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();

      // All requests should have results regardless of failures
      expect(data.results).toHaveLength(3);
    });

    it("processes with failFast true", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: "test-trace-10",
          failFast: true,
          requests: [
            { id: "req1", router: "test", route: "echo", params: { message: "first" } },
            { id: "req2", router: "test", route: "add", params: { a: 5, b: 5 } },
          ],
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.results).toHaveLength(2);
    });
  });

  describe("security", () => {
    it("rejects nested batch requests", async () => {
      const response = await fetch(`${baseUrl}${BATCH_ENDPOINT}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-batch-request": "true", // Simulate nested batch
        },
        body: JSON.stringify({
          traceId: "test-trace-nested",
          failFast: false,
          requests: [{ id: "req1", router: "test", route: "echo", params: { message: "nested" } }],
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.type).toBe("VALIDATION_ERROR");
      expect(data.message).toContain("Nested batch requests are not allowed");
    });
  });
});
