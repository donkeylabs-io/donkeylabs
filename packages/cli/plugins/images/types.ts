/**
 * Images Plugin Types
 *
 * Configuration and type definitions for S3 image upload with processing
 */

import type { Generated } from "kysely";

export interface ImagesConfig {
  s3: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint?: string;
    publicUrl?: string;
  };
  processing?: {
    maxFileSize?: number;
    allowedMimeTypes?: string[];
    defaultQuality?: number;
    stripExif?: boolean;
  };
  variants?: {
    thumbnail?: VariantConfig;
    medium?: VariantConfig;
    [key: string]: VariantConfig | undefined;
  };
  watermark?: {
    enabled?: boolean;
    logoS3Key?: string;
    position?: WatermarkPosition;
    opacity?: number;
    scale?: number;
  };
  cleanup?: {
    orphanedAfterHours?: number;
    failedRetentionDays?: number;
  };
}

export interface VariantConfig {
  width: number;
  height: number;
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  quality?: number;
}

export type WatermarkPosition =
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type ImageStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "completed"
  | "failed"
  | "deleted";

export type ProcessingStage =
  | "validating"
  | "downloading"
  | "optimizing"
  | "creating-variants"
  | "applying-watermark"
  | "uploading"
  | "finalizing";

export interface ImageRecord {
  id: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  s3Key: string;
  s3Bucket: string;
  status: ImageStatus;
  processingStage?: ProcessingStage | null;
  processingProgress: number;
  error?: string | null;
  width?: number | null;
  height?: number | null;
  format?: string | null;
  metadata?: string | null;
  variants?: string | null;
  watermarkConfig?: string | null;
  uploadId?: string | null;
  userId?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  deletedAt?: string | null;
}

export interface ImageVariants {
  thumbnail?: ImageVariantInfo;
  medium?: ImageVariantInfo;
  [key: string]: ImageVariantInfo | undefined;
}

export interface ImageVariantInfo {
  s3Key: string;
  width: number;
  height: number;
  size: number;
  format: string;
}

export interface ImageMetadata {
  exif?: Record<string, unknown>;
  orientation?: number;
  hasAlpha?: boolean;
  colorSpace?: string;
}

export interface InitUploadParams {
  filename: string;
  mimeType: string;
  size: number;
  userId?: string;
}

export interface InitUploadResult {
  imageId: string;
  uploadUrl: string;
  method: "PUT";
  expiresIn: number;
}

export interface ProcessImageOptions {
  skipVariants?: boolean;
  skipWatermark?: boolean;
  quality?: number;
  format?: "jpeg" | "png" | "webp" | "avif";
}

export interface ListImagesParams {
  page?: number;
  limit?: number;
  status?: ImageStatus;
  userId?: string;
}

export interface ListImagesResult {
  images: ImageRecord[];
  total: number;
  page: number;
  totalPages: number;
}

export interface UploadProgressEvent {
  imageId: string;
  progress: number;
  stage: ProcessingStage;
  message: string;
}

export interface UploadCompletedEvent {
  imageId: string;
  url: string;
  variants?: ImageVariants;
}

export interface UploadFailedEvent {
  imageId: string;
  error: string;
  stage?: ProcessingStage;
}

export const DEFAULT_CONFIG = {
  processing: {
    maxFileSize: 10 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    defaultQuality: 80,
    stripExif: true,
  },
  variants: {
    thumbnail: { width: 150, height: 150, fit: "cover" as const },
    medium: { width: 800, height: 600, fit: "inside" as const },
  },
  watermark: {
    enabled: false,
    position: "bottom-right" as const,
    opacity: 0.5,
    scale: 0.2,
  },
  cleanup: {
    orphanedAfterHours: 24,
    failedRetentionDays: 7,
  },
} as const;
