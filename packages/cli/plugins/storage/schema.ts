/**
 * Storage Plugin Schema
 *
 * Type definitions for file storage table
 */

import type { Generated } from "kysely";

export interface FilesTable {
  id: string;
  original_name: string;
  storage_key: string;
  mime_type: string;
  size: number;
  url: string;
  metadata: string | null; // JSON string
  provider: string; // "s3" or "local"
  is_public: Generated<number>; // 0 = false, 1 = true
  created_at: Generated<string>;
  updated_at: Generated<string>;
  deleted_at: string | null;
}

export interface DB {
  files: FilesTable;
}
