import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { z } from "zod";
import { APIClient, RouteRequest } from "../APIClient";
import { RouteDefinition } from "../../interfaces/server/route";
import { ApiError, ErrorType } from "../../errors";
import type { UserSession } from "../../jwt";
import { BATCH_ENDPOINT, BATCH_MAX_SIZE } from "../batch";

// Test route definitions
const testRequestSchema = z.object({ id: z.number() });
const testResponseSchema = z.object({ name: z.string(), value: z.number() });

const testRouteDef = new RouteDefinition({
  path: "/api/test/item",
  method: "post",
  requestSchema: testRequestSchema,
  responseSchema: testResponseSchema,
  permissions: [],
});

const getRouteDef = new RouteDefinition({
  path: "/api/test/item",
  method: "get",
  requestSchema: z.object({}),
  responseSchema: testResponseSchema,
  permissions: [],
});

// Helper to create mock responses
function mockJsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function mockPdfResponse() {
  return new Response(new Blob(["pdf content"]), {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
  });
}

// Helper to create a fake session
function fakeSession(expired = false): UserSession {
  const expiration = new Date();
  if (expired) {
    expiration.setHours(expiration.getHours() - 1);
  } else {
    expiration.setHours(expiration.getHours() + 1);
  }
  return {
    userId: 1,
    username: "testuser",
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    accessTokenExpiration: expiration,
    permissions: ["read", "write"],
    employeeId: 100,
    employeeName: "Test User",
  };
}

