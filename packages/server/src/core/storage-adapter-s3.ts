// S3-Compatible Storage Adapter
// Supports AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, Backblaze B2

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
  S3ProviderConfig,
  StorageVisibility,
} from "./storage";

// Type definitions for AWS SDK (dynamically imported)
type S3Client = any;
type GetObjectCommand = any;
type PutObjectCommand = any;
type DeleteObjectCommand = any;
type DeleteObjectsCommand = any;
type ListObjectsV2Command = any;
type HeadObjectCommand = any;
type CopyObjectCommand = any;
type GetSignedUrl = (client: any, command: any, options: { expiresIn: number }) => Promise<string>;

/** S3-compatible storage adapter */
export class S3StorageAdapter implements StorageAdapter {
  private client: S3Client | null = null;
  private config: S3ProviderConfig;
  private s3Module: any = null;
  private presignerModule: any = null;

  constructor(config: S3ProviderConfig) {
    this.config = config;
  }

  private async getClient(): Promise<S3Client> {
    if (this.client) return this.client;

    try {
      // Dynamically import AWS SDK (optional dependency)
      // @ts-expect-error - Optional peer dependency, may not be installed
      this.s3Module = await import("@aws-sdk/client-s3");
      // @ts-expect-error - Optional peer dependency, may not be installed
      this.presignerModule = await import("@aws-sdk/s3-request-presigner");

      const { S3Client } = this.s3Module;

      this.client = new S3Client({
        region: this.config.region,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
        endpoint: this.config.endpoint,
        forcePathStyle: this.config.forcePathStyle,
      });

      return this.client;
    } catch (err) {
      throw new Error(
        "S3 storage adapter requires @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner. " +
          "Install them with: bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner"
      );
    }
  }

  private visibilityToAcl(visibility?: StorageVisibility): string | undefined {
    if (visibility === "public") return "public-read";
    if (visibility === "private") return "private";
    return undefined;
  }

