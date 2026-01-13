import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import {
  ApiClientBase,
  ApiError,
  ValidationError,
  type RequestOptions,
} from "../client/base";

// ==========================================
// Unit Tests for API Client Base
// ==========================================

describe("ApiError", () => {
  it("should create error with status and body", () => {
    const error = new ApiError(404, { error: "NOT_FOUND", message: "Not found" });
    expect(error.status).toBe(404);
    expect(error.body).toEqual({ error: "NOT_FOUND", message: "Not found" });
    expect(error.message).toBe("Not found");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.name).toBe("ApiError");
  });

  it("should use custom message if provided", () => {
    const error = new ApiError(500, { error: "INTERNAL" }, "Server exploded");
    expect(error.message).toBe("Server exploded");
  });

  it("should check error code with is()", () => {
    const error = new ApiError(404, { error: "NOT_FOUND", message: "Not found" });
    expect(error.is("NOT_FOUND")).toBe(true);
    expect(error.is("BAD_REQUEST")).toBe(false);
  });

  it("should fall back to API Error message when body has no message", () => {
    const error = new ApiError(500, {});
    expect(error.message).toBe("API Error: 500");
    expect(error.code).toBe("UNKNOWN_ERROR");
  });
});

describe("ValidationError", () => {
  it("should create validation error with details", () => {
    const details = [
      { path: ["email"], message: "Invalid email" },
      { path: ["name"], message: "Required" },
    ];
    const error = new ValidationError(details);

    expect(error.status).toBe(400);
    expect(error.validationDetails).toEqual(details);
    expect(error.message).toBe("Validation Failed");
    expect(error.name).toBe("ValidationError");
    expect(error.code).toBe("BAD_REQUEST");
  });

  it("should extend ApiError", () => {
    const error = new ValidationError([]);
    expect(error instanceof ApiError).toBe(true);
  });

  it("should get field errors by path", () => {
    const error = new ValidationError([
      { path: ["email"], message: "Invalid email" },
      { path: ["email"], message: "Too short" },
      { path: ["name"], message: "Required" },
    ]);

    expect(error.getFieldErrors("email")).toEqual(["Invalid email", "Too short"]);
    expect(error.getFieldErrors("name")).toEqual(["Required"]);
    expect(error.getFieldErrors("unknown")).toEqual([]);
  });

  it("should check if field has errors", () => {
    const error = new ValidationError([
      { path: ["email"], message: "Invalid email" },
    ]);

    expect(error.hasFieldError("email")).toBe(true);
    expect(error.hasFieldError("name")).toBe(false);
  });
});

