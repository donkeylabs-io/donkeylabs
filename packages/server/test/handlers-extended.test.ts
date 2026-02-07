import { describe, it, expect } from "bun:test";
import { createHandler, TypedHandler, SSEHandler, FormDataHandler } from "../src/handlers";
import type { ServerContext, RouteDefinition } from "../src/router";
import { z } from "zod";

describe("createHandler", () => {
  it("should return a handler runtime with execute function", () => {
    const handler = createHandler<(input: any) => any>(async (req, def, handle, ctx) => {
      const body = await req.json();
      const result = await handle(body);
      return Response.json(result);
    });

    expect(handler).toBeDefined();
    expect(typeof handler.execute).toBe("function");
  });
});

describe("TypedHandler edge cases", () => {
  const mockCtx = {
    core: {},
    requestId: "test-req",
    traceId: "test-trace",
    startTime: Date.now(),
    plugins: {},
  } as unknown as ServerContext;

  it("should return 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });

    const def = {
      input: z.object({ name: z.string() }),
    } as unknown as RouteDefinition;

    const handle = async (input: any) => input;

    const response = await TypedHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(400);
  });

  it("should return 400 for Zod validation errors", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ name: 123 }), // valid JSON but wrong type
      headers: { "Content-Type": "application/json" },
    });

    const def = {
      input: z.object({ name: z.string() }),
    } as unknown as RouteDefinition;

    const handle = async (input: any) => input;

    const origError = console.error;
    console.error = () => {};
    try {
      const response = await TypedHandler.execute(req, def, handle, mockCtx);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation Failed");
      expect(body.details).toBeDefined();
      expect(Array.isArray(body.details)).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it("should return 500 for handler errors", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ name: "test" }),
      headers: { "Content-Type": "application/json" },
    });

    const def = {} as unknown as RouteDefinition;

    const handle = async () => {
      throw new Error("handler error");
    };

    const response = await TypedHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("handler error");
  });
});

