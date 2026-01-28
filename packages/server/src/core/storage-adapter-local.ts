// Local Filesystem Storage Adapter
// Stores files in a local directory with metadata in .meta.json sidecar files

import { mkdir, readFile, writeFile, unlink, readdir, stat, rm } from "node:fs/promises";
import { join, dirname, basename, relative } from "node:path";
import { existsSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type {
  StorageAdapter,
  StorageFile,
  UploadOptions,
  UploadResult,
  DownloadResult,
  ListOptions,
  ListResult,
  GetUrlOptions,
  CopyOptions,
  LocalProviderConfig,
  StorageVisibility,
} from "./storage";

interface FileMetadata {
  contentType?: string;
  metadata?: Record<string, string>;
  visibility?: StorageVisibility;
  contentDisposition?: string;
  cacheControl?: string;
  size: number;
  lastModified: string;
}

/** Local filesystem storage adapter */
export class LocalStorageAdapter implements StorageAdapter {
  private directory: string;
  private baseUrl: string;

  constructor(config: LocalProviderConfig) {
    this.directory = config.directory;
    this.baseUrl = config.baseUrl || "/storage";

    // Ensure directory exists
    this.ensureDirectory(this.directory);
  }

  private async ensureDirectory(dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      // Ignore if already exists
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
  }

  private getFilePath(key: string): string {
    // Normalize key to prevent directory traversal attacks
    const normalizedKey = key.replace(/\.\./g, "").replace(/^\/+/, "");
    return join(this.directory, normalizedKey);
  }

  private getMetaPath(key: string): string {
    const filePath = this.getFilePath(key);
    const dir = dirname(filePath);
    const name = basename(filePath);
    return join(dir, `.${name}.meta.json`);
  }

  private async readMetadata(key: string): Promise<FileMetadata | null> {
    const metaPath = this.getMetaPath(key);
    try {
      const content = await readFile(metaPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async writeMetadata(key: string, metadata: FileMetadata): Promise<void> {
    const metaPath = this.getMetaPath(key);
    await this.ensureDirectory(dirname(metaPath));
    await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  }

  private async deleteMetadata(key: string): Promise<void> {
    const metaPath = this.getMetaPath(key);
    try {
      await unlink(metaPath);
    } catch {
      // Ignore if doesn't exist
    }
  }

  async upload(options: UploadOptions): Promise<UploadResult> {
    const filePath = this.getFilePath(options.key);
    await this.ensureDirectory(dirname(filePath));

    // Convert body to buffer
    const buffer = await this.toBuffer(options.body);

    // Write file
    await writeFile(filePath, buffer);

    // Write metadata
    const metadata: FileMetadata = {
      contentType: options.contentType,
      metadata: options.metadata,
      visibility: options.visibility,
      contentDisposition: options.contentDisposition,
      cacheControl: options.cacheControl,
      size: buffer.byteLength,
      lastModified: new Date().toISOString(),
    };
    await this.writeMetadata(options.key, metadata);

    const url =
      options.visibility === "public" ? `${this.baseUrl}/${options.key}` : undefined;

    return {
      key: options.key,
      size: buffer.byteLength,
      url,
    };
  }

  async download(key: string): Promise<DownloadResult | null> {
    const filePath = this.getFilePath(key);

    if (!existsSync(filePath)) {
      return null;
    }

    const meta = await this.readMetadata(key);
    const fileStat = await stat(filePath);

    // Create readable stream
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

    return {
      body: webStream,
      size: fileStat.size,
      contentType: meta?.contentType,
      lastModified: new Date(meta?.lastModified || fileStat.mtime),
      metadata: meta?.metadata,
    };
  }

  async delete(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);

    try {
      await unlink(filePath);
      await this.deleteMetadata(key);
      return true;
    } catch {
      return false;
    }
  }

  async deleteMany(keys: string[]): Promise<{ deleted: string[]; errors: string[] }> {
    const deleted: string[] = [];
    const errors: string[] = [];

    for (const key of keys) {
      if (await this.delete(key)) {
        deleted.push(key);
      } else {
        errors.push(key);
      }
    }

    return { deleted, errors };
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const { prefix = "", limit = 1000, cursor, delimiter } = options;

    const prefixPath = prefix ? join(this.directory, prefix) : this.directory;
    const files: StorageFile[] = [];
    const prefixes: string[] = [];
    const prefixSet = new Set<string>();

    try {
      await this.walkDirectory(
        prefixPath,
        this.directory,
        prefix,
        delimiter,
        files,
        prefixSet,
        limit,
        cursor
      );
    } catch (err) {
      // Directory doesn't exist, return empty
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { files: [], prefixes: [], cursor: null, hasMore: false };
      }
      throw err;
    }

    // Sort files by key for consistent pagination
    files.sort((a, b) => a.key.localeCompare(b.key));

    // Apply cursor
    let startIndex = 0;
    if (cursor) {
      startIndex = files.findIndex((f) => f.key > cursor);
      if (startIndex === -1) startIndex = files.length;
    }

    const resultFiles = files.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < files.length;
    const nextCursor = hasMore ? resultFiles[resultFiles.length - 1]?.key || null : null;

    return {
      files: resultFiles,
      prefixes: Array.from(prefixSet).sort(),
      cursor: nextCursor,
      hasMore,
    };
  }

  private async walkDirectory(
    dirPath: string,
    baseDir: string,
    prefix: string,
    delimiter: string | undefined,
    files: StorageFile[],
    prefixSet: Set<string>,
    limit: number,
    cursor: string | undefined
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip metadata files
      if (entry.name.endsWith(".meta.json")) continue;

      const fullPath = join(dirPath, entry.name);
      const key = relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        if (delimiter) {
          // Add as prefix
          prefixSet.add(key + delimiter);
        } else {
          // Recurse into directory
          await this.walkDirectory(
            fullPath,
            baseDir,
            prefix,
            delimiter,
            files,
            prefixSet,
            limit,
            cursor
          );
        }
      } else {
        // Check if key matches prefix
        if (!key.startsWith(prefix.replace(/\/$/, ""))) continue;

        // Check cursor
        if (cursor && key <= cursor) continue;

        // Get file stats and metadata
        const fileStat = await stat(fullPath);
        const meta = await this.readMetadata(key);

        files.push({
          key,
          size: fileStat.size,
          contentType: meta?.contentType,
          lastModified: new Date(meta?.lastModified || fileStat.mtime),
          metadata: meta?.metadata,
          visibility: meta?.visibility,
        });

        // Early exit if we have enough
        if (files.length >= limit * 2) return;
      }
    }
  }

  async head(key: string): Promise<StorageFile | null> {
    const filePath = this.getFilePath(key);

    try {
      const fileStat = await stat(filePath);
      const meta = await this.readMetadata(key);

      return {
        key,
        size: fileStat.size,
        contentType: meta?.contentType,
        lastModified: new Date(meta?.lastModified || fileStat.mtime),
        metadata: meta?.metadata,
        visibility: meta?.visibility,
      };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);
    return existsSync(filePath);
  }

  async getUrl(key: string, options: GetUrlOptions = {}): Promise<string> {
    // For local storage, we can only provide a path-based URL
    // The actual serving needs to be handled by the application
    let url = `${this.baseUrl}/${key}`;

    if (options.download) {
      const filename =
        typeof options.download === "string" ? options.download : key.split("/").pop();
      url += `?download=${encodeURIComponent(filename || "file")}`;
    }

    return url;
  }

  async copy(options: CopyOptions): Promise<UploadResult> {
    const sourcePath = this.getFilePath(options.source);
    const destPath = this.getFilePath(options.destination);

    if (!existsSync(sourcePath)) {
      throw new Error(`Source file not found: ${options.source}`);
    }

    await this.ensureDirectory(dirname(destPath));

    // Read source file
    const content = await readFile(sourcePath);
    const sourceMeta = await this.readMetadata(options.source);

    // Write destination file
    await writeFile(destPath, content);

    // Write destination metadata
    const destMeta: FileMetadata = {
      ...sourceMeta,
      metadata: options.metadata ?? sourceMeta?.metadata,
      visibility: options.visibility ?? sourceMeta?.visibility,
      size: content.byteLength,
      lastModified: new Date().toISOString(),
    };
    await this.writeMetadata(options.destination, destMeta);

    const url =
      destMeta.visibility === "public"
        ? `${this.baseUrl}/${options.destination}`
        : undefined;

    return {
      key: options.destination,
      size: content.byteLength,
      url,
    };
  }

  stop(): void {
    // Nothing to clean up for local adapter
  }

  /** Helper to convert various body types to Buffer */
  private async toBuffer(
    body: Buffer | Uint8Array | string | Blob | ReadableStream<Uint8Array>
  ): Promise<Buffer> {
    if (Buffer.isBuffer(body)) {
      return body;
    }
    if (body instanceof Uint8Array) {
      return Buffer.from(body);
    }
    if (typeof body === "string") {
      return Buffer.from(body, "utf-8");
    }
    if (body instanceof Blob) {
      const arrayBuffer = await body.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    }
    throw new Error("Unsupported body type");
  }
}
