import { describe, it, expect, mock, beforeEach } from "bun:test";
import { UnifiedApiClientBase, type ClientOptions } from "../src/client/index";

// ============================================
// Test Client Implementation
// ============================================

/**
 * Test client that exposes protected methods for testing
 */
class TestApiClient extends UnifiedApiClientBase {
  constructor(options?: ClientOptions) {
    super(options);
  }

  // Expose protected methods for testing
  async testRequest<TInput, TOutput>(
    route: string,
    input: TInput,
    options?: { headers?: Record<string, string>; signal?: AbortSignal }
  ): Promise<TOutput> {
    return this.request<TInput, TOutput>(route, input, options);
  }

  async testRawRequest(route: string, init?: RequestInit): Promise<Response> {
    return this.rawRequest(route, init);
  }
}

// ============================================
// Tests
// ============================================

describe("UnifiedApiClientBase", () => {
  describe("rawRequest", () => {
    it("should make a raw HTTP request and return Response object", async () => {
      const mockResponse = new Response(JSON.stringify({ data: "test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      const mockFetch = mock(() => Promise.resolve(mockResponse));

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      const response = await client.testRawRequest("test.route");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(response).toBe(mockResponse);
      expect(response.status).toBe(200);
    });

    it("should construct correct URL with baseUrl and route", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(new Response("ok", { status: 200 }))
      );

      const client = new TestApiClient({
        baseUrl: "http://api.example.com",
        fetch: mockFetch as typeof fetch,
      });

      await client.testRawRequest("cameras.stream");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://api.example.com/cameras.stream");
    });

    it("should use POST method by default", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(new Response("ok", { status: 200 }))
      );

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      await client.testRawRequest("test.route");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
    });

    it("should allow overriding HTTP method via init", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(new Response("ok", { status: 200 }))
      );

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      await client.testRawRequest("test.route", { method: "GET" });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("GET");
    });

    it("should pass through custom headers from init", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(new Response("ok", { status: 200 }))
      );

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      await client.testRawRequest("test.route", {
        headers: {
          "X-Custom-Header": "custom-value",
          "Accept": "text/event-stream",
        },
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toEqual({
        "X-Custom-Header": "custom-value",
        "Accept": "text/event-stream",
      });
    });

    it("should pass through request body from init", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(new Response("ok", { status: 200 }))
      );

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      const body = JSON.stringify({ key: "value" });
      await client.testRawRequest("test.route", { body });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe(body);
    });

    it("should return streaming responses without processing", async () => {
      // Simulate a streaming response
      const streamData = "data: chunk1\n\ndata: chunk2\n\n";
      const mockResponse = new Response(streamData, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });

      const mockFetch = mock(() => Promise.resolve(mockResponse));

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      const response = await client.testRawRequest("cameras.stream", {
        headers: { "Accept": "text/event-stream" },
      });

      // Response should be returned as-is, not parsed
      expect(response).toBe(mockResponse);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Body should be readable
      const text = await response.text();
      expect(text).toBe(streamData);
    });

    it("should not throw on non-2xx responses (let caller handle)", async () => {
      const mockResponse = new Response("Not Found", { status: 404 });
      const mockFetch = mock(() => Promise.resolve(mockResponse));

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      // rawRequest should NOT throw - it returns the raw response
      const response = await client.testRawRequest("nonexistent.route");
      expect(response.status).toBe(404);
    });

    it("should work with empty baseUrl (relative URLs)", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(new Response("ok", { status: 200 }))
      );

      const client = new TestApiClient({
        baseUrl: "",
        fetch: mockFetch as typeof fetch,
      });

      await client.testRawRequest("api.test");

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api.test");
    });

    it("should use custom fetch function when provided", async () => {
      const customFetch = mock(() =>
        Promise.resolve(new Response("custom", { status: 200 }))
      );

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: customFetch as typeof fetch,
      });

      await client.testRawRequest("test.route");

      expect(customFetch).toHaveBeenCalledTimes(1);
    });

    it("should support AbortSignal for cancellation", async () => {
      const controller = new AbortController();
      const mockFetch = mock(() =>
        Promise.resolve(new Response("ok", { status: 200 }))
      );

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      await client.testRawRequest("test.route", {
        signal: controller.signal,
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBe(controller.signal);
    });
  });

  describe("request (typed)", () => {
    it("should make a typed POST request with JSON body", async () => {
      const mockResponse = new Response(JSON.stringify({ id: 1, name: "Test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      const mockFetch = mock(() => Promise.resolve(mockResponse));

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      const result = await client.testRequest<{ name: string }, { id: number; name: string }>(
        "users.create",
        { name: "Test" }
      );

      expect(result).toEqual({ id: 1, name: "Test" });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:3000/users.create");
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ name: "Test" }));
    });

    it("should throw on non-2xx responses with error message", async () => {
      const mockResponse = new Response(
        JSON.stringify({ error: "Not Found", message: "User not found" }),
        { status: 404 }
      );

      const mockFetch = mock(() => Promise.resolve(mockResponse));

      const client = new TestApiClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch as typeof fetch,
      });

      await expect(
        client.testRequest("users.get", { id: 999 })
      ).rejects.toThrow("User not found");
    });
  });
});
