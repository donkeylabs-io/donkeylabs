/**
 * Storage Plugin
 *
 * File storage with support for S3 and local filesystem.
 * Provides upload, download, URL generation, and file management.
 */

import { createPlugin, type ErrorFactory } from "@donkeylabs/server";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream, promises as fs, existsSync, mkdirSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { DB } from "./schema";

declare module "@donkeylabs/server" {
  interface ErrorFactories {
    FileNotFound: ErrorFactory;
    UploadFailed: ErrorFactory;
    DeleteFailed: ErrorFactory;
    StorageNotConfigured: ErrorFactory;
    FileTooLarge: ErrorFactory;
  }
}

export interface StorageConfig {
  provider: "s3" | "local";
  local?: {
    basePath: string;
    baseUrl: string;
  };
  s3?: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint?: string;
  };
}

export interface FileRecord {
  id: string;
  originalName: string;
  storageKey: string;
  mimeType: string;
  size: number;
  url: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface UploadOptions {
  originalName: string;
  mimeType: string;
  size: number;
  metadata?: Record<string, any>;
  folder?: string;
  isPublic?: boolean;
}

export interface ListFilesOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface ListFilesResult {
  files: FileRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface StorageService {
  upload(stream: Readable, options: UploadOptions): Promise<FileRecord>;
  getUrl(fileId: string, expiresIn?: number): Promise<string | null>;
  delete(fileId: string): Promise<boolean>;
  list(options?: ListFilesOptions): Promise<ListFilesResult>;
  getFile(fileId: string): Promise<FileRecord | null>;
  getStream(fileId: string): Promise<Readable | null>;
}

export const storagePlugin = createPlugin
  .withSchema<DB>()
  .define({
    name: "storage",
    version: "1.0.0",

    events: {
      "storage.file.uploaded": z.object({
        fileId: z.string(),
        originalName: z.string(),
        size: z.number(),
        mimeType: z.string(),
      }),
      "storage.file.deleted": z.object({
        fileId: z.string(),
        storageKey: z.string(),
      }),
      "storage.file.accessed": z.object({
        fileId: z.string(),
        action: z.string(),
      }),
    },

    customErrors: {
      FileNotFound: {
        status: 404,
        code: "FILE_NOT_FOUND",
        message: "File not found",
      },
      UploadFailed: {
        status: 500,
        code: "UPLOAD_FAILED",
        message: "Failed to upload file",
      },
      DeleteFailed: {
        status: 500,
        code: "DELETE_FAILED",
        message: "Failed to delete file",
      },
      StorageNotConfigured: {
        status: 500,
        code: "STORAGE_NOT_CONFIGURED",
        message: "Storage provider not configured",
      },
      FileTooLarge: {
        status: 413,
        code: "FILE_TOO_LARGE",
        message: "File size exceeds limit",
      },
    },

    service: async (ctx) => {
      const db = ctx.db;
      const logger = ctx.core.logger.child({ plugin: "storage" });
      const config: StorageConfig = ctx.config.plugins?.storage || {
        provider: (process.env.STORAGE_PROVIDER as "s3" | "local") || "local",
        local: {
          basePath: process.env.STORAGE_LOCAL_PATH || "./uploads",
          baseUrl: process.env.STORAGE_LOCAL_URL || "/uploads",
        },
        s3: {
          bucket: process.env.S3_BUCKET || "",
          region: process.env.AWS_REGION || "us-east-1",
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
          endpoint: process.env.S3_ENDPOINT,
        },
      };

      let s3Client: S3Client | null = null;
      const maxFileSize = config.maxFileSize || 100 * 1024 * 1024; // 100MB default

      function getS3Client(): S3Client {
        if (!s3Client) {
          s3Client = new S3Client({
            region: config.s3?.region || "us-east-1",
            credentials: {
              accessKeyId: config.s3?.accessKeyId || "",
              secretAccessKey: config.s3?.secretAccessKey || "",
            },
            endpoint: config.s3?.endpoint,
          });
        }
        return s3Client;
      }

      function generateFileId(): string {
        return `file_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      }

      function generateStorageKey(originalName: string, folder?: string): string {
        const ext = extname(originalName);
        const timestamp = Date.now();
        const random = randomBytes(8).toString("hex");
        const key = `${timestamp}_${random}${ext}`;
        return folder ? `${folder}/${key}` : key;
      }

      function getLocalPath(storageKey: string): string {
        const basePath = config.local?.basePath || "./uploads";
        return join(basePath, storageKey);
      }

      async function ensureLocalDirectory(storageKey: string): Promise<void> {
        const fullPath = getLocalPath(storageKey);
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      function mapFileRecord(row: any): FileRecord {
        return {
          id: row.id,
          originalName: row.original_name,
          storageKey: row.storage_key,
          mimeType: row.mime_type,
          size: Number(row.size),
          url: row.url,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
        };
      }

      return {
        async upload(stream: Readable, options: UploadOptions): Promise<FileRecord> {
          if (options.size > maxFileSize) {
            throw ctx.core.errors.FileTooLarge();
          }

          const fileId = generateFileId();
          const storageKey = generateStorageKey(options.originalName, options.folder);
          const now = new Date().toISOString();

          try {
            if (config.provider === "s3") {
              // S3 Upload
              const s3 = getS3Client();
              const bucket = config.s3?.bucket;

              if (!bucket) {
                throw ctx.core.errors.StorageNotConfigured();
              }

              const chunks: Buffer[] = [];
              for await (const chunk of stream) {
                chunks.push(Buffer.from(chunk));
              }
              const buffer = Buffer.concat(chunks);

              await s3.send(
                new PutObjectCommand({
                  Bucket: bucket,
                  Key: storageKey,
                  Body: buffer,
                  ContentType: options.mimeType,
                  Metadata: options.metadata,
                })
              );
            } else {
              // Local Upload
              await ensureLocalDirectory(storageKey);
              const filePath = getLocalPath(storageKey);
              const writeStream = createWriteStream(filePath);
              await pipeline(stream, writeStream);
            }

            // Generate URL
            let url: string;
            if (config.provider === "s3") {
              if (options.isPublic) {
                url = config.s3?.endpoint
                  ? `${config.s3.endpoint}/${config.s3.bucket}/${storageKey}`
                  : `https://${config.s3?.bucket}.s3.${config.s3?.region}.amazonaws.com/${storageKey}`;
              } else {
                // Will need signed URL
                url = `s3://${config.s3?.bucket}/${storageKey}`;
              }
            } else {
              const baseUrl = config.local?.baseUrl || "/uploads";
              url = `${baseUrl}/${storageKey}`;
            }

            // Save to database
            const result = await db
              .insertInto("files")
              .values({
                id: fileId,
                original_name: options.originalName,
                storage_key: storageKey,
                mime_type: options.mimeType,
                size: options.size,
                url,
                metadata: options.metadata ? JSON.stringify(options.metadata) : null,
                provider: config.provider,
                is_public: options.isPublic ? 1 : 0,
                created_at: now,
                updated_at: now,
                deleted_at: null,
              })
              .returningAll()
              .executeTakeFirstOrThrow();

            ctx.core.events.emit("storage.file.uploaded", {
              fileId: result.id,
              originalName: result.original_name,
              size: Number(result.size),
              mimeType: result.mime_type,
            });

            logger.info({ fileId: result.id, size: options.size, provider: config.provider }, "File uploaded");

            return mapFileRecord(result);
          } catch (error) {
            logger.error({ error, fileId }, "File upload failed");
            throw ctx.core.errors.UploadFailed();
          }
        },

