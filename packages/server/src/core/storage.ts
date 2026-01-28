// Core Storage Service
// File storage abstraction supporting multiple providers: S3-compatible, local filesystem, and memory

// =============================================================================
// TYPES
// =============================================================================

/** File visibility for access control */
export type StorageVisibility = "public" | "private";

/** Metadata about a stored file */
export interface StorageFile {
  /** The file key/path */
  key: string;
  /** File size in bytes */
  size: number;
  /** MIME type of the file */
  contentType?: string;
  /** Last modified date */
  lastModified: Date;
  /** ETag/checksum if available */
  etag?: string;
  /** Custom metadata */
  metadata?: Record<string, string>;
  /** File visibility */
  visibility?: StorageVisibility;
}

/** Options for uploading a file */
export interface UploadOptions {
  /** The key/path to store the file at */
  key: string;
  /** The file content - Buffer, Uint8Array, string, Blob, or ReadableStream */
  body: Buffer | Uint8Array | string | Blob | ReadableStream<Uint8Array>;
  /** MIME type of the file */
  contentType?: string;
  /** File visibility (public or private) */
  visibility?: StorageVisibility;
  /** Custom metadata to store with the file */
  metadata?: Record<string, string>;
  /** Content disposition header (e.g., 'attachment; filename="file.pdf"') */
  contentDisposition?: string;
  /** Cache control header */
  cacheControl?: string;
}

/** Result of an upload operation */
export interface UploadResult {
  /** The key/path where the file was stored */
  key: string;
  /** File size in bytes */
  size: number;
  /** ETag/checksum if available */
  etag?: string;
  /** Public URL if the file is public */
  url?: string;
}

/** Result of a download operation */
export interface DownloadResult {
  /** The file content as a readable stream */
  body: ReadableStream<Uint8Array>;
  /** File size in bytes */
  size: number;
  /** MIME type of the file */
  contentType?: string;
  /** Last modified date */
  lastModified: Date;
  /** ETag/checksum if available */
  etag?: string;
  /** Custom metadata */
  metadata?: Record<string, string>;
}

/** Options for listing files */
export interface ListOptions {
  /** Prefix to filter files by (e.g., "users/123/") */
  prefix?: string;
  /** Maximum number of files to return */
  limit?: number;
  /** Cursor for pagination (from previous ListResult) */
  cursor?: string;
  /** Delimiter for hierarchical listing (usually "/") */
  delimiter?: string;
}

/** Result of a list operation */
export interface ListResult {
  /** Files matching the query */
  files: StorageFile[];
  /** Common prefixes (directories) when using delimiter */
  prefixes: string[];
  /** Cursor for next page, null if no more results */
  cursor: string | null;
  /** Whether there are more results */
  hasMore: boolean;
}

/** Options for getting a file URL */
export interface GetUrlOptions {
  /** URL expiration time in seconds (for signed URLs) */
  expiresIn?: number;
  /** Force download with specific filename */
  download?: string | boolean;
  /** Content type override */
  contentType?: string;
}

/** Options for copying a file */
export interface CopyOptions {
  /** Source file key */
  source: string;
  /** Destination file key */
  destination: string;
  /** Override metadata (optional) */
  metadata?: Record<string, string>;
  /** Override visibility (optional) */
  visibility?: StorageVisibility;
}

// =============================================================================
// PROVIDER CONFIGS
// =============================================================================

/** S3-compatible provider configuration */
export interface S3ProviderConfig {
  provider: "s3";
  /** S3 bucket name */
  bucket: string;
  /** AWS region */
  region: string;
  /** AWS access key ID */
  accessKeyId: string;
  /** AWS secret access key */
  secretAccessKey: string;
  /** Custom endpoint URL (for R2, MinIO, DigitalOcean Spaces, etc.) */
  endpoint?: string;
  /** Public URL base for public files (e.g., CDN URL) */
  publicUrl?: string;
  /** Force path-style URLs (required for MinIO, optional for others) */
  forcePathStyle?: boolean;
}

/** Local filesystem provider configuration */
export interface LocalProviderConfig {
  provider: "local";
  /** Base directory for file storage */
  directory: string;
  /** Base URL for serving files (e.g., "/storage" or "https://cdn.example.com") */
  baseUrl?: string;
}

/** Memory provider configuration (for testing) */
export interface MemoryProviderConfig {
  provider: "memory";
}

/** Union of all provider configurations */
export type StorageConfig = S3ProviderConfig | LocalProviderConfig | MemoryProviderConfig;

// =============================================================================
// ADAPTER INTERFACE
// =============================================================================

