import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { z } from "zod";
import { RouteDefinition } from "../route";
import { ApiError, ErrorType } from "../../../errors";

// Test schemas
const userRequestSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().positive().optional(),
});

const userResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  createdAt: z.string(),
});

describe("RouteDefinition", () => {
  describe("constructor", () => {
    it("creates route definition with all properties", () => {
      const route = new RouteDefinition({
        path: "/api/users",
        method: "post",
        requestSchema: userRequestSchema,
        responseSchema: userResponseSchema,
        permissions: ["user:create"],
      });

      expect(route.path).toBe("/api/users");
      expect(route.method).toBe("post");
      expect(route.permissions).toEqual(["user:create"]);
    });

    it("creates route definition with rate limit config", () => {
      const route = new RouteDefinition({
        path: "/api/auth/login",
        method: "post",
        requestSchema: z.object({ username: z.string() }),
        responseSchema: z.object({ token: z.string() }),
        permissions: [],
        rateLimit: {
          keyStrategy: "ip",
          window: "1m",
          maxAttempts: 5,
        },
      });

      expect(route.rateLimit).toBeDefined();
      expect(route.rateLimit?.maxAttempts).toBe(5);
      expect(route.rateLimit?.window).toBe("1m");
    });

    it("creates route definition with empty permissions", () => {
      const route = new RouteDefinition({
        path: "/api/public/info",
        method: "get",
        requestSchema: z.object({}),
        responseSchema: z.object({ version: z.string() }),
        permissions: [],
      });

      expect(route.permissions).toEqual([]);
    });
  });

  describe("parseResponse", () => {
    const route = new RouteDefinition({
      path: "/api/users",
      method: "get",
      requestSchema: z.object({}),
      responseSchema: userResponseSchema,
      permissions: [],
    });

    it("parses valid response", () => {
      const response = {
        id: 1,
        name: "John Doe",
        email: "john@example.com",
        createdAt: "2024-01-01T00:00:00Z",
      };

      const result = route.parseResponse(response);

      expect(result).toEqual(response);
    });

    it("throws validation error for invalid response", () => {
      const invalidResponse = {
        id: "not-a-number",
        name: "John",
      };

      try {
        route.parseResponse(invalidResponse);
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof ApiError).toBe(true);
        expect((error as ApiError).type).toBe(ErrorType.VALIDATION_ERROR);
      }
    });

    it("throws validation error for missing required fields", () => {
      const incompleteResponse = {
        id: 1,
        name: "John",
        // missing email and createdAt
      };

      try {
        route.parseResponse(incompleteResponse);
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof ApiError).toBe(true);
      }
    });
  });

  describe("parseBody", () => {
    const postRoute = new RouteDefinition({
      path: "/api/users",
      method: "post",
      requestSchema: userRequestSchema,
      responseSchema: userResponseSchema,
      permissions: [],
    });

    const getRoute = new RouteDefinition({
      path: "/api/users",
      method: "get",
      requestSchema: z.object({}),
      responseSchema: userResponseSchema,
      permissions: [],
    });

    const deleteRoute = new RouteDefinition({
      path: "/api/users/:id",
      method: "delete",
      requestSchema: z.object({}),
      responseSchema: z.object({ success: z.boolean() }),
      permissions: [],
    });

    it("parses valid POST body", () => {
      const body = {
        name: "Jane Doe",
        email: "jane@example.com",
        age: 25,
      };

      const result = postRoute.parseBody(body);

      expect(result).toEqual(body);
    });

    it("parses POST body with optional fields omitted", () => {
      const body = {
        name: "Jane Doe",
        email: "jane@example.com",
      };

      const result = postRoute.parseBody(body);

      expect(result).toEqual(body);
      expect(result.age).toBeUndefined();
    });

    it("throws validation error for invalid body", () => {
      const invalidBody = {
        name: "",
        email: "not-an-email",
      };

      try {
        postRoute.parseBody(invalidBody);
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof ApiError).toBe(true);
        expect((error as ApiError).type).toBe(ErrorType.VALIDATION_ERROR);
      }
    });

    it("returns empty object for GET requests", () => {
      const result = getRoute.parseBody({ any: "data" });
      expect(result).toEqual({});
    });

    it("returns empty object for DELETE requests", () => {
      const result = deleteRoute.parseBody({ any: "data" });
      expect(result).toEqual({});
    });
  });

  describe("run()", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    const route = new RouteDefinition({
      path: "/api/items",
      method: "post",
      requestSchema: z.object({ name: z.string() }),
      responseSchema: z.object({ id: z.number(), name: z.string() }),
      permissions: [],
    });

    const getRoute = new RouteDefinition({
      path: "/api/items",
      method: "get",
      requestSchema: z.object({}),
      responseSchema: z.object({ items: z.array(z.string()) }),
      permissions: [],
    });

    it("makes successful request", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 1, name: "Test Item" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const result = await route.run("https://api.test.com", { name: "Test Item" });

      expect(result).toEqual({ id: 1, name: "Test Item" });
    });

    it("includes authorization header when provided", async () => {
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = mock((url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        return Promise.resolve(
          new Response(JSON.stringify({ id: 1, name: "Test" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      await route.run("https://api.test.com", { name: "Test" }, { authToken: "my-token" });

      expect(capturedHeaders["authorization"]).toBe("Bearer my-token");
    });

    it("includes custom headers", async () => {
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = mock((url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        return Promise.resolve(
          new Response(JSON.stringify({ id: 1, name: "Test" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      await route.run("https://api.test.com", { name: "Test" }, { headers: { "X-Custom": "value" } });

      expect(capturedHeaders["x-custom"]).toBe("value");
    });

    it("does not include body for GET request", async () => {
      let capturedBody: any = "not-undefined";

      globalThis.fetch = mock((url: string, init: RequestInit) => {
        capturedBody = init.body;
        return Promise.resolve(
          new Response(JSON.stringify({ items: ["a", "b", "c"] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      await getRoute.run("https://api.test.com", {});

      expect(capturedBody).toBeUndefined();
    });

    it("throws ApiError on server error", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ type: ErrorType.NOT_FOUND, message: "Not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      try {
        await route.run("https://api.test.com", { name: "Missing" });
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof ApiError).toBe(true);
        expect((error as ApiError).type).toBe(ErrorType.NOT_FOUND);
      }
    });

    it("throws ZodError on invalid response format", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ unexpected: "format" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      try {
        await route.run("https://api.test.com", { name: "Test" });
        expect(true).toBe(false);
      } catch (error) {
        // run() uses responseSchema.parse() directly, which throws ZodError
        expect((error as Error).name).toBe("ZodError");
      }
    });
  });

  describe("runWithFetch()", () => {
    const route = new RouteDefinition({
      path: "/api/items",
      method: "post",
      requestSchema: z.object({ name: z.string() }),
      responseSchema: z.object({ id: z.number(), name: z.string() }),
      permissions: [],
    });

    const getRoute = new RouteDefinition({
      path: "/api/items",
      method: "get",
      requestSchema: z.object({}),
      responseSchema: z.object({ items: z.array(z.string()) }),
      permissions: [],
    });

    it("uses custom fetch function", async () => {
      const customFetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 99, name: "Custom" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const result = await route.runWithFetch("https://api.test.com", { name: "Custom" }, customFetch);

      expect(result).toEqual({ id: 99, name: "Custom" });
      expect(customFetch).toHaveBeenCalled();
    });

    it("sends null body for GET requests", async () => {
      let capturedBody: any = "not-null";

      const customFetch = mock((url: string, init: RequestInit) => {
        capturedBody = init.body;
        return Promise.resolve(
          new Response(JSON.stringify({ items: ["x", "y"] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      await getRoute.runWithFetch("https://api.test.com", {}, customFetch);

      expect(capturedBody).toBeNull();
    });

    it("includes auth token in headers", async () => {
      let capturedHeaders: Record<string, string> = {};

      const customFetch = mock((url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        return Promise.resolve(
          new Response(JSON.stringify({ id: 1, name: "Test" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      await route.runWithFetch(
        "https://api.test.com",
        { name: "Test" },
        customFetch,
        { authToken: "bearer-token" },
      );

      expect(capturedHeaders["authorization"]).toBe("Bearer bearer-token");
    });

    it("throws ApiError on error response", async () => {
      const customFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ type: ErrorType.FORBIDDEN, message: "Forbidden" }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      try {
        await route.runWithFetch("https://api.test.com", { name: "Test" }, customFetch);
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof ApiError).toBe(true);
        expect((error as ApiError).type).toBe(ErrorType.FORBIDDEN);
      }
    });
  });

  describe("type helpers", () => {
    it("exposes RequestType and ResponseType", () => {
      const route = new RouteDefinition({
        path: "/api/test",
        method: "post",
        requestSchema: userRequestSchema,
        responseSchema: userResponseSchema,
        permissions: [],
      });

      // These are type-level helpers, just verify they exist
      expect(route.RequestType).toBeUndefined(); // Runtime value is undefined
      expect(route.ResponseType).toBeUndefined();
    });
  });
});
