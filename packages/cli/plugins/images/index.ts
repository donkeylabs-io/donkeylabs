/**
 * Images Plugin
 *
 * S3 image upload with Sharp processing, watermarks, and SSE progress
 */

import { createPlugin, type ErrorFactory } from "@donkeylabs/server";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "./schema";
import type {
  ImagesConfig,
  ImageRecord,
  ImageStatus,
  ProcessingStage,
  InitUploadParams,
  InitUploadResult,
  ProcessImageOptions,
  ListImagesParams,
  ListImagesResult,
  ImageVariants,
  ImageVariantInfo,
  VariantConfig,
  DEFAULT_CONFIG,
} from "./types";

const DEFAULT_PROCESSING = {
  maxFileSize: 10 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  defaultQuality: 80,
  stripExif: true,
};

const DEFAULT_VARIANTS = {
  thumbnail: { width: 150, height: 150, fit: "cover" as const },
  medium: { width: 800, height: 600, fit: "inside" as const },
};

const DEFAULT_WATERMARK = {
  enabled: false,
  position: "bottom-right" as const,
  opacity: 0.5,
  scale: 0.2,
};

const DEFAULT_CLEANUP = {
  orphanedAfterHours: 24,
  failedRetentionDays: 7,
};

declare module "@donkeylabs/server" {
  interface ErrorFactories {
    ImageNotFound: ErrorFactory;
    InvalidMimeType: ErrorFactory;
    FileTooLarge: ErrorFactory;
    ProcessingFailed: ErrorFactory;
    S3Error: ErrorFactory;
  }
}

export interface ImagesService {
  initUpload(params: InitUploadParams): Promise<InitUploadResult>;
  uploadDirect(imageId: string, file: Blob | Buffer): Promise<void>;
  processImage(imageId: string, options?: ProcessImageOptions): Promise<void>;
  createVariants(imageId: string, variants?: Record<string, VariantConfig>): Promise<void>;
  applyWatermark(imageId: string, config?: ImagesConfig["watermark"]): Promise<void>;
  get(imageId: string): Promise<ImageRecord | null>;
  list(params?: ListImagesParams): Promise<ListImagesResult>;
  delete(imageId: string, permanent?: boolean): Promise<void>;
  cleanup(): Promise<{ deleted: number; errors: string[] }>;
  retry(imageId: string): Promise<void>;
  getPresignedUrl(imageId: string, variant?: string, expiresIn?: number): Promise<string>;
}