/** Storage adapter interface - implement this for custom providers */
export interface StorageAdapter {
  /** Upload a file */
  upload(options: UploadOptions): Promise<UploadResult>;
  /** Download a file (returns null if not found) */
  download(key: string): Promise<DownloadResult | null>;
  /** Delete a file (returns true if deleted, false if not found) */
  delete(key: string): Promise<boolean>;
  /** Delete multiple files */
  deleteMany(keys: string[]): Promise<{ deleted: string[]; errors: string[] }>;
  /** List files with optional filtering and pagination */
  list(options?: ListOptions): Promise<ListResult>;
  /** Get file metadata without downloading (returns null if not found) */
  head(key: string): Promise<StorageFile | null>;
  /** Check if a file exists */
  exists(key: string): Promise<boolean>;
  /** Get a URL for accessing the file */
  getUrl(key: string, options?: GetUrlOptions): Promise<string>;
  /** Copy a file to a new location */
  copy(options: CopyOptions): Promise<UploadResult>;
  /** Cleanup resources (called on shutdown) */
  stop(): void;
}

// =============================================================================
// PUBLIC INTERFACE
// =============================================================================

/** Storage service public interface */
export interface Storage {
  /** Upload a file */
  upload(options: UploadOptions): Promise<UploadResult>;
  /** Download a file (returns null if not found) */
  download(key: string): Promise<DownloadResult | null>;
  /** Delete a file (returns true if deleted, false if not found) */
  delete(key: string): Promise<boolean>;
  /** Delete multiple files */
  deleteMany(keys: string[]): Promise<{ deleted: string[]; errors: string[] }>;
  /** List files with optional filtering and pagination */
  list(options?: ListOptions): Promise<ListResult>;
  /** Get file metadata without downloading (returns null if not found) */
  head(key: string): Promise<StorageFile | null>;
  /** Check if a file exists */
  exists(key: string): Promise<boolean>;
  /** Get a URL for accessing the file */
  getUrl(key: string, options?: GetUrlOptions): Promise<string>;
  /** Copy a file to a new location */
  copy(options: CopyOptions): Promise<UploadResult>;
  /** Move a file to a new location (copy + delete) */
  move(source: string, destination: string): Promise<UploadResult>;
  /** Cleanup resources (called on shutdown) */
  stop(): void;
}

// =============================================================================
// MEMORY ADAPTER (Testing/Default)
// =============================================================================

interface MemoryFile {
  body: Uint8Array;
  contentType?: string;
  metadata?: Record<string, string>;
  visibility?: StorageVisibility;
  contentDisposition?: string;
  cacheControl?: string;
  lastModified: Date;
}

/** In-memory storage adapter for testing and development */
export class MemoryStorageAdapter implements StorageAdapter {
  private files = new Map<string, MemoryFile>();

  async upload(options: UploadOptions): Promise<UploadResult> {
    const body = await this.toUint8Array(options.body);

    this.files.set(options.key, {
      body,
      contentType: options.contentType,
      metadata: options.metadata,
      visibility: options.visibility,
      contentDisposition: options.contentDisposition,
      cacheControl: options.cacheControl,
      lastModified: new Date(),
    });

    return {
      key: options.key,
      size: body.byteLength,
      url: options.visibility === "public" ? `memory://${options.key}` : undefined,
    };
  }