describe("SSEHandler edge cases", () => {
  const mockCtx = {
    core: {
      sse: {
        addClient: () => ({
          client: { id: "sse-1" },
          response: new Response("stream", { status: 200 }),
        }),
        subscribe: () => {},
        removeClient: () => {},
      },
    },
    requestId: "test-req",
    traceId: "test-trace",
    startTime: Date.now(),
    plugins: {},
  } as unknown as ServerContext;

  it("should reject non-GET/POST methods", async () => {
    const req = new Request("http://localhost/sse", { method: "DELETE" });
    const def = {} as unknown as RouteDefinition;
    const handle = async () => ["channel1"];

    const response = await SSEHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(405);
  });

  it("should return 400 for invalid POST JSON", async () => {
    const req = new Request("http://localhost/sse", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const def = {} as unknown as RouteDefinition;
    const handle = async () => ["channel1"];

    const response = await SSEHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(400);
  });

  it("should handle GET with query params", async () => {
    const req = new Request("http://localhost/sse?channel=news&count=5", {
      method: "GET",
    });
    const def = {} as unknown as RouteDefinition;
    const handle = async (input: any) => {
      expect(input.channel).toBe("news");
      expect(input.count).toBe(5); // JSON.parse("5") = 5
      return ["news"];
    };

    const response = await SSEHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(200);
  });

  it("should handle abort signal for cleanup", async () => {
    const controller = new AbortController();
    const req = new Request("http://localhost/sse", {
      method: "GET",
      signal: controller.signal,
    });

    let removedClientId: string | null = null;
    const ctx = {
      ...mockCtx,
      core: {
        ...mockCtx.core,
        sse: {
          ...mockCtx.core.sse,
          removeClient: (id: string) => { removedClientId = id; },
          addClient: () => ({
            client: { id: "sse-cleanup" },
            response: new Response("stream", { status: 200 }),
          }),
          subscribe: () => {},
        },
      },
    } as unknown as ServerContext;

    const def = {} as unknown as RouteDefinition;
    const handle = async () => ["channel1"];

    await SSEHandler.execute(req, def, handle, ctx);

    // Trigger abort
    controller.abort();
    // Allow microtask to run
    await new Promise((r) => setTimeout(r, 10));
    expect(removedClientId).toBe("sse-cleanup");
  });

  it("should return 400 on validation error", async () => {
    const req = new Request("http://localhost/sse", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const def = {
      input: z.object({ required: z.string() }),
    } as unknown as RouteDefinition;
    const handle = async () => ["channel1"];

    const response = await SSEHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation Failed");
  });

  it("should return error status from handler errors", async () => {
    const req = new Request("http://localhost/sse", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const def = {} as unknown as RouteDefinition;
    const handle = async () => {
      const error = new Error("Not Found") as any;
      error.status = 404;
      throw error;
    };

    const response = await SSEHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(404);
  });
});

describe("FormDataHandler", () => {
  const mockCtx = {
    core: {},
    requestId: "test-req",
    traceId: "test-trace",
    startTime: Date.now(),
    plugins: {},
  } as unknown as ServerContext;

  it("should reject non-POST methods", async () => {
    const req = new Request("http://localhost/upload", { method: "GET" });
    const def = {} as unknown as RouteDefinition;
    const handle = async (data: any) => data;

    const response = await FormDataHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(405);
  });

  it("should reject non-multipart content type", async () => {
    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: "hello",
      headers: { "Content-Type": "text/plain" },
    });
    const def = {} as unknown as RouteDefinition;
    const handle = async (data: any) => data;

    const response = await FormDataHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("multipart/form-data");
  });

  it("should parse form data with fields and return result", async () => {
    const formData = new FormData();
    formData.append("name", "test");
    formData.append("count", "42");

    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });
    const def = {} as unknown as RouteDefinition;
    const handle = async (data: any) => ({ received: data.fields });

    const response = await FormDataHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.received.name).toBe("test");
    expect(body.received.count).toBe(42); // JSON parsed
  });

  it("should return 400 for Zod validation errors on form fields", async () => {
    const formData = new FormData();
    formData.append("name", "123");

    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });
    const def = {
      input: z.object({ name: z.string(), email: z.string().email() }),
    } as unknown as RouteDefinition;
    const handle = async (data: any) => data;

    const origError = console.error;
    console.error = () => {};
    try {
      const response = await FormDataHandler.execute(req, def, handle, mockCtx);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation Failed");
      expect(body.details).toBeDefined();
    } finally {
      console.error = origError;
    }
  });

  it("should handle file uploads", async () => {
    const formData = new FormData();
    formData.append("title", "My Upload");
    formData.append("file", new File(["hello"], "test.txt", { type: "text/plain" }));

    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });
    const def = {} as unknown as RouteDefinition;
    const handle = async (data: any) => ({
      fieldCount: Object.keys(data.fields).length,
      fileCount: data.files.length,
    });

    const response = await FormDataHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fieldCount).toBe(1);
    expect(body.fileCount).toBe(1);
  });

  it("should reject files exceeding maxSize", async () => {
    const formData = new FormData();
    formData.append("file", new File(["a".repeat(1000)], "big.txt", { type: "text/plain" }));

    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });
    const def = {
      fileConstraints: { maxSize: 100 },
    } as unknown as RouteDefinition;
    const handle = async (data: any) => data;

    const response = await FormDataHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("exceeds max size");
  });

  it("should reject files with invalid type", async () => {
    const formData = new FormData();
    formData.append("file", new File(["data"], "test.exe", { type: "application/x-executable" }));

    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });
    const def = {
      fileConstraints: { accept: ["image/*", "text/plain"] },
    } as unknown as RouteDefinition;
    const handle = async (data: any) => data;

    const response = await FormDataHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("invalid type");
  });

  it("should accept files matching wildcard type", async () => {
    const formData = new FormData();
    formData.append("file", new File(["data"], "photo.png", { type: "image/png" }));

    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });
    const def = {
      fileConstraints: { accept: ["image/*"] },
    } as unknown as RouteDefinition;
    const handle = async (data: any) => ({ fileCount: data.files.length });

    const response = await FormDataHandler.execute(req, def, handle, mockCtx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fileCount).toBe(1);
  });

  it("should return 500 for handler errors with status fallback", async () => {
    const formData = new FormData();
    formData.append("name", "test");

    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: formData,
    });
    const def = {} as unknown as RouteDefinition;
    const handle = async () => {
      throw new Error("upload failed");
    };

    const origError = console.error;
    console.error = () => {};
    try {
      const response = await FormDataHandler.execute(req, def, handle, mockCtx);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("upload failed");
    } finally {
      console.error = origError;
    }
  });
});
