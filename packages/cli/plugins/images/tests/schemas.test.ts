/**
 * Images Plugin Schemas Tests
 *
 * Tests for Zod schema validation in handlers
 */

import { describe, it, expect } from "bun:test";
import { imageSchemas, createSSEHandler } from "../handlers/index";

describe("imageSchemas.upload", () => {
  it("should validate valid upload input", () => {
    const input = {
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: 1024,
    };

    const result = imageSchemas.upload.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should validate upload input with userId", () => {
    const input = {
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      userId: "user-123",
    };

    const result = imageSchemas.upload.input.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userId).toBe("user-123");
    }
  });

  it("should reject missing filename", () => {
    const input = {
      mimeType: "image/jpeg",
      size: 1024,
    };

    const result = imageSchemas.upload.input.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("should reject invalid size (not a number)", () => {
    const input = {
      filename: "test.jpg",
      mimeType: "image/jpeg",
      size: "large",
    };

    const result = imageSchemas.upload.input.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("should validate output schema", () => {
    const output = {
      imageId: "img_123",
      uploadUrl: "https://s3.example.com/upload",
      method: "PUT" as const,
      expiresIn: 3600,
    };

    const result = imageSchemas.upload.output.safeParse(output);
    expect(result.success).toBe(true);
  });
});

describe("imageSchemas.process", () => {
  it("should validate minimal input", () => {
    const input = {
      imageId: "img_123",
    };

    const result = imageSchemas.process.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should validate full input with options", () => {
    const input = {
      imageId: "img_123",
      skipVariants: true,
      skipWatermark: false,
      quality: 85,
      format: "webp" as const,
    };

    const result = imageSchemas.process.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should reject invalid quality (out of range)", () => {
    const input = {
      imageId: "img_123",
      quality: 150,
    };

    const result = imageSchemas.process.input.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("should reject invalid format", () => {
    const input = {
      imageId: "img_123",
      format: "bmp",
    };

    const result = imageSchemas.process.input.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("imageSchemas.createVariants", () => {
  it("should validate minimal input", () => {
    const input = {
      imageId: "img_123",
    };

    const result = imageSchemas.createVariants.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should validate custom variants", () => {
    const input = {
      imageId: "img_123",
      variants: {
        small: { width: 100, height: 100, fit: "cover" as const },
        large: { width: 1920, height: 1080, quality: 90 },
      },
    };

    const result = imageSchemas.createVariants.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should reject variant without required dimensions", () => {
    const input = {
      imageId: "img_123",
      variants: {
        broken: { fit: "cover" },
      },
    };

    const result = imageSchemas.createVariants.input.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("imageSchemas.applyWatermark", () => {
  it("should validate minimal input", () => {
    const input = {
      imageId: "img_123",
    };

    const result = imageSchemas.applyWatermark.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should validate full watermark config", () => {
    const input = {
      imageId: "img_123",
      logoS3Key: "watermarks/logo.png",
      position: "bottom-right" as const,
      opacity: 0.7,
      scale: 0.15,
    };

    const result = imageSchemas.applyWatermark.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should reject invalid position", () => {
    const input = {
      imageId: "img_123",
      position: "middle",
    };

    const result = imageSchemas.applyWatermark.input.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("should reject opacity out of range", () => {
    const input = {
      imageId: "img_123",
      opacity: 1.5,
    };

    const result = imageSchemas.applyWatermark.input.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("imageSchemas.get", () => {
  it("should validate input", () => {
    const input = {
      imageId: "img_123",
    };

    const result = imageSchemas.get.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should reject missing imageId", () => {
    const input = {};

    const result = imageSchemas.get.input.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("imageSchemas.list", () => {
  it("should validate empty input (defaults)", () => {
    const input = {};

    const result = imageSchemas.list.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should validate full pagination input", () => {
    const input = {
      page: 2,
      limit: 50,
      status: "completed" as const,
      userId: "user-456",
    };

    const result = imageSchemas.list.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should reject invalid page number", () => {
    const input = {
      page: 0,
    };

    const result = imageSchemas.list.input.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("should reject limit over 100", () => {
    const input = {
      limit: 150,
    };

    const result = imageSchemas.list.input.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("should reject invalid status", () => {
    const input = {
      status: "unknown",
    };

    const result = imageSchemas.list.input.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("imageSchemas.delete", () => {
  it("should validate minimal input", () => {
    const input = {
      imageId: "img_123",
    };

    const result = imageSchemas.delete.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should validate with permanent flag", () => {
    const input = {
      imageId: "img_123",
      permanent: true,
    };

    const result = imageSchemas.delete.input.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("imageSchemas.url", () => {
  it("should validate minimal input", () => {
    const input = {
      imageId: "img_123",
    };

    const result = imageSchemas.url.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should validate full input", () => {
    const input = {
      imageId: "img_123",
      variant: "thumbnail",
      expiresIn: 7200,
    };

    const result = imageSchemas.url.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should reject expiresIn under 60", () => {
    const input = {
      imageId: "img_123",
      expiresIn: 30,
    };

    const result = imageSchemas.url.input.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("should reject expiresIn over 604800 (7 days)", () => {
    const input = {
      imageId: "img_123",
      expiresIn: 1000000,
    };

    const result = imageSchemas.url.input.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("imageSchemas.retry", () => {
  it("should validate input", () => {
    const input = {
      imageId: "img_123",
    };

    const result = imageSchemas.retry.input.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("imageSchemas.cleanup", () => {
  it("should validate empty input", () => {
    const input = {};

    const result = imageSchemas.cleanup.input.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("should validate output", () => {
    const output = {
      deleted: 5,
      errors: ["Error 1", "Error 2"],
    };

    const result = imageSchemas.cleanup.output.safeParse(output);
    expect(result.success).toBe(true);
  });
});

describe("createSSEHandler", () => {
  it("should return a function", () => {
    const handler = createSSEHandler();
    expect(typeof handler).toBe("function");
  });

  it("should return 400 when imageId is missing", async () => {
    const handler = createSSEHandler();

    const mockRequest = new Request("https://example.com/subscribe");
    const mockContext = {
      core: {
        sse: {
          addClient: () => ({ client: { id: "test" }, response: new Response() }),
          subscribe: () => true,
        },
      },
    };

    const response = await handler(mockRequest, mockContext);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain("imageId");
  });

  it("should subscribe to SSE channels when imageId is provided", async () => {
    const handler = createSSEHandler();

    const subscribedChannels: string[] = [];
    const mockRequest = new Request("https://example.com/subscribe?imageId=img_123");
    const mockContext = {
      core: {
        sse: {
          addClient: () => ({
            client: { id: "client_1" },
            response: new Response("sse-stream", {
              headers: { "Content-Type": "text/event-stream" },
            }),
          }),
          subscribe: (clientId: string, channel: string) => {
            subscribedChannels.push(channel);
            return true;
          },
        },
      },
    };

    const response = await handler(mockRequest, mockContext);

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(subscribedChannels).toContain("images.img_123");
    expect(subscribedChannels).toContain("images");
  });
});