  async download(key: string): Promise<DownloadResult | null> {
    const file = this.files.get(key);
    if (!file) return null;

    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(file.body);
          controller.close();
        },
      }),
      size: file.body.byteLength,
      contentType: file.contentType,
      lastModified: file.lastModified,
      metadata: file.metadata,
    };
  }

  async delete(key: string): Promise<boolean> {
    return this.files.delete(key);
  }

  async deleteMany(keys: string[]): Promise<{ deleted: string[]; errors: string[] }> {
    const deleted: string[] = [];
    const errors: string[] = [];

    for (const key of keys) {
      if (this.files.delete(key)) {
        deleted.push(key);
      } else {
        errors.push(key);
      }
    }

    return { deleted, errors };
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const { prefix = "", limit = 1000, cursor, delimiter } = options;

    let keys = Array.from(this.files.keys());

    // Filter by prefix
    if (prefix) {
      keys = keys.filter((key) => key.startsWith(prefix));
    }

    // Sort for consistent pagination
    keys.sort();

    // Apply cursor (simple offset-based)
    if (cursor) {
      const cursorIndex = keys.findIndex((key) => key > cursor);
      if (cursorIndex === -1) {
        return { files: [], prefixes: [], cursor: null, hasMore: false };
      }
      keys = keys.slice(cursorIndex);
    }

    // Handle delimiter for hierarchical listing
    const prefixes: string[] = [];
    if (delimiter) {
      const prefixSet = new Set<string>();
      const fileKeys: string[] = [];

      for (const key of keys) {
        const relativePath = prefix ? key.slice(prefix.length) : key;
        const delimiterIndex = relativePath.indexOf(delimiter);

        if (delimiterIndex !== -1) {
          // This is a "directory" - add to prefixes
          const commonPrefix = prefix + relativePath.slice(0, delimiterIndex + 1);
          prefixSet.add(commonPrefix);
        } else {
          // This is a file at this level
          fileKeys.push(key);
        }
      }

      keys = fileKeys;
      prefixes.push(...Array.from(prefixSet).sort());
    }

    // Apply limit
    const hasMore = keys.length > limit;
    const resultKeys = keys.slice(0, limit);
    const nextCursor = hasMore ? resultKeys[resultKeys.length - 1] : null;

    // Build file list
    const files: StorageFile[] = resultKeys.map((key) => {
      const file = this.files.get(key)!;
      return {
        key,
        size: file.body.byteLength,
        contentType: file.contentType,
        lastModified: file.lastModified,
        metadata: file.metadata,
        visibility: file.visibility,
      };
    });

    return {
      files,
      prefixes,
      cursor: nextCursor,
      hasMore,
    };
  }

  async head(key: string): Promise<StorageFile | null> {
    const file = this.files.get(key);
    if (!file) return null;

    return {
      key,
      size: file.body.byteLength,
      contentType: file.contentType,
      lastModified: file.lastModified,
      metadata: file.metadata,
      visibility: file.visibility,
    };
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  async getUrl(key: string, options: GetUrlOptions = {}): Promise<string> {
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`File not found: ${key}`);
    }

    // For memory adapter, just return a memory:// URL
    let url = `memory://${key}`;

    if (options.download) {
      const filename = typeof options.download === "string" ? options.download : key.split("/").pop();
      url += `?download=${encodeURIComponent(filename || "file")}`;
    }

    return url;
  }

  async copy(options: CopyOptions): Promise<UploadResult> {
    const sourceFile = this.files.get(options.source);
    if (!sourceFile) {
      throw new Error(`Source file not found: ${options.source}`);
    }

    const newFile: MemoryFile = {
      ...sourceFile,
      metadata: options.metadata ?? sourceFile.metadata,
      visibility: options.visibility ?? sourceFile.visibility,
      lastModified: new Date(),
    };

    this.files.set(options.destination, newFile);

    return {
      key: options.destination,
      size: newFile.body.byteLength,
      url: newFile.visibility === "public" ? `memory://${options.destination}` : undefined,
    };
  }

  stop(): void {
    // Nothing to clean up for memory adapter
  }

  /** Helper to convert various body types to Uint8Array */
  private async toUint8Array(
    body: Buffer | Uint8Array | string | Blob | ReadableStream<Uint8Array>
  ): Promise<Uint8Array> {
    if (body instanceof Uint8Array) {
      return body;
    }
    if (typeof body === "string") {
      return new TextEncoder().encode(body);
    }
    if (body instanceof Blob) {
      const buffer = await body.arrayBuffer();
      return new Uint8Array(buffer);
    }
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    }
    // Buffer (Node.js)
    return new Uint8Array(body);
  }
}

// =============================================================================
// STORAGE IMPLEMENTATION
// =============================================================================

class StorageImpl implements Storage {
  private adapter: StorageAdapter;

  constructor(adapter: StorageAdapter) {
    this.adapter = adapter;
  }

  async upload(options: UploadOptions): Promise<UploadResult> {
    return this.adapter.upload(options);
  }

  async download(key: string): Promise<DownloadResult | null> {
    return this.adapter.download(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.adapter.delete(key);
  }

  async deleteMany(keys: string[]): Promise<{ deleted: string[]; errors: string[] }> {
    return this.adapter.deleteMany(keys);
  }

  async list(options?: ListOptions): Promise<ListResult> {
    return this.adapter.list(options);
  }

  async head(key: string): Promise<StorageFile | null> {
    return this.adapter.head(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.adapter.exists(key);
  }

  async getUrl(key: string, options?: GetUrlOptions): Promise<string> {
    return this.adapter.getUrl(key, options);
  }

  async copy(options: CopyOptions): Promise<UploadResult> {
    return this.adapter.copy(options);
  }

  async move(source: string, destination: string): Promise<UploadResult> {
    const result = await this.adapter.copy({ source, destination });
    await this.adapter.delete(source);
    return result;
  }

  stop(): void {
    this.adapter.stop();
  }
}

// =============================================================================
// FACTORY
// =============================================================================

import { LocalStorageAdapter } from "./storage-adapter-local";
import { S3StorageAdapter } from "./storage-adapter-s3";

/** Create a storage service with the specified configuration */
export function createStorage(config?: StorageConfig): Storage {
  let adapter: StorageAdapter;

  if (!config || config.provider === "memory") {
    adapter = new MemoryStorageAdapter();
  } else if (config.provider === "local") {
    adapter = new LocalStorageAdapter(config);
  } else if (config.provider === "s3") {
    adapter = new S3StorageAdapter(config);
  } else {
    throw new Error(`Unknown storage provider: ${(config as any).provider}`);
  }

  return new StorageImpl(adapter);
}
