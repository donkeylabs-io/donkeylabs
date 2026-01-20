/**
 * Images Plugin Database Schema
 *
 * Type definitions for the images table
 */

import type { Generated, ColumnType } from "kysely";

export interface ImagesTable {
  id: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  size: number;
  s3_key: string;
  s3_bucket: string;
  status: Generated<string>;
  processing_stage: string | null;
  processing_progress: Generated<number>;
  error: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  metadata: string | null;
  variants: string | null;
  watermark_config: string | null;
  upload_id: string | null;
  user_id: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  completed_at: string | null;
  deleted_at: string | null;
}

export interface DB {
  images: ImagesTable;
}