describe("APIClient", () => {
  const baseUrl = "https://api.test.com";
  let client: APIClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new APIClient(baseUrl, "in-memory");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor and configuration", () => {
    it("creates client with base URL", () => {
      const c = new APIClient("https://example.com", "in-memory");
      expect(c).toBeDefined();
    });

    it("returns null session initially", () => {
      expect(client.getSession()).toBeNull();
    });

    it("sets and gets session", () => {
      const session = fakeSession();
      // Simulate setting session through raw session format
      client.setUserSession({
        accessToken: createMockJwt({ userId: 1, username: "test", permissions: [], employeeId: 1, employeeName: "Test" }),
        refreshToken: "refresh-token",
      });
      expect(client.getSession()).not.toBeNull();
    });

    it("sets onError callback", () => {
      let errorReceived: Error | null = null;
      client.setOnError((error) => {
        errorReceived = error;
      });
      // The callback is stored internally
      expect(errorReceived).toBeNull();
    });

    it("sets onSessionExpired callback", () => {
      let called = false;
      client.setOnSessionExpired(() => {
        called = true;
      });
      // The callback is stored internally
      expect(called).toBe(false);
    });

    it("sets onSessionRequired callback", () => {
      let called = false;
      client.setOnSessionRequired(() => {
        called = true;
      });
      expect(called).toBe(false);
    });
  });

  describe("run()", () => {
    it("makes successful POST request", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(mockJsonResponse({ name: "test", value: 42 })),
      );

      const request = new RouteRequest(testRouteDef, { id: 1 });
      const result = await client.run(request);

      expect(result).toEqual({ name: "test", value: 42 });
    });

    it("throws error for missing input on POST", async () => {
      const request = new RouteRequest(testRouteDef, undefined);

      try {
        await client.run(request);
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toBe("Input data is required.");
      }
    });

    it("makes GET request without body", async () => {
      globalThis.fetch = mock((url: string, init: RequestInit) => {
        expect(init.body).toBeUndefined();
        return Promise.resolve(mockJsonResponse({ name: "get-result", value: 100 }));
      });

      const request = new RouteRequest(getRouteDef, {});
      const result = await client.run(request);

      expect(result).toEqual({ name: "get-result", value: 100 });
    });

    it("includes authorization header when session exists", async () => {
      let capturedHeaders: Record<string, string> = {};
      globalThis.fetch = mock((url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        return Promise.resolve(mockJsonResponse({ name: "test", value: 1 }));
      });

      // Set up a session
      client.setUserSession({
        accessToken: createMockJwt({ userId: 1, username: "test", permissions: [], employeeId: 1, employeeName: "Test" }),
        refreshToken: "refresh-token",
      });

      const request = new RouteRequest(testRouteDef, { id: 1 });
      await client.run(request);

      expect(capturedHeaders["authorization"]).toContain("Bearer");
    });

    it("includes no-cache headers when noCache is true", async () => {
      let capturedHeaders: Record<string, string> = {};
      globalThis.fetch = mock((url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        return Promise.resolve(mockJsonResponse({ name: "test", value: 1 }));
      });

      const request = new RouteRequest(testRouteDef, { id: 1 }, true);
      await client.run(request);

      expect(capturedHeaders["cache-control"]).toBe("no-cache, no-store, must-revalidate");
      expect(capturedHeaders["pragma"]).toBe("no-cache");
    });

    it("throws ApiError on server error", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          mockJsonResponse(
            { type: ErrorType.NOT_FOUND, message: "Resource not found" },
            404,
          ),
        ),
      );

      let errorCaught: Error | null = null;
      client.setOnError((e) => {
        errorCaught = e;
      });

      const request = new RouteRequest(testRouteDef, { id: 999 });

      try {
        await client.run(request);
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof ApiError).toBe(true);
        expect((error as ApiError).type).toBe(ErrorType.NOT_FOUND);
      }

      expect(errorCaught).not.toBeNull();
    });

    it("handles PDF response", async () => {
      globalThis.fetch = mock(() => Promise.resolve(mockPdfResponse()));

      const pdfRouteDef = new RouteDefinition({
        path: "/api/test/pdf",
        method: "get",
        requestSchema: z.object({}),
        responseSchema: z.any(),
        permissions: [],
      });

      const request = new RouteRequest(pdfRouteDef, {});
      const result = await client.run(request);

      expect(result instanceof Blob).toBe(true);
    });

    it("uses custom fetch function from config", async () => {
      let customFetchCalled = false;
      const customFetch = mock(() => {
        customFetchCalled = true;
        return Promise.resolve(mockJsonResponse({ name: "custom", value: 99 }));
      });

      const request = new RouteRequest(testRouteDef, { id: 1 });
      const result = await client.run(request, { fetchFn: customFetch });

      expect(customFetchCalled).toBe(true);
      expect(result).toEqual({ name: "custom", value: 99 });
    });
  });

  describe("batch()", () => {
    it("returns empty array for empty requests", async () => {
      const results = await client.batch([]);
      expect(results).toEqual([]);
    });

    it("throws error when batch exceeds max size", async () => {
      const requests = Array.from({ length: BATCH_MAX_SIZE + 1 }, () =>
        new RouteRequest(testRouteDef, { id: 1 }),
      );

      try {
        await client.batch(requests);
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain("exceeds maximum");
      }
    });

    it("makes batch request and returns results", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          mockJsonResponse({
            traceId: "test-trace",
            totalMs: 100,
            results: [
              { id: "req_0", ok: true, data: { name: "first", value: 1 }, cached: false, ms: 50 },
              { id: "req_1", ok: true, data: { name: "second", value: 2 }, cached: true, ms: 30 },
            ],
          }),
        ),
      );

      const requests = [
        new RouteRequest(testRouteDef, { id: 1 }, false, "test", "item"),
        new RouteRequest(testRouteDef, { id: 2 }, false, "test", "item"),
      ] as const;

      const results = await client.batch(requests);

      expect(results.length).toBe(2);
      expect(results[0].ok).toBe(true);
      if (results[0].ok) {
        expect(results[0].data).toEqual({ name: "first", value: 1 });
        expect(results[0].cached).toBe(false);
      }
      expect(results[1].ok).toBe(true);
      if (results[1].ok) {
        expect(results[1].data).toEqual({ name: "second", value: 2 });
        expect(results[1].cached).toBe(true);
      }
    });

    it("handles mixed success and error results", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          mockJsonResponse({
            traceId: "test-trace",
            totalMs: 100,
            results: [
              { id: "req_0", ok: true, data: { name: "success", value: 1 }, cached: false, ms: 50 },
              {
                id: "req_1",
                ok: false,
                error: { type: ErrorType.NOT_FOUND, message: "Not found" },
                ms: 30,
              },
            ],
          }),
        ),
      );

      const requests = [
        new RouteRequest(testRouteDef, { id: 1 }, false, "test", "item"),
        new RouteRequest(testRouteDef, { id: 2 }, false, "test", "item"),
      ] as const;

      const results = await client.batch(requests);

      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(false);
      if (!results[1].ok) {
        expect(results[1].error.type).toBe(ErrorType.NOT_FOUND);
      }
    });

    it("throws on batch endpoint failure", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          mockJsonResponse(
            { type: ErrorType.INTERNAL_SERVER_ERROR, message: "Server error" },
            500,
          ),
        ),
      );

      const requests = [new RouteRequest(testRouteDef, { id: 1 }, false, "test", "item")] as const;

      try {
        await client.batch(requests);
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof ApiError).toBe(true);
      }
    });
  });

  describe("parallel()", () => {
    it("returns empty array for empty requests", async () => {
      const results = await client.parallel([]);
      expect(results).toEqual([]);
    });

    it("throws error when batch exceeds max size", async () => {
      const requests = Array.from({ length: BATCH_MAX_SIZE + 1 }, () =>
        new RouteRequest(testRouteDef, { id: 1 }),
      );

      try {
        await client.parallel(requests);
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain("exceeds maximum");
      }
    });

    it("makes parallel request and returns unwrapped results", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          mockJsonResponse({
            traceId: "test-trace",
            totalMs: 100,
            results: [
              { id: "req_0", ok: true, data: { name: "first", value: 1 }, cached: false, ms: 50 },
              { id: "req_1", ok: true, data: { name: "second", value: 2 }, cached: false, ms: 30 },
            ],
          }),
        ),
      );

      const requests = [
        new RouteRequest(testRouteDef, { id: 1 }, false, "test", "item"),
        new RouteRequest(testRouteDef, { id: 2 }, false, "test", "item"),
      ] as const;

      const results = await client.parallel(requests);

      expect(results.length).toBe(2);
      expect(results[0]).toEqual({ name: "first", value: 1 });
      expect(results[1]).toEqual({ name: "second", value: 2 });
    });

    it("throws on first failure", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          mockJsonResponse({
            traceId: "test-trace",
            totalMs: 100,
            results: [
              { id: "req_0", ok: true, data: { name: "success", value: 1 }, cached: false, ms: 50 },
              {
                id: "req_1",
                ok: false,
                error: { type: ErrorType.FORBIDDEN, message: "Access denied" },
                ms: 30,
              },
            ],
          }),
        ),
      );

      const requests = [
        new RouteRequest(testRouteDef, { id: 1 }, false, "test", "item"),
        new RouteRequest(testRouteDef, { id: 2 }, false, "test", "item"),
      ] as const;

      try {
        await client.parallel(requests);
        expect(true).toBe(false);
      } catch (error) {
        expect(error instanceof ApiError).toBe(true);
        expect((error as ApiError).type).toBe(ErrorType.FORBIDDEN);
      }
    });
  });

  describe("session management", () => {
    it("useSession returns null when no session", async () => {
      const session = await client.useSession();
      expect(session).toBeNull();
    });

    it("handleSessionExpired clears session and calls callback", () => {
      let callbackCalled = false;
      client.setOnSessionExpired(() => {
        callbackCalled = true;
      });

      // Set a session first
      client.setUserSession({
        accessToken: createMockJwt({ userId: 1, username: "test", permissions: [], employeeId: 1, employeeName: "Test" }),
        refreshToken: "refresh-token",
      });

      expect(client.getSession()).not.toBeNull();

      client.handleSessionExpired();

      expect(client.getSession()).toBeNull();
      expect(callbackCalled).toBe(true);
    });

    it("logout clears session", () => {
      client.setUserSession({
        accessToken: createMockJwt({ userId: 1, username: "test", permissions: [], employeeId: 1, employeeName: "Test" }),
        refreshToken: "refresh-token",
      });

      expect(client.getSession()).not.toBeNull();

      client.logout();

      expect(client.getSession()).toBeNull();
    });
  });
});

// Helper to create a mock JWT token
function createMockJwt(payload: {
  userId: number;
  username: string;
  permissions: string[];
  employeeId: number;
  employeeName: string;
}): string {
  const header = { alg: "HS256", typ: "JWT" };
  const exp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  const fullPayload = { ...payload, exp };

  const base64Header = btoa(JSON.stringify(header));
  const base64Payload = btoa(JSON.stringify(fullPayload));
  const signature = "mock-signature";

  return `${base64Header}.${base64Payload}.${signature}`;
}
