/**
 * Images Plugin Integration Tests
 *
 * Tests for complete workflows and multi-operation scenarios
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
interface MockS3Client {
  file(path: string): {
    name: string;
    arrayBuffer(): Promise<ArrayBuffer>;
    exists(): Promise<boolean>;
  };
  write(path: string, data: Buffer | string): Promise<number>;
  presign(path: string, options?: { expiresIn?: number }): string;
  delete(path: string): Promise<void>;
  _setFile(path: string, data: Buffer): void;
  _hasFile(path: string): boolean;
  _clear(): void;
}

function createMockS3Client(): MockS3Client {
  const files = new Map<string, Buffer>();

  return {
    file(path: string) {
      const data = files.get(path);
      return {
        name: path,
        async arrayBuffer() {
          if (!data) throw new Error("File not found");
          return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        },
        async exists() {
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

    _hasFile(path: string): boolean {
      return files.has(path);
    },

    _clear(): void {
      files.clear();
    },
  };
}

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

async function createTestDatabase(): Promise<Kysely<any>> {
  const db = new Kysely<any>({
    dialect: new BunSqliteDialect({
      database: new Database(":memory:"),
    }),
  });

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
      cleanup: {
        orphanedAfterHours: 24,
        failedRetentionDays: 7,
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
            throw ctx.core.errors.BadRequest("Invalid file type");
          }

          if (size > config.processing.maxFileSize) {
            throw ctx.core.errors.BadRequest("File too large");
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
            userId: image.user_id,
            createdAt: image.created_at,
          };
        },

        async list(params?: { page?: number; limit?: number; status?: string; userId?: string }) {
          const page = params?.page || 1;
          const limit = params?.limit || 20;
          const offset = (page - 1) * limit;

          let query = db.selectFrom("images").selectAll().where("deleted_at", "is", null);

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

          return {
            images: images.map((img) => ({
              id: img.id,
              filename: img.filename,
              originalFilename: img.original_filename,
              status: img.status,
              userId: img.user_id,
            })),
            total: Number(countResult?.count || 0),
            page,
            totalPages: Math.ceil(Number(countResult?.count || 0) / limit),
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

        async markCompleted(imageId: string) {
          await db
            .updateTable("images")
            .set({
              status: "completed",
              processing_progress: 100,
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", imageId)
            .execute();
        },

        async markFailed(imageId: string, error: string) {
          await db
            .updateTable("images")
            .set({
              status: "failed",
              error,
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", imageId)
            .execute();
        },

        async cleanup() {
          const orphanedCutoff = new Date(
            Date.now() - config.cleanup.orphanedAfterHours * 60 * 60 * 1000
          ).toISOString();
          const failedCutoff = new Date(
            Date.now() - config.cleanup.failedRetentionDays * 24 * 60 * 60 * 1000
          ).toISOString();

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
              errors.push(`Failed to delete ${image.id}`);
            }
          }

          return { deleted, errors };
        },
      };
    },
  };
}

describe("Images Plugin Integration - Upload Flow", () => {
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

  it("should complete full upload lifecycle", async () => {
    const images = manager.getServices().images;

    // Step 1: Initialize upload
    const { imageId, uploadUrl } = await images.initUpload({
      filename: "profile.jpg",
      mimeType: "image/jpeg",
      size: 5000,
      userId: "user-123",
    });

    expect(imageId).toBeDefined();
    expect(uploadUrl).toContain("https://");

    // Step 2: Verify pending state
    let image = await images.get(imageId);
    expect(image?.status).toBe("pending");

    // Step 3: Simulate S3 upload completion (in real scenario, client uploads to presigned URL)
    mockS3._setFile(`images/${imageId}/original.jpg`, Buffer.from("fake image data"));

    // Step 4: Mark as completed (simulating processing completion)
    await images.markCompleted(imageId);

    // Step 5: Verify completed state
    image = await images.get(imageId);
    expect(image?.status).toBe("completed");
  });

  it("should handle failed upload and recovery", async () => {
    const images = manager.getServices().images;

    // Initialize upload
    const { imageId } = await images.initUpload({
      filename: "broken.png",
      mimeType: "image/png",
      size: 2000,
    });

    // Mark as failed
    await images.markFailed(imageId, "Processing timeout");

    let image = await images.get(imageId);
    expect(image?.status).toBe("failed");

    // Manual retry would reset status
    await db
      .updateTable("images")
      .set({
        status: "pending",
        error: null,
        processing_progress: 0,
      })
      .where("id", "=", imageId)
      .execute();

    image = await images.get(imageId);
    expect(image?.status).toBe("pending");
  });
});

describe("Images Plugin Integration - Multi-User Scenarios", () => {
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

  it("should handle multiple users uploading simultaneously", async () => {
    const images = manager.getServices().images;

    // Create uploads for multiple users
    const uploads = await Promise.all([
      images.initUpload({
        filename: "user1-photo.jpg",
        mimeType: "image/jpeg",
        size: 1000,
        userId: "user-1",
      }),
      images.initUpload({
        filename: "user2-photo.jpg",
        mimeType: "image/jpeg",
        size: 2000,
        userId: "user-2",
      }),
      images.initUpload({
        filename: "user1-banner.png",
        mimeType: "image/png",
        size: 3000,
        userId: "user-1",
      }),
    ]);

    expect(uploads).toHaveLength(3);

    // List images for each user
    const user1Images = await images.list({ userId: "user-1" });
    expect(user1Images.images).toHaveLength(2);

    const user2Images = await images.list({ userId: "user-2" });
    expect(user2Images.images).toHaveLength(1);
  });

  it("should isolate user deletions", async () => {
    const images = manager.getServices().images;

    const { imageId: user1Image } = await images.initUpload({
      filename: "delete-me.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      userId: "user-1",
    });

    const { imageId: user2Image } = await images.initUpload({
      filename: "keep-me.jpg",
      mimeType: "image/jpeg",
      size: 1000,
      userId: "user-2",
    });

    // Delete user1's image
    await images.delete(user1Image);

    // User1's image should be gone
    const user1Result = await images.get(user1Image);
    expect(user1Result).toBeNull();

    // User2's image should still exist
    const user2Result = await images.get(user2Image);
    expect(user2Result).toBeDefined();
    expect(user2Result?.status).toBe("pending");
  });
});

describe("Images Plugin Integration - Cleanup Operations", () => {
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

  it("should clean up orphaned uploads", async () => {
    const images = manager.getServices().images;

    // Create an old orphaned upload (simulating by setting old created_at)
    const { imageId } = await images.initUpload({
      filename: "orphan.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    // Manually set created_at to 48 hours ago (past the 24h threshold)
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await db
      .updateTable("images")
      .set({ created_at: oldDate })
      .where("id", "=", imageId)
      .execute();

    // Create a recent upload that should NOT be cleaned
    const { imageId: recentId } = await images.initUpload({
      filename: "recent.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    // Run cleanup
    const result = await images.cleanup();

    expect(result.deleted).toBe(1);

    // Old orphan should be gone
    const orphan = await db
      .selectFrom("images")
      .selectAll()
      .where("id", "=", imageId)
      .executeTakeFirst();
    expect(orphan).toBeUndefined();

    // Recent should still exist
    const recent = await images.get(recentId);
    expect(recent).toBeDefined();
  });

  it("should clean up old failed uploads", async () => {
    const images = manager.getServices().images;

    // Create a failed upload
    const { imageId } = await images.initUpload({
      filename: "failed.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    // Set to failed with old timestamp
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    await db
      .updateTable("images")
      .set({
        status: "failed",
        error: "Test failure",
        updated_at: oldDate,
      })
      .where("id", "=", imageId)
      .execute();

    const result = await images.cleanup();

    expect(result.deleted).toBe(1);
  });

  it("should clean up soft-deleted images after retention period", async () => {
    const images = manager.getServices().images;

    const { imageId } = await images.initUpload({
      filename: "soft-deleted.jpg",
      mimeType: "image/jpeg",
      size: 1000,
    });

    // Soft delete
    await images.delete(imageId);

    // Set deleted_at to 10 days ago
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await db
      .updateTable("images")
      .set({ deleted_at: oldDate })
      .where("id", "=", imageId)
      .execute();

    const result = await images.cleanup();

    expect(result.deleted).toBe(1);

    // Should be permanently gone
    const record = await db
      .selectFrom("images")
      .selectAll()
      .where("id", "=", imageId)
      .executeTakeFirst();
    expect(record).toBeUndefined();
  });
});

describe("Images Plugin Integration - Pagination", () => {
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

  it("should correctly paginate through large result sets", async () => {
    const images = manager.getServices().images;

    // Create 25 images
    for (let i = 0; i < 25; i++) {
      await images.initUpload({
        filename: `image-${i.toString().padStart(2, "0")}.jpg`,
        mimeType: "image/jpeg",
        size: 1000 + i,
      });
    }

    // First page
    const page1 = await images.list({ page: 1, limit: 10 });
    expect(page1.images).toHaveLength(10);
    expect(page1.total).toBe(25);
    expect(page1.totalPages).toBe(3);

    // Second page
    const page2 = await images.list({ page: 2, limit: 10 });
    expect(page2.images).toHaveLength(10);

    // Third page
    const page3 = await images.list({ page: 3, limit: 10 });
    expect(page3.images).toHaveLength(5);

    // No overlap between pages
    const allIds = [...page1.images, ...page2.images, ...page3.images].map((img) => img.id);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(25);
  });
});
