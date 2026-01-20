/**
 * Images Plugin Unit Tests
 *
 * Tests for the images plugin service methods with mocked S3
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Database } from "bun:sqlite";
import { PluginManager, type CoreServices } from "@donkeylabs/server";
import type { Plugin } from "@donkeylabs/server";
import {
  createLogger,
  createCache,
  createEvents,
  createCron,
  createJobs,
  createSSE,
  createRateLimiter,
  createErrors,
} from "@donkeylabs/server/core";

// Mock S3 Client interface
interface MockS3File {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  exists(): Promise<boolean>;
}

interface MockS3Client {
  file(path: string): MockS3File;
  write(path: string, data: Buffer | string, options?: any): Promise<number>;
  presign(path: string, options?: { expiresIn?: number; method?: string; type?: string }): string;
  delete(path: string): Promise<void>;
  _setFile(path: string, data: Buffer): void;
  _getFile(path: string): Buffer | undefined;
  _hasFile(path: string): boolean;
  _clear(): void;
}

// Create Mock S3 Client
function createMockS3Client(): MockS3Client {
  const files = new Map<string, Buffer>();

  return {
    file(path: string): MockS3File {
      const data = files.get(path);
      return {
        name: path,
        async arrayBuffer(): Promise<ArrayBuffer> {
          if (!data) {
            throw new Error("File not found");
          }
          return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        },
        async exists(): Promise<boolean> {
          return data !== undefined;
        },
      };
    },

    async write(path: string, data: Buffer | string): Promise<number> {
      const buffer = typeof data === "string" ? Buffer.from(data) : data;
      files.set(path, buffer);
      return buffer.length;
    },

    presign(path: string, options?: { expiresIn?: number }): string {
      return `https://mock-s3.example.com/${path}?expires=${options?.expiresIn || 3600}`;
    },

    async delete(path: string): Promise<void> {
      files.delete(path);
    },

    _setFile(path: string, data: Buffer): void {
      files.set(path, data);
    },

    _getFile(path: string): Buffer | undefined {
      return files.get(path);
    },

    _hasFile(path: string): boolean {
      return files.has(path);
    },

    _clear(): void {
      files.clear();
    },
  };
}

// Helper to create test core services
function createTestCoreServices(db: Kysely<any>): CoreServices {
  const logger = createLogger({ level: "error" });
  const cache = createCache();
  const events = createEvents();
  const cron = createCron();
  const jobs = createJobs({ events });
  const sse = createSSE();
  const rateLimiter = createRateLimiter();
  const errors = createErrors();

  return {
    db,
    config: { env: "test" },
    logger,
    cache,
    events,
    cron,
    jobs,
    sse,
    rateLimiter,
    errors,
  };
}

// Helper to create test database with images table
async function createTestDatabase(): Promise<Kysely<any>> {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({
      database: new Database(":memory:"),
    }),
  });

  // Create images table
  await db.schema
    .createTable("images")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("filename", "text", (col) => col.notNull())
    .addColumn("original_filename", "text", (col) => col.notNull())
    .addColumn("mime_type", "text", (col) => col.notNull())
    .addColumn("size", "integer", (col) => col.notNull())
    .addColumn("s3_key", "text", (col) => col.notNull().unique())
    .addColumn("s3_bucket", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("processing_stage", "text")
    .addColumn("processing_progress", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error", "text")
    .addColumn("width", "integer")
    .addColumn("height", "integer")
    .addColumn("format", "text")
    .addColumn("metadata", "text")
    .addColumn("variants", "text")
    .addColumn("watermark_config", "text")
    .addColumn("upload_id", "text")
    .addColumn("user_id", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .addColumn("completed_at", "text")
    .addColumn("deleted_at", "text")
    .execute();

  return db;
}

// Test plugin that mimics images plugin but uses injected mock S3
function createMockImagesPlugin(mockS3: MockS3Client): Plugin {
  return {
    name: "images",
    version: "1.0.0",
    dependencies: [],
    _boundConfig: {
      s3: {
        bucket: "test-bucket",
        region: "us-east-1",
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
      },
      processing: {
        maxFileSize: 10 * 1024 * 1024,
        allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        defaultQuality: 80,
      },
    },
    service: async (ctx: any) => {
      const config = ctx.config;
      const db = ctx.db;

      function generateId(): string {
        return `img_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      }

      function generateS3Key(imageId: string, filename: string, variant?: string): string {
        const ext = filename.split(".").pop() || "jpg";
        const base = `images/${imageId}`;
        return variant ? `${base}/${variant}.${ext}` : `${base}/original.${ext}`;
      }

      return {
        async initUpload(params: {
          filename: string;
          mimeType: string;
          size: number;
          userId?: string;
        }) {
          const { filename, mimeType, size, userId } = params;

          if (!config.processing.allowedMimeTypes.includes(mimeType)) {
            throw ctx.core.errors.BadRequest(
              `Invalid file type. Allowed: ${config.processing.allowedMimeTypes.join(", ")}`
            );
          }

          if (size > config.processing.maxFileSize) {
            throw ctx.core.errors.BadRequest(
              `File too large. Maximum: ${Math.round(config.processing.maxFileSize / 1024 / 1024)}MB`
            );
          }

          const imageId = generateId();
          const s3Key = generateS3Key(imageId, filename);

          await db
            .insertInto("images")
            .values({
              id: imageId,
              filename: s3Key.split("/").pop()!,
              original_filename: filename,
              mime_type: mimeType,
              size,
              s3_key: s3Key,
              s3_bucket: config.s3.bucket,
              status: "pending",
              processing_progress: 0,
              user_id: userId || null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .execute();

          const uploadUrl = mockS3.presign(s3Key, {
            expiresIn: 3600,
            method: "PUT",
            type: mimeType,
          });

          return {
            imageId,
            uploadUrl,
            method: "PUT" as const,
            expiresIn: 3600,
          };
        },

        async get(imageId: string) {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          if (!image) return null;

          return {
            id: image.id,
            filename: image.filename,
            originalFilename: image.original_filename,
            mimeType: image.mime_type,
            size: image.size,
            s3Key: image.s3_key,
            s3Bucket: image.s3_bucket,
            status: image.status,
            processingStage: image.processing_stage,
            processingProgress: image.processing_progress,
            error: image.error,
            width: image.width,
            height: image.height,
            format: image.format,
            metadata: image.metadata,
            variants: image.variants,
            watermarkConfig: image.watermark_config,
            uploadId: image.upload_id,
            userId: image.user_id,
            createdAt: image.created_at,
            updatedAt: image.updated_at,
            completedAt: image.completed_at,
            deletedAt: image.deleted_at,
          };
        },

        async list(params?: {
          page?: number;
          limit?: number;
          status?: string;
          userId?: string;
        }) {
          const page = params?.page || 1;
          const limit = params?.limit || 20;
          const offset = (page - 1) * limit;

          let query = db
            .selectFrom("images")
            .selectAll()
            .where("deleted_at", "is", null);

          if (params?.status) {
            query = query.where("status", "=", params.status);
          }

          if (params?.userId) {
            query = query.where("user_id", "=", params.userId);
          }

          const [images, countResult] = await Promise.all([
            query.orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
            db
              .selectFrom("images")
              .select((eb) => eb.fn.count("id").as("count"))
              .where("deleted_at", "is", null)
              .executeTakeFirst(),
          ]);

          const total = Number(countResult?.count || 0);

          return {
            images: images.map((image) => ({
              id: image.id,
              filename: image.filename,
              originalFilename: image.original_filename,
              mimeType: image.mime_type,
              size: image.size,
              s3Key: image.s3_key,
              s3Bucket: image.s3_bucket,
              status: image.status,
              processingStage: image.processing_stage,
              processingProgress: image.processing_progress,
              error: image.error,
              width: image.width,
              height: image.height,
              format: image.format,
              createdAt: image.created_at,
              updatedAt: image.updated_at,
            })),
            total,
            page,
            totalPages: Math.ceil(total / limit),
          };
        },

        async delete(imageId: string, permanent = false) {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.NotFound("Image not found");
          }

          if (permanent) {
            await mockS3.delete(image.s3_key);

            if (image.variants) {
              const variants = JSON.parse(image.variants);
              for (const variant of Object.values(variants)) {
                if ((variant as any)?.s3Key) {
                  await mockS3.delete((variant as any).s3Key);
                }
              }
            }

            await db.deleteFrom("images").where("id", "=", imageId).execute();
          } else {
            await db
              .updateTable("images")
              .set({
                status: "deleted",
                deleted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .where("id", "=", imageId)
              .execute();
          }
        },

        async getPresignedUrl(imageId: string, variant?: string, expiresIn = 3600) {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.NotFound("Image not found");
          }

          let s3Key = image.s3_key;

          if (variant && image.variants) {
            const variants = JSON.parse(image.variants);
            if (variants[variant]?.s3Key) {
              s3Key = variants[variant].s3Key;
            }
          }

          return mockS3.presign(s3Key, { expiresIn });
        },

        async retry(imageId: string) {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.NotFound("Image not found");
          }

          if (image.status !== "failed") {
            throw ctx.core.errors.BadRequest("Can only retry failed uploads");
          }

          await db
            .updateTable("images")
            .set({
              status: "pending",
              error: null,
              processing_stage: null,
              processing_progress: 0,
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", imageId)
            .execute();
        },

        async cleanup() {
          const orphanedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const failedCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

          const toDelete = await db
            .selectFrom("images")
            .select(["id"])
            .where((eb) =>
              eb.or([
                eb.and([
                  eb("status", "in", ["pending", "uploading"]),
                  eb("created_at", "<", orphanedCutoff),
                ]),
                eb.and([eb("status", "=", "failed"), eb("updated_at", "<", failedCutoff)]),
                eb.and([eb("status", "=", "deleted"), eb("deleted_at", "<", failedCutoff)]),
              ])
            )
            .execute();

          let deleted = 0;
          const errors: string[] = [];

          for (const image of toDelete) {
            try {
              await this.delete(image.id, true);
              deleted++;
            } catch (error) {
              errors.push(
                `Failed to delete ${image.id}: ${error instanceof Error ? error.message : "Unknown error"}`
              );
            }
          }

          return { deleted, errors };
        },
      };
    },
  };
}

describe("Images Plugin - initUpload", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockS3: MockS3Client;

  beforeEach(async () => {
    mockS3 = createMockS3Client();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockImagesPlugin(mockS3));
    await manager.init();
  });

  it("should initialize upload and return presigned URL", async () => {
    const images = manager.getServices().images;

    const result = await images.initUpload({
      filename: "test-image.jpg",
      mimeType: "image/jpeg",
      size: 1024 * 100, // 100KB
    });

    expect(result.imageId).toBeDefined();
    expect(result.imageId).toMatch(/^img_/);
    expect(result.uploadUrl).toContain("https://mock-s3.example.com/");
    expect(result.method).toBe("PUT");
    expect(result.expiresIn).toBe(3600);
  });

  it("should create database record on initUpload", async () => {
    const images = manager.getServices().images;

    const result = await images.initUpload({
      filename: "test-image.png",
      mimeType: "image/png",
      size: 2048,
      userId: "user-123",
    });

    const record = await db
      .selectFrom("images")
      .selectAll()
      .where("id", "=", result.imageId)
      .executeTakeFirst();

    expect(record).toBeDefined();
    expect(record?.original_filename).toBe("test-image.png");
    expect(record?.mime_type).toBe("image/png");
    expect(record?.size).toBe(2048);
    expect(record?.user_id).toBe("user-123");
    expect(record?.status).toBe("pending");
    expect(record?.processing_progress).toBe(0);
  });

  it("should reject invalid mime type", async () => {
    const images = manager.getServices().images;

    await expect(
      images.initUpload({
        filename: "test.pdf",
        mimeType: "application/pdf",
        size: 1024,
      })
    ).rejects.toThrow("Invalid file type");
  });

  it("should reject file that is too large", async () => {
    const images = manager.getServices().images;

    await expect(
      images.initUpload({
        filename: "huge-image.jpg",
        mimeType: "image/jpeg",
        size: 20 * 1024 * 1024, // 20MB
      })
    ).rejects.toThrow("File too large");
  });
});

describe("Images Plugin - get", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockS3: MockS3Client;

  beforeEach(async () => {
    mockS3 = createMockS3Client();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockImagesPlugin(mockS3));
    await manager.init();
  });

  it("should return image by ID", async () => {
    const images = manager.getServices().images;

    const { imageId } = await images.initUpload({
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      size: 5000,
      userId: "user-456",
    });

    const result = await images.get(imageId);

    expect(result).toBeDefined();
    expect(result?.id).toBe(imageId);
    expect(result?.originalFilename).toBe("photo.jpg");
    expect(result?.mimeType).toBe("image/jpeg");
    expect(result?.userId).toBe("user-456");
  });

  it("should return null for non-existent image", async () => {
    const images = manager.getServices().images;

    const result = await images.get("non-existent-id");

    expect(result).toBeNull();
  });

  it("should not return deleted images", async () => {
    const images = manager.getServices().images;

    const { imageId } = await images.initUpload({
      filename: "deleted.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    await images.delete(imageId);

    const result = await images.get(imageId);
    expect(result).toBeNull();
  });
});

describe("Images Plugin - list", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockS3: MockS3Client;

  beforeEach(async () => {
    mockS3 = createMockS3Client();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockImagesPlugin(mockS3));
    await manager.init();
  });

  it("should list all images with pagination", async () => {
    const images = manager.getServices().images;

    // Create multiple images
    for (let i = 0; i < 5; i++) {
      await images.initUpload({
        filename: `image-${i}.jpg`,
        mimeType: "image/jpeg",
        size: 1000 + i,
      });
    }

    const result = await images.list({ page: 1, limit: 3 });

    expect(result.images).toHaveLength(3);
    expect(result.total).toBe(5);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(2);
  });

  it("should filter by status", async () => {
    const images = manager.getServices().images;

    await images.initUpload({
      filename: "pending.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    // Manually update one to completed
    await db
      .updateTable("images")
      .set({ status: "completed" })
      .where("original_filename", "=", "pending.jpg")
      .execute();

    await images.initUpload({
      filename: "pending2.jpg",
      mimeType: "image/jpeg",
      size: 2000,
    });

    const pendingOnly = await images.list({ status: "pending" });
    expect(pendingOnly.images).toHaveLength(1);
    expect(pendingOnly.images[0].originalFilename).toBe("pending2.jpg");

    const completedOnly = await images.list({ status: "completed" });
    expect(completedOnly.images).toHaveLength(1);
    expect(completedOnly.images[0].originalFilename).toBe("pending.jpg");
  });

  it("should filter by userId", async () => {
    const images = manager.getServices().images;

    await images.initUpload({
      filename: "user1.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      userId: "user-1",
    });

    await images.initUpload({
      filename: "user2.jpg",
      mimeType: "image/jpeg",
      size: 2000,
      userId: "user-2",
    });

    const user1Images = await images.list({ userId: "user-1" });
    expect(user1Images.images).toHaveLength(1);
    expect(user1Images.images[0].originalFilename).toBe("user1.jpg");
  });
});

describe("Images Plugin - delete", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockS3: MockS3Client;

  beforeEach(async () => {
    mockS3 = createMockS3Client();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockImagesPlugin(mockS3));
    await manager.init();
  });

  it("should soft delete image by default", async () => {
    const images = manager.getServices().images;

    const { imageId } = await images.initUpload({
      filename: "to-delete.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    await images.delete(imageId);

    // Record should still exist in DB but with deleted status
    const record = await db
      .selectFrom("images")
      .selectAll()
      .where("id", "=", imageId)
      .executeTakeFirst();

    expect(record).toBeDefined();
    expect(record?.status).toBe("deleted");
    expect(record?.deleted_at).toBeDefined();
  });

  it("should permanently delete image when permanent=true", async () => {
    const images = manager.getServices().images;

    const { imageId } = await images.initUpload({
      filename: "permanent-delete.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    await images.delete(imageId, true);

    const record = await db
      .selectFrom("images")
      .selectAll()
      .where("id", "=", imageId)
      .executeTakeFirst();

    expect(record).toBeUndefined();
  });

  it("should throw error for non-existent image", async () => {
    const images = manager.getServices().images;

    await expect(images.delete("non-existent")).rejects.toThrow("Image not found");
  });
});

describe("Images Plugin - getPresignedUrl", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockS3: MockS3Client;

  beforeEach(async () => {
    mockS3 = createMockS3Client();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockImagesPlugin(mockS3));
    await manager.init();
  });

  it("should return presigned URL for image", async () => {
    const images = manager.getServices().images;

    const { imageId } = await images.initUpload({
      filename: "view-me.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    const url = await images.getPresignedUrl(imageId);

    expect(url).toContain("https://mock-s3.example.com/");
    expect(url).toContain("images/");
  });

  it("should throw error for non-existent image", async () => {
    const images = manager.getServices().images;

    await expect(images.getPresignedUrl("non-existent")).rejects.toThrow("Image not found");
  });
});

describe("Images Plugin - retry", () => {
  let manager: PluginManager;
  let db: Kysely<any>;
  let mockS3: MockS3Client;

  beforeEach(async () => {
    mockS3 = createMockS3Client();
    db = await createTestDatabase();
    const core = createTestCoreServices(db);
    manager = new PluginManager(core);
    manager.register(createMockImagesPlugin(mockS3));
    await manager.init();
  });

  it("should reset failed image to pending", async () => {
    const images = manager.getServices().images;

    const { imageId } = await images.initUpload({
      filename: "failed.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    // Manually set to failed
    await db
      .updateTable("images")
      .set({
        status: "failed",
        error: "Some error",
        processing_progress: 50,
      })
      .where("id", "=", imageId)
      .execute();

    await images.retry(imageId);

    const record = await db
      .selectFrom("images")
      .selectAll()
      .where("id", "=", imageId)
      .executeTakeFirst();

    expect(record?.status).toBe("pending");
    expect(record?.error).toBeNull();
    expect(record?.processing_progress).toBe(0);
  });

  it("should throw error when retrying non-failed image", async () => {
    const images = manager.getServices().images;

    const { imageId } = await images.initUpload({
      filename: "pending.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    await expect(images.retry(imageId)).rejects.toThrow("Can only retry failed uploads");
  });
});