export const imagesPlugin = createPlugin
  .withSchema<DB>()
  .withConfig<ImagesConfig>()
  .define({
    name: "images",
    version: "1.0.0",

    events: {
      "image.upload.started": z.object({
        imageId: z.string(),
        filename: z.string(),
        userId: z.string().optional(),
      }),
      "image.processing.progress": z.object({
        imageId: z.string(),
        progress: z.number(),
        stage: z.string(),
        message: z.string(),
      }),
      "image.upload.completed": z.object({
        imageId: z.string(),
        url: z.string(),
        variants: z.record(z.any()).optional(),
      }),
      "image.upload.failed": z.object({
        imageId: z.string(),
        error: z.string(),
        stage: z.string().optional(),
      }),
    },

    customErrors: {
      ImageNotFound: {
        status: 404,
        code: "IMAGE_NOT_FOUND",
        message: "Image not found",
      },
      InvalidMimeType: {
        status: 400,
        code: "INVALID_MIME_TYPE",
        message: "Invalid file type",
      },
      FileTooLarge: {
        status: 400,
        code: "FILE_TOO_LARGE",
        message: "File exceeds maximum size",
      },
      ProcessingFailed: {
        status: 500,
        code: "PROCESSING_FAILED",
        message: "Image processing failed",
      },
      S3Error: {
        status: 500,
        code: "S3_ERROR",
        message: "S3 operation failed",
      },
    },

    service: async (ctx) => {
      const config = ctx.config;
      const db = ctx.db;
      const logger = ctx.core.logger.child({ plugin: "images" });

      const processing = { ...DEFAULT_PROCESSING, ...config.processing };
      const variants = { ...DEFAULT_VARIANTS, ...config.variants };
      const watermarkConfig = { ...DEFAULT_WATERMARK, ...config.watermark };
      const cleanup = { ...DEFAULT_CLEANUP, ...config.cleanup };

      function generateId(): string {
        return `img_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      }

      function generateS3Key(imageId: string, filename: string, variant?: string): string {
        const ext = filename.split(".").pop() || "jpg";
        const base = `images/${imageId}`;
        return variant ? `${base}/${variant}.${ext}` : `${base}/original.${ext}`;
      }

      async function updateProgress(
        imageId: string,
        stage: ProcessingStage,
        progress: number,
        message: string
      ): Promise<void> {
        await db
          .updateTable("images")
          .set({
            processing_stage: stage,
            processing_progress: progress,
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", imageId)
          .execute();

        ctx.core.sse.broadcast(`images.${imageId}`, {
          type: "image.processing.progress",
          data: { imageId, progress, stage, message },
        });

        ctx.core.events.emit("image.processing.progress", {
          imageId,
          progress,
          stage,
          message,
        });
      }

      function getS3Client() {
        return new Bun.S3Client({
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
          bucket: config.s3.bucket,
          region: config.s3.region,
          ...(config.s3.endpoint && { endpoint: config.s3.endpoint }),
        });
      }

      return {
        async initUpload(params: InitUploadParams): Promise<InitUploadResult> {
          const { filename, mimeType, size, userId } = params;

          if (!processing.allowedMimeTypes!.includes(mimeType)) {
            throw ctx.core.errors.InvalidMimeType(`Allowed types: ${processing.allowedMimeTypes!.join(", ")}`);
          }

          if (size > processing.maxFileSize!) {
            throw ctx.core.errors.FileTooLarge(
              `Maximum size: ${Math.round(processing.maxFileSize! / 1024 / 1024)}MB`
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

          const s3 = getS3Client();
          const uploadUrl = s3.presign(s3Key, {
            expiresIn: 3600,
            method: "PUT",
            type: mimeType,
          });

          ctx.core.events.emit("image.upload.started", {
            imageId,
            filename,
            userId,
          });

          logger.info({ imageId, filename, userId }, "Upload initialized");

          return {
            imageId,
            uploadUrl,
            method: "PUT",
            expiresIn: 3600,
          };
        },

        async uploadDirect(imageId: string, file: Blob | Buffer): Promise<void> {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.ImageNotFound();
          }

          await db
            .updateTable("images")
            .set({ status: "uploading", updated_at: new Date().toISOString() })
            .where("id", "=", imageId)
            .execute();

          try {
            const s3 = getS3Client();
            const buffer = file instanceof Blob ? Buffer.from(await file.arrayBuffer()) : file;
            await s3.write(image.s3_key, buffer, { type: image.mime_type });

            await db
              .updateTable("images")
              .set({ status: "pending", updated_at: new Date().toISOString() })
              .where("id", "=", imageId)
              .execute();

            logger.info({ imageId }, "Direct upload completed");
          } catch (error) {
            await db
              .updateTable("images")
              .set({
                status: "failed",
                error: error instanceof Error ? error.message : "Upload failed",
                updated_at: new Date().toISOString(),
              })
              .where("id", "=", imageId)
              .execute();

            throw ctx.core.errors.S3Error(
              error instanceof Error ? error.message : "Upload failed"
            );
          }
        },

        async processImage(imageId: string, options?: ProcessImageOptions): Promise<void> {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.ImageNotFound();
          }

          try {
            await db
              .updateTable("images")
              .set({ status: "processing", updated_at: new Date().toISOString() })
              .where("id", "=", imageId)
              .execute();

            await updateProgress(imageId, "downloading", 10, "Downloading original image");

            const s3 = getS3Client();
            const originalBuffer = Buffer.from(await (await s3.file(image.s3_key)).arrayBuffer());

            await updateProgress(imageId, "validating", 20, "Validating image");

            const metadata = await sharp(originalBuffer).metadata();
            const { width, height, format } = metadata;

            await updateProgress(imageId, "optimizing", 30, "Optimizing image");

            let pipeline = sharp(originalBuffer);

            if (processing.stripExif) {
              pipeline = pipeline.rotate();
            }

            const quality = options?.quality || processing.defaultQuality || 80;
            const outputFormat = options?.format || (format as "jpeg" | "png" | "webp") || "jpeg";

            let outputBuffer: Buffer;
            switch (outputFormat) {
              case "webp":
                outputBuffer = await pipeline.webp({ quality }).toBuffer();
                break;
              case "png":
                outputBuffer = await pipeline.png({ quality }).toBuffer();
                break;
              case "avif":
                outputBuffer = await pipeline.avif({ quality }).toBuffer();
                break;
              default:
                outputBuffer = await pipeline.jpeg({ quality }).toBuffer();
            }

            await updateProgress(imageId, "uploading", 50, "Uploading optimized image");

            await s3.write(image.s3_key, outputBuffer, {
              type: `image/${outputFormat}`,
            });

            let variantsData: ImageVariants = {};

            if (!options?.skipVariants) {
              await updateProgress(imageId, "creating-variants", 60, "Creating image variants");

              for (const [variantName, variantConfig] of Object.entries(variants)) {
                if (!variantConfig) continue;

                const variantKey = generateS3Key(imageId, image.original_filename, variantName);
                const variantBuffer = await sharp(originalBuffer)
                  .resize({
                    width: variantConfig.width,
                    height: variantConfig.height,
                    fit: variantConfig.fit || "cover",
                  })
                  .jpeg({ quality: variantConfig.quality || quality })
                  .toBuffer();

                await s3.write(variantKey, variantBuffer, { type: "image/jpeg" });

                const variantMeta = await sharp(variantBuffer).metadata();
                variantsData[variantName] = {
                  s3Key: variantKey,
                  width: variantMeta.width || variantConfig.width,
                  height: variantMeta.height || variantConfig.height,
                  size: variantBuffer.length,
                  format: "jpeg",
                };
              }
            }

            if (!options?.skipWatermark && watermarkConfig.enabled && watermarkConfig.logoS3Key) {
              await updateProgress(imageId, "applying-watermark", 80, "Applying watermark");

              const logoBuffer = Buffer.from(
                await (await s3.file(watermarkConfig.logoS3Key)).arrayBuffer()
              );

              const mainImage = sharp(outputBuffer);
              const mainMeta = await mainImage.metadata();

              const logoSize = Math.min(
                mainMeta.width! * (watermarkConfig.scale || 0.2),
                mainMeta.height! * (watermarkConfig.scale || 0.2)
              );

              const logo = await sharp(logoBuffer)
                .resize(Math.round(logoSize), Math.round(logoSize), { fit: "inside" })
                .toBuffer();

              const { width: logoWidth, height: logoHeight } = await sharp(logo).metadata();

              let gravity: sharp.Gravity;
              switch (watermarkConfig.position) {
                case "top-left":
                  gravity = "northwest";
                  break;
                case "top-right":
                  gravity = "northeast";
                  break;
                case "bottom-left":
                  gravity = "southwest";
                  break;
                case "bottom-right":
                  gravity = "southeast";
                  break;
                default:
                  gravity = "center";
              }

              outputBuffer = await mainImage
                .composite([
                  {
                    input: logo,
                    gravity,
                    blend: "over",
                  },
                ])
                .toBuffer();

              await s3.write(image.s3_key, outputBuffer, {
                type: `image/${outputFormat}`,
              });
            }

            await updateProgress(imageId, "finalizing", 95, "Finalizing upload");

            const now = new Date().toISOString();
            await db
              .updateTable("images")
              .set({
                status: "completed",
                processing_stage: null,
                processing_progress: 100,
                width: width || null,
                height: height || null,
                format: outputFormat,
                variants: Object.keys(variantsData).length > 0 ? JSON.stringify(variantsData) : null,
                size: outputBuffer.length,
                completed_at: now,
                updated_at: now,
              })
              .where("id", "=", imageId)
              .execute();

            const publicUrl = config.s3.publicUrl
              ? `${config.s3.publicUrl}/${image.s3_key}`
              : s3.presign(image.s3_key, { expiresIn: 86400 });

            ctx.core.sse.broadcast(`images.${imageId}`, {
              type: "image.upload.completed",
              data: { imageId, url: publicUrl, variants: variantsData },
            });

            ctx.core.events.emit("image.upload.completed", {
              imageId,
              url: publicUrl,
              variants: variantsData,
            });

            logger.info({ imageId, width, height, format: outputFormat }, "Processing completed");
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Processing failed";

            await db
              .updateTable("images")
              .set({
                status: "failed",
                error: errorMessage,
                updated_at: new Date().toISOString(),
              })
              .where("id", "=", imageId)
              .execute();

            ctx.core.sse.broadcast(`images.${imageId}`, {
              type: "image.upload.failed",
              data: { imageId, error: errorMessage, stage: image.processing_stage },
            });

            ctx.core.events.emit("image.upload.failed", {
              imageId,
              error: errorMessage,
              stage: image.processing_stage || undefined,
            });

            logger.error({ imageId, error: errorMessage }, "Processing failed");
            throw ctx.core.errors.ProcessingFailed(errorMessage);
          }
        },

        async createVariants(
          imageId: string,
          customVariants?: Record<string, VariantConfig>
        ): Promise<void> {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.ImageNotFound();
          }

          const s3 = getS3Client();
          const originalBuffer = Buffer.from(await (await s3.file(image.s3_key)).arrayBuffer());

          const variantsToCreate = customVariants || variants;
          const existingVariants: ImageVariants = image.variants
            ? JSON.parse(image.variants)
            : {};

          for (const [variantName, variantConfig] of Object.entries(variantsToCreate)) {
            if (!variantConfig) continue;

            const variantKey = generateS3Key(imageId, image.original_filename, variantName);
            const variantBuffer = await sharp(originalBuffer)
              .resize({
                width: variantConfig.width,
                height: variantConfig.height,
                fit: variantConfig.fit || "cover",
              })
              .jpeg({ quality: variantConfig.quality || processing.defaultQuality || 80 })
              .toBuffer();

            await s3.write(variantKey, variantBuffer, { type: "image/jpeg" });

            const variantMeta = await sharp(variantBuffer).metadata();
            existingVariants[variantName] = {
              s3Key: variantKey,
              width: variantMeta.width || variantConfig.width,
              height: variantMeta.height || variantConfig.height,
              size: variantBuffer.length,
              format: "jpeg",
            };
          }

          await db
            .updateTable("images")
            .set({
              variants: JSON.stringify(existingVariants),
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", imageId)
            .execute();

          logger.info({ imageId, variants: Object.keys(variantsToCreate) }, "Variants created");
        },

        async applyWatermark(
          imageId: string,
          customConfig?: ImagesConfig["watermark"]
        ): Promise<void> {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.ImageNotFound();
          }

          const wmConfig = { ...watermarkConfig, ...customConfig };

          if (!wmConfig.logoS3Key) {
            throw ctx.core.errors.ProcessingFailed("Watermark logo S3 key not configured");
          }

          const s3 = getS3Client();
          const imageBuffer = Buffer.from(await (await s3.file(image.s3_key)).arrayBuffer());
          const logoBuffer = Buffer.from(await (await s3.file(wmConfig.logoS3Key)).arrayBuffer());

          const mainImage = sharp(imageBuffer);
          const mainMeta = await mainImage.metadata();

          const logoSize = Math.min(
            mainMeta.width! * (wmConfig.scale || 0.2),
            mainMeta.height! * (wmConfig.scale || 0.2)
          );

          const logo = await sharp(logoBuffer)
            .resize(Math.round(logoSize), Math.round(logoSize), { fit: "inside" })
            .toBuffer();

          let gravity: sharp.Gravity;
          switch (wmConfig.position) {
            case "top-left":
              gravity = "northwest";
              break;
            case "top-right":
              gravity = "northeast";
              break;
            case "bottom-left":
              gravity = "southwest";
              break;
            case "bottom-right":
              gravity = "southeast";
              break;
            default:
              gravity = "center";
          }

          const outputBuffer = await mainImage
            .composite([{ input: logo, gravity, blend: "over" }])
            .toBuffer();

          await s3.write(image.s3_key, outputBuffer, { type: image.mime_type });

          await db
            .updateTable("images")
            .set({
              watermark_config: JSON.stringify(wmConfig),
              size: outputBuffer.length,
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", imageId)
            .execute();

          logger.info({ imageId, position: wmConfig.position }, "Watermark applied");
        },

        async get(imageId: string): Promise<ImageRecord | null> {
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
            status: image.status as ImageStatus,
            processingStage: image.processing_stage as ProcessingStage | null,
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

        async list(params?: ListImagesParams): Promise<ListImagesResult> {
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
              status: image.status as ImageStatus,
              processingStage: image.processing_stage as ProcessingStage | null,
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
            })),
            total,
            page,
            totalPages: Math.ceil(total / limit),
          };
        },

        async delete(imageId: string, permanent = false): Promise<void> {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.ImageNotFound();
          }

          if (permanent) {
            const s3 = getS3Client();

            try {
              await s3.delete(image.s3_key);

              if (image.variants) {
                const variants: ImageVariants = JSON.parse(image.variants);
                for (const variant of Object.values(variants)) {
                  if (variant?.s3Key) {
                    await s3.delete(variant.s3Key);
                  }
                }
              }
            } catch (error) {
              logger.warn({ imageId, error }, "Failed to delete S3 files");
            }

            await db.deleteFrom("images").where("id", "=", imageId).execute();
            logger.info({ imageId }, "Image permanently deleted");
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
            logger.info({ imageId }, "Image soft deleted");
          }
        },

        async cleanup(): Promise<{ deleted: number; errors: string[] }> {
          const errors: string[] = [];
          let deleted = 0;

          const orphanedCutoff = new Date(
            Date.now() - cleanup.orphanedAfterHours! * 60 * 60 * 1000
          ).toISOString();

          const failedCutoff = new Date(
            Date.now() - cleanup.failedRetentionDays! * 24 * 60 * 60 * 1000
          ).toISOString();

          const orphaned = await db
            .selectFrom("images")
            .select(["id"])
            .where("status", "in", ["pending", "uploading"])
            .where("created_at", "<", orphanedCutoff)
            .execute();

          const failed = await db
            .selectFrom("images")
            .select(["id"])
            .where("status", "=", "failed")
            .where("updated_at", "<", failedCutoff)
            .execute();

          const softDeleted = await db
            .selectFrom("images")
            .select(["id"])
            .where("status", "=", "deleted")
            .where("deleted_at", "<", failedCutoff)
            .execute();

          const toDelete = [...orphaned, ...failed, ...softDeleted];

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

          logger.info({ deleted, errors: errors.length }, "Cleanup completed");
          return { deleted, errors };
        },

        async retry(imageId: string): Promise<void> {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.ImageNotFound();
          }

          if (image.status !== "failed") {
            throw ctx.core.errors.ProcessingFailed("Can only retry failed uploads");
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

          await ctx.core.jobs.enqueue("images.process", { imageId });
          logger.info({ imageId }, "Retry enqueued");
        },

        async getPresignedUrl(
          imageId: string,
          variant?: string,
          expiresIn = 3600
        ): Promise<string> {
          const image = await db
            .selectFrom("images")
            .selectAll()
            .where("id", "=", imageId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();

          if (!image) {
            throw ctx.core.errors.ImageNotFound();
          }

          let s3Key = image.s3_key;

          if (variant && image.variants) {
            const variants: ImageVariants = JSON.parse(image.variants);
            if (variants[variant]?.s3Key) {
              s3Key = variants[variant]!.s3Key;
            }
          }

          if (config.s3.publicUrl) {
            return `${config.s3.publicUrl}/${s3Key}`;
          }

          const s3 = getS3Client();
          return s3.presign(s3Key, { expiresIn });
        },
      };
    },

    init: async (ctx, service) => {
      const logger = ctx.core.logger.child({ plugin: "images" });

      ctx.core.jobs.register("images.process", async (payload: { imageId: string }) => {
        await service.processImage(payload.imageId);
      });

      ctx.core.jobs.register(
        "images.createVariants",
        async (payload: { imageId: string; variants?: Record<string, VariantConfig> }) => {
          await service.createVariants(payload.imageId, payload.variants);
        }
      );

      ctx.core.jobs.register(
        "images.applyWatermark",
        async (payload: { imageId: string; config?: ImagesConfig["watermark"] }) => {
          await service.applyWatermark(payload.imageId, payload.config);
        }
      );

      ctx.core.cron.schedule("images-cleanup", "0 2 * * *", async () => {
        logger.info("Running scheduled cleanup");
        const result = await service.cleanup();
        logger.info(result, "Scheduled cleanup completed");
      });

      logger.info("Images plugin initialized");
    },
  });

export type { ImagesConfig, ImageRecord, ImageStatus, ImageVariants } from "./types";
