import { describe, it, expect } from "bun:test";
import { createRouter } from "../src/router";
import { FormDataHandler } from "../src/handlers";
import { z } from "zod";

/**
 * FormData Handler Tests
 *
 * Tests for the formData handler which handles file uploads
 * with validated form fields and file constraints.
 */

describe("FormData Handler", () => {
  describe("router integration", () => {
    it("should register formData routes with handler='formData'", () => {
      const router = createRouter("api")
        .route("files.upload").formData({
          input: z.object({ folder: z.string() }),
          output: z.object({ count: z.number() }),
          handle: async ({ fields, files }) => ({ count: files.length }),
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].name).toBe("api.files.upload");
      expect(routes[0].handler).toBe("formData");
      expect(routes[0].input).toBeDefined();
      expect(routes[0].output).toBeDefined();
    });

    it("should support file constraints", () => {
      const router = createRouter("api")
        .route("images.upload").formData({
          input: z.object({ albumId: z.string() }),
          files: { maxSize: 10 * 1024 * 1024, accept: ["image/*"] },
          handle: async ({ fields, files }) => ({ uploaded: true }),
        });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(1);
      expect(routes[0].fileConstraints).toBeDefined();
      expect(routes[0].fileConstraints.maxSize).toBe(10 * 1024 * 1024);
      expect(routes[0].fileConstraints.accept).toContain("image/*");
    });
  });

  describe("FormDataHandler.execute", () => {
    const mockCtx = {} as any;

    // Helper to create a multipart form request
    const createFormRequest = (fields: Record<string, string>, files: { name: string; content: string; type: string }[] = []) => {
      const formData = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        formData.append(key, value);
      }
      for (const file of files) {
        formData.append("file", new File([file.content], file.name, { type: file.type }));
      }
      return new Request("http://localhost/test", {
        method: "POST",
        body: formData,
      });
    };

    it("should reject non-POST requests", async () => {
      const req = new Request("http://localhost/test", { method: "GET" });
      const def = {};
      const handle = async () => ({});

      const response = await FormDataHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(405);
    });

    it("should reject non-multipart requests", async () => {
      const req = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ test: true }),
        headers: { "Content-Type": "application/json" },
      });
      const def = {};
      const handle = async () => ({});

      const response = await FormDataHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("multipart/form-data");
    });

    it("should parse form fields and files", async () => {
      let receivedData: any;
      const req = createFormRequest(
        { folder: "uploads", description: "Test files" },
        [
          { name: "test.txt", content: "Hello", type: "text/plain" },
          { name: "test2.txt", content: "World", type: "text/plain" },
        ]
      );
      const def = {};
      const handle = async (data: any) => {
        receivedData = data;
        return { success: true };
      };

      await FormDataHandler.execute(req, def as any, handle, mockCtx);

      expect(receivedData.fields.folder).toBe("uploads");
      expect(receivedData.fields.description).toBe("Test files");
      expect(receivedData.files).toHaveLength(2);
      expect(receivedData.files[0].name).toBe("test.txt");
    });

    it("should validate fields with Zod schema", async () => {
      const req = createFormRequest({ wrong: "field" });
      const def = { input: z.object({ folder: z.string() }) };
      const handle = async () => ({});

      const response = await FormDataHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation Failed");
    });

    it("should enforce max file size constraint", async () => {
      const largeContent = "x".repeat(1000);
      const req = createFormRequest(
        {},
        [{ name: "large.txt", content: largeContent, type: "text/plain" }]
      );
      const def = {
        fileConstraints: { maxSize: 100 }, // 100 bytes
      };
      const handle = async () => ({});

      const response = await FormDataHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("exceeds max size");
    });

    it("should enforce file type constraint", async () => {
      const req = createFormRequest(
        {},
        [{ name: "test.txt", content: "Hello", type: "text/plain" }]
      );
      const def = {
        fileConstraints: { accept: ["image/*", "application/pdf"] },
      };
      const handle = async () => ({});

      const response = await FormDataHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("invalid type");
    });

    it("should accept files matching wildcard types", async () => {
      const req = createFormRequest(
        {},
        [{ name: "test.png", content: "PNG", type: "image/png" }]
      );
      const def = {
        fileConstraints: { accept: ["image/*"] },
      };
      const handle = async () => ({ uploaded: true });

      const response = await FormDataHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(200);
    });

    it("should validate output with Zod schema", async () => {
      const req = createFormRequest({ folder: "test" });
      const def = {
        input: z.object({ folder: z.string() }),
        output: z.object({ count: z.number() }),
      };
      const handle = async () => ({ count: "invalid" }); // Wrong type

      const response = await FormDataHandler.execute(req, def as any, handle, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation Failed");
    });

    it("should parse JSON values in form fields", async () => {
      let receivedFields: any;
      const req = createFormRequest({
        count: "5",
        tags: '["a", "b", "c"]',
        active: "true",
      });
      const def = {
        input: z.object({
          count: z.number(),
          tags: z.array(z.string()),
          active: z.boolean(),
        }),
      };
      const handle = async (data: any) => {
        receivedFields = data.fields;
        return {};
      };

      await FormDataHandler.execute(req, def as any, handle, mockCtx);

      expect(receivedFields.count).toBe(5);
      expect(receivedFields.tags).toEqual(["a", "b", "c"]);
      expect(receivedFields.active).toBe(true);
    });
  });

  describe("getMetadata", () => {
    it("should include formData handler type in metadata", () => {
      const router = createRouter("api")
        .route("upload").formData({
          input: z.object({ name: z.string() }),
          output: z.object({ id: z.string() }),
          handle: async () => ({ id: "123" }),
        });

      const metadata = router.getMetadata();

      expect(metadata).toHaveLength(1);
      expect(metadata[0].name).toBe("api.upload");
      expect(metadata[0].handler).toBe("formData");
    });
  });
});
