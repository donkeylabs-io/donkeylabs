/**
 * Images Plugin Handlers
 *
 * Reusable route handlers and schemas for image operations.
 * Import these into your routes and compose as needed.
 *
 * @example
 * ```ts
 * import { createRouter } from "@donkeylabs/server";
 * import { imageSchemas, createImageHandlers } from "./plugins/images/handlers";
 *
 * const api = createRouter("api");
 *
 * api.route("images.upload").typed({
 *   input: imageSchemas.upload.input,
 *   output: imageSchemas.upload.output,
 *   handle: async (input, ctx) => ctx.plugins.images.initUpload(input),
 * });
 * ```
 */

import { z } from "zod";

// =============================================================================
// SHARED SCHEMAS
// =============================================================================

const imageStatusSchema = z.enum([
  "pending",
  "uploading",
  "processing",
  "completed",
  "failed",
  "deleted",
]);

const imageRecordSchema = z.object({
  id: z.string(),
  filename: z.string(),
  originalFilename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  s3Key: z.string(),
  s3Bucket: z.string(),
  status: imageStatusSchema,
  processingStage: z.string().nullable(),
  processingProgress: z.number(),
  error: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  format: z.string().nullable(),
  metadata: z.string().nullable(),
  variants: z.string().nullable(),
  watermarkConfig: z.string().nullable(),
  uploadId: z.string().nullable(),
  userId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

const variantConfigSchema = z.object({
  width: z.number(),
  height: z.number(),
  fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional(),
  quality: z.number().min(1).max(100).optional(),
});

const watermarkPositionSchema = z.enum([
  "center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

// =============================================================================
// ROUTE SCHEMAS
// =============================================================================

export const imageSchemas = {
  /**
   * Initialize upload - get presigned URL for direct S3 upload
   */
  upload: {
    input: z.object({
      filename: z.string(),
      mimeType: z.string(),
      size: z.number(),
      userId: z.string().optional(),
    }),
    output: z.object({
      imageId: z.string(),
      uploadUrl: z.string(),
      method: z.literal("PUT"),
      expiresIn: z.number(),
    }),
  },

  /**
   * Process an uploaded image (async job)
   */
  process: {
    input: z.object({
      imageId: z.string(),
      skipVariants: z.boolean().optional(),
      skipWatermark: z.boolean().optional(),
      quality: z.number().min(1).max(100).optional(),
      format: z.enum(["jpeg", "png", "webp", "avif"]).optional(),
    }),
    output: z.object({
      success: z.boolean(),
      jobId: z.string().optional(),
    }),
  },

  /**
   * Create image variants (async job)
   */
  createVariants: {
    input: z.object({
      imageId: z.string(),
      variants: z.record(variantConfigSchema).optional(),
    }),
    output: z.object({
      success: z.boolean(),
      jobId: z.string().optional(),
    }),
  },

  /**
   * Apply watermark to image (async job)
   */
  applyWatermark: {
    input: z.object({
      imageId: z.string(),
      logoS3Key: z.string().optional(),
      position: watermarkPositionSchema.optional(),
      opacity: z.number().min(0).max(1).optional(),
      scale: z.number().min(0.01).max(1).optional(),
    }),
    output: z.object({
      success: z.boolean(),
      jobId: z.string().optional(),
    }),
  },

  /**
   * Get single image by ID
   */
  get: {
    input: z.object({
      imageId: z.string(),
    }),
    output: imageRecordSchema.nullable(),
  },

  /**
   * List images with pagination and filtering
   */
  list: {
    input: z.object({
      page: z.number().min(1).optional(),
      limit: z.number().min(1).max(100).optional(),
      status: imageStatusSchema.optional(),
      userId: z.string().optional(),
    }),
    output: z.object({
      images: z.array(imageRecordSchema),
      total: z.number(),
      page: z.number(),
      totalPages: z.number(),
    }),
  },

  /**
   * Delete an image (soft or permanent)
   */
  delete: {
    input: z.object({
      imageId: z.string(),
      permanent: z.boolean().optional(),
    }),
    output: z.object({
      success: z.boolean(),
    }),
  },

  /**
   * Get presigned URL for viewing/downloading
   */
  url: {
    input: z.object({
      imageId: z.string(),
      variant: z.string().optional(),
      expiresIn: z.number().min(60).max(604800).optional(),
    }),
    output: z.object({
      url: z.string(),
    }),
  },

  /**
   * Retry a failed upload
   */
  retry: {
    input: z.object({
      imageId: z.string(),
    }),
    output: z.object({
      success: z.boolean(),
    }),
  },

  /**
   * Clean up orphaned and failed uploads
   */
  cleanup: {
    input: z.object({}),
    output: z.object({
      deleted: z.number(),
      errors: z.array(z.string()),
    }),
  },
} as const;

// =============================================================================
// SSE SUBSCRIPTION HELPER
// =============================================================================

/**
 * Create an SSE subscription handler for image progress updates.
 *
 * @example
 * ```ts
 * import { createRouter } from "@donkeylabs/server";
 * import { createSSEHandler } from "./plugins/images/handlers";
 *
 * const api = createRouter("api");
 *
 * api.route("images.subscribe").raw(createSSEHandler());
 * ```
 */
export function createSSEHandler() {
  return async (req: Request, ctx: any): Promise<Response> => {
    const url = new URL(req.url);
    const imageId = url.searchParams.get("imageId");

    if (!imageId) {
      return new Response(JSON.stringify({ error: "imageId query parameter is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { client, response } = ctx.core.sse.addClient();

    // Subscribe to specific image channel
    ctx.core.sse.subscribe(client.id, `images.${imageId}`);

    // Also subscribe to general images channel
    ctx.core.sse.subscribe(client.id, "images");

    return response;
  };
}

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type ImageStatus = z.infer<typeof imageStatusSchema>;
export type ImageRecord = z.infer<typeof imageRecordSchema>;
export type VariantConfig = z.infer<typeof variantConfigSchema>;
export type WatermarkPosition = z.infer<typeof watermarkPositionSchema>;

export type UploadInput = z.infer<typeof imageSchemas.upload.input>;
export type UploadOutput = z.infer<typeof imageSchemas.upload.output>;
export type ProcessInput = z.infer<typeof imageSchemas.process.input>;
export type ProcessOutput = z.infer<typeof imageSchemas.process.output>;
export type ListInput = z.infer<typeof imageSchemas.list.input>;
export type ListOutput = z.infer<typeof imageSchemas.list.output>;