describe("ApiClientBase", () => {
  // Mock fetch for testing
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
  });

  describe("constructor", () => {
    it("should normalize base URL by removing trailing slash", () => {
      const client = new TestClient("http://example.com/", { fetch: mockFetch });
      expect(client.getBaseUrl()).toBe("http://example.com");
    });

    it("should set default credentials to include", () => {
      const client = new TestClient("http://example.com", { fetch: mockFetch });
      expect(client.getOptions().credentials).toBe("include");
    });

    it("should allow overriding credentials", () => {
      const client = new TestClient("http://example.com", {
        fetch: mockFetch,
        credentials: "same-origin",
      });
      expect(client.getOptions().credentials).toBe("same-origin");
    });
  });

  describe("request", () => {
    it("should make POST request with JSON body", async () => {
      const client = new TestClient("http://example.com", { fetch: mockFetch });
      await client.testRequest("users.get", { id: 1 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://example.com/users.get");
      expect(options.method).toBe("POST");
      expect(options.body).toBe(JSON.stringify({ id: 1 }));
      expect(options.headers).toMatchObject({
        "Content-Type": "application/json",
      });
    });

    it("should include default headers", async () => {
      const client = new TestClient("http://example.com", {
        fetch: mockFetch,
        headers: { "X-API-Key": "secret" },
      });
      await client.testRequest("test", {});

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>)["X-API-Key"]).toBe("secret");
    });

    it("should merge request-specific headers", async () => {
      const client = new TestClient("http://example.com", {
        fetch: mockFetch,
        headers: { "X-Default": "default" },
      });
      await client.testRequest("test", {}, { headers: { "X-Custom": "custom" } });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["X-Default"]).toBe("default");
      expect(headers["X-Custom"]).toBe("custom");
    });

    it("should return parsed JSON response", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 1, name: "Test" }), { status: 200 })
        )
      );

      const client = new TestClient("http://example.com", { fetch: mockFetch });
      const result = await client.testRequest<{}, { id: number; name: string }>(
        "test",
        {}
      );

      expect(result).toEqual({ id: 1, name: "Test" });
    });

    it("should handle 204 No Content", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 204 }))
      );

      const client = new TestClient("http://example.com", { fetch: mockFetch });
      const result = await client.testRequest("test", {});

      expect(result).toBeUndefined();
    });

    it("should throw ValidationError for 400 with issues", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: "BAD_REQUEST",
              message: "Validation Failed",
              details: {
                issues: [{ path: ["email"], message: "Invalid" }],
              },
            }),
            { status: 400 }
          )
        )
      );

      const client = new TestClient("http://example.com", { fetch: mockFetch });

      await expect(client.testRequest("test", {})).rejects.toBeInstanceOf(
        ValidationError
      );

      // Verify the validation details
      try {
        await client.testRequest("test", {});
      } catch (e) {
        const error = e as ValidationError;
        expect(error.validationDetails).toEqual([{ path: ["email"], message: "Invalid" }]);
      }
    });

    it("should throw ApiError for non-200 responses", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Not Found" }), { status: 404 })
        )
      );

      const client = new TestClient("http://example.com", { fetch: mockFetch });

      try {
        await client.testRequest("test", {});
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(404);
      }
    });

    it("should pass abort signal", async () => {
      const client = new TestClient("http://example.com", { fetch: mockFetch });
      const controller = new AbortController();

      await client.testRequest("test", {}, { signal: controller.signal });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.signal).toBe(controller.signal);
    });
  });

  describe("rawRequest", () => {
    it("should make request without JSON content type", async () => {
      const client = new TestClient("http://example.com", { fetch: mockFetch });
      await client.testRawRequest("download");

      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://example.com/download");
      expect(options.headers).not.toHaveProperty("Content-Type");
    });

    it("should return raw Response", async () => {
      const mockResponse = new Response("file content", { status: 200 });
      mockFetch.mockImplementation(() => Promise.resolve(mockResponse));

      const client = new TestClient("http://example.com", { fetch: mockFetch });
      const response = await client.testRawRequest("download");

      expect(response).toBeInstanceOf(Response);
      expect(await response.text()).toBe("file content");
    });
  });

  describe("event handling", () => {
    it("should register event handlers", () => {
      const client = new TestClient("http://example.com", { fetch: mockFetch });
      const handler = mock(() => {});

      client.on("test", handler);
      client.triggerEvent("test", { data: "value" });

      expect(handler).toHaveBeenCalledWith({ data: "value" });
    });

    it("should return unsubscribe function", () => {
      const client = new TestClient("http://example.com", { fetch: mockFetch });
      const handler = mock(() => {});

      const unsubscribe = client.on("test", handler);
      unsubscribe();
      client.triggerEvent("test", { data: "value" });

      expect(handler).not.toHaveBeenCalled();
    });

    it("should support multiple handlers for same event", () => {
      const client = new TestClient("http://example.com", { fetch: mockFetch });
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});

      client.on("test", handler1);
      client.on("test", handler2);
      client.triggerEvent("test", { data: "value" });

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it("should handle once subscription", () => {
      const client = new TestClient("http://example.com", { fetch: mockFetch });
      const handler = mock(() => {});

      client.once("test", handler);
      client.triggerEvent("test", { first: true });
      client.triggerEvent("test", { second: true });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ first: true });
    });

    it("should remove all handlers with off", () => {
      const client = new TestClient("http://example.com", { fetch: mockFetch });
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});

      client.on("test", handler1);
      client.on("test", handler2);
      client.off("test");
      client.triggerEvent("test", {});

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });
});

// ==========================================
// Test Helper Class
// ==========================================

// Extends ApiClientBase to expose protected methods for testing
class TestClient extends ApiClientBase<{
  test: { data: string };
  notification: { message: string };
}> {
  getBaseUrl(): string {
    return this.baseUrl;
  }

  getOptions() {
    return this.options;
  }

  async testRequest<I, O>(
    route: string,
    input: I,
    options?: RequestOptions
  ): Promise<O> {
    return this.request<I, O>(route, input, options);
  }

  async testRawRequest(route: string, init?: RequestInit): Promise<Response> {
    return this.rawRequest(route, init);
  }

  // Trigger event dispatch for testing (simulates SSE message)
  triggerEvent(eventName: string, data: any): void {
    // Access the private dispatchEvent via type casting
    (this as any).dispatchEvent(eventName, JSON.stringify(data));
  }
}