  async upload(options: UploadOptions): Promise<UploadResult> {
    const client = await this.getClient();
    const { PutObjectCommand } = this.s3Module;

    // Convert body to appropriate format
    const body = await this.normalizeBody(options.body);

    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: options.key,
      Body: body,
      ContentType: options.contentType,
      ContentDisposition: options.contentDisposition,
      CacheControl: options.cacheControl,
      ACL: this.visibilityToAcl(options.visibility),
      Metadata: options.metadata,
    });

    const response = await client.send(command);

    // Calculate size
    let size = 0;
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      size = body.byteLength;
    } else if (typeof body === "string") {
      size = new TextEncoder().encode(body).length;
    }

    // Generate public URL if visibility is public
    let url: string | undefined;
    if (options.visibility === "public") {
      url = this.getPublicUrl(options.key);
    }

    return {
      key: options.key,
      size,
      etag: response.ETag?.replace(/"/g, ""),
      url,
    };
  }

  async download(key: string): Promise<DownloadResult | null> {
    const client = await this.getClient();
    const { GetObjectCommand } = this.s3Module;

    try {
      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });

      const response = await client.send(command);

      if (!response.Body) {
        return null;
      }

      // Convert S3 body to web ReadableStream
      const body = response.Body.transformToWebStream
        ? response.Body.transformToWebStream()
        : response.Body;

      return {
        body,
        size: response.ContentLength || 0,
        contentType: response.ContentType,
        lastModified: response.LastModified || new Date(),
        etag: response.ETag?.replace(/"/g, ""),
        metadata: response.Metadata,
      };
    } catch (err: any) {
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    const client = await this.getClient();
    const { DeleteObjectCommand } = this.s3Module;

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });

      await client.send(command);
      return true;
    } catch (err: any) {
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  async deleteMany(keys: string[]): Promise<{ deleted: string[]; errors: string[] }> {
    if (keys.length === 0) {
      return { deleted: [], errors: [] };
    }

    const client = await this.getClient();
    const { DeleteObjectsCommand } = this.s3Module;

    const deleted: string[] = [];
    const errors: string[] = [];

    // S3 allows max 1000 objects per delete request
    const batches = this.chunk(keys, 1000);

    for (const batch of batches) {
      try {
        const command = new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: false,
          },
        });

        const response = await client.send(command);

        // Track deleted
        if (response.Deleted) {
          for (const obj of response.Deleted) {
            if (obj.Key) deleted.push(obj.Key);
          }
        }

        // Track errors
        if (response.Errors) {
          for (const err of response.Errors) {
            if (err.Key) errors.push(err.Key);
          }
        }
      } catch (err) {
        // If batch fails, all keys in batch are errors
        errors.push(...batch);
      }
    }

    return { deleted, errors };
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const client = await this.getClient();
    const { ListObjectsV2Command } = this.s3Module;

    const command = new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: options.prefix,
      MaxKeys: options.limit || 1000,
      ContinuationToken: options.cursor || undefined,
      Delimiter: options.delimiter,
    });

    const response = await client.send(command);

    const files: StorageFile[] = (response.Contents || []).map((obj: any) => ({
      key: obj.Key,
      size: obj.Size || 0,
      lastModified: obj.LastModified || new Date(),
      etag: obj.ETag?.replace(/"/g, ""),
    }));

    const prefixes: string[] = (response.CommonPrefixes || [])
      .map((p: any) => p.Prefix)
      .filter(Boolean);

    return {
      files,
      prefixes,
      cursor: response.NextContinuationToken || null,
      hasMore: response.IsTruncated || false,
    };
  }

  async head(key: string): Promise<StorageFile | null> {
    const client = await this.getClient();
    const { HeadObjectCommand } = this.s3Module;

    try {
      const command = new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });

      const response = await client.send(command);

      return {
        key,
        size: response.ContentLength || 0,
        contentType: response.ContentType,
        lastModified: response.LastModified || new Date(),
        etag: response.ETag?.replace(/"/g, ""),
        metadata: response.Metadata,
      };
    } catch (err: any) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.head(key);
    return result !== null;
  }

  async getUrl(key: string, options: GetUrlOptions = {}): Promise<string> {
    const { expiresIn = 3600 } = options;

    // If we have a public URL configured, use it for public files
    if (this.config.publicUrl) {
      // Check if file is public (we'd need to HEAD it to know for sure)
      // For simplicity, if publicUrl is set, assume it can be used
      let url = `${this.config.publicUrl}/${key}`;

      if (options.download) {
        const filename =
          typeof options.download === "string" ? options.download : key.split("/").pop();
        url += `?response-content-disposition=${encodeURIComponent(`attachment; filename="${filename}"`)}`;
      }

      return url;
    }

    // Generate signed URL
    const client = await this.getClient();
    const { GetObjectCommand } = this.s3Module;
    const { getSignedUrl } = this.presignerModule;

    const commandOptions: any = {
      Bucket: this.config.bucket,
      Key: key,
    };

    if (options.download) {
      const filename =
        typeof options.download === "string" ? options.download : key.split("/").pop();
      commandOptions.ResponseContentDisposition = `attachment; filename="${filename}"`;
    }

    if (options.contentType) {
      commandOptions.ResponseContentType = options.contentType;
    }

    const command = new GetObjectCommand(commandOptions);
    return getSignedUrl(client, command, { expiresIn });
  }

  async copy(options: CopyOptions): Promise<UploadResult> {
    const client = await this.getClient();
    const { CopyObjectCommand } = this.s3Module;

    const command = new CopyObjectCommand({
      Bucket: this.config.bucket,
      CopySource: `${this.config.bucket}/${options.source}`,
      Key: options.destination,
      ACL: this.visibilityToAcl(options.visibility),
      Metadata: options.metadata,
      MetadataDirective: options.metadata ? "REPLACE" : "COPY",
    });

    const response = await client.send(command);

    // Get size of the copied object
    const headResult = await this.head(options.destination);

    return {
      key: options.destination,
      size: headResult?.size || 0,
      etag: response.CopyObjectResult?.ETag?.replace(/"/g, ""),
    };
  }

  stop(): void {
    if (this.client && typeof this.client.destroy === "function") {
      this.client.destroy();
    }
    this.client = null;
  }

  /** Get public URL for an object */
  private getPublicUrl(key: string): string {
    if (this.config.publicUrl) {
      return `${this.config.publicUrl}/${key}`;
    }

    // Construct default S3 URL
    if (this.config.endpoint) {
      // Custom endpoint (R2, MinIO, etc.)
      const endpoint = this.config.endpoint.replace(/\/$/, "");
      if (this.config.forcePathStyle) {
        return `${endpoint}/${this.config.bucket}/${key}`;
      }
      return `${endpoint}/${key}`;
    }

    // AWS S3 URL
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${key}`;
  }

  /** Normalize body to a format S3 accepts */
  private async normalizeBody(
    body: Buffer | Uint8Array | string | Blob | ReadableStream<Uint8Array>
  ): Promise<Buffer | Uint8Array | string | ReadableStream<Uint8Array>> {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === "string") {
      return body;
    }

    if (body instanceof Blob) {
      const arrayBuffer = await body.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    // ReadableStream - pass through
    return body;
  }

  /** Split array into chunks */
  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