        async getUrl(fileId: string, expiresIn: number = 3600): Promise<string | null> {
          const file = await db
            .selectFrom("files")
            .selectAll()
            .where("id", "=", fileId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          if (!file) {
            return null;
          }

          if (config.provider === "s3" && !file.is_public) {
            // Generate signed URL for private S3 files
            const s3 = getS3Client();
            const command = new GetObjectCommand({
              Bucket: config.s3?.bucket,
              Key: file.storage_key,
            });

            return await getSignedUrl(s3, command, { expiresIn });
          }

          ctx.core.events.emit("storage.file.accessed", {
            fileId,
            action: "getUrl",
          });

          return file.url;
        },

        async delete(fileId: string): Promise<boolean> {
          const file = await db
            .selectFrom("files")
            .selectAll()
            .where("id", "=", fileId)
            .executeTakeFirst();

          if (!file) {
            return false;
          }

          try {
            if (config.provider === "s3") {
              const s3 = getS3Client();
              await s3.send(
                new DeleteObjectCommand({
                  Bucket: config.s3?.bucket,
                  Key: file.storage_key,
                })
              );
            } else {
              const filePath = getLocalPath(file.storage_key);
              if (existsSync(filePath)) {
                await fs.unlink(filePath);
              }
            }

            // Soft delete in database
            await db
              .updateTable("files")
              .set({
                deleted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .where("id", "=", fileId)
              .execute();

            ctx.core.events.emit("storage.file.deleted", {
              fileId,
              storageKey: file.storage_key,
            });

            logger.info({ fileId, storageKey: file.storage_key }, "File deleted");

            return true;
          } catch (error) {
            logger.error({ error, fileId }, "File delete failed");
            throw ctx.core.errors.DeleteFailed();
          }
        },

        async list(options: ListFilesOptions = {}): Promise<ListFilesResult> {
          let query = db
            .selectFrom("files")
            .selectAll()
            .where("deleted_at", "is", null);

          if (options.prefix) {
            query = query.where("storage_key", "like", `${options.prefix}%`);
          }

          const limit = options.limit || 50;

          if (options.cursor) {
            query = query.where("id", ">", options.cursor);
          }

          const files = await query
            .orderBy("created_at", "desc")
            .limit(limit + 1)
            .execute();

          const hasMore = files.length > limit;
          const results = hasMore ? files.slice(0, limit) : files;

          return {
            files: results.map(mapFileRecord),
            nextCursor: hasMore ? results[results.length - 1]?.id : undefined,
            hasMore,
          };
        },

        async getFile(fileId: string): Promise<FileRecord | null> {
          const file = await db
            .selectFrom("files")
            .selectAll()
            .where("id", "=", fileId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          return file ? mapFileRecord(file) : null;
        },

        async getStream(fileId: string): Promise<Readable | null> {
          const file = await db
            .selectFrom("files")
            .selectAll()
            .where("id", "=", fileId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          if (!file) {
            return null;
          }

          try {
            if (config.provider === "s3") {
              const s3 = getS3Client();
              const response = await s3.send(
                new GetObjectCommand({
                  Bucket: config.s3?.bucket,
                  Key: file.storage_key,
                })
              );
              return response.Body as Readable;
            } else {
              const filePath = getLocalPath(file.storage_key);
              if (!existsSync(filePath)) {
                return null;
              }
              return createReadStream(filePath);
            }
          } catch (error) {
            logger.error({ error, fileId }, "Failed to get file stream");
            return null;
          }
        },
      };
    },
  });

export type { DB } from "./schema";
