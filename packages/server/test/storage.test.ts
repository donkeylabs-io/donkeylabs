import { describe, it, expect, beforeEach } from "bun:test";
import {
  MemoryStorageAdapter,
  createStorage,
  type Storage,
  type StorageAdapter,
} from "../src/core/storage";

// =============================================================================
// MemoryStorageAdapter Tests
// =============================================================================

describe("MemoryStorageAdapter", () => {
  let adapter: MemoryStorageAdapter;

  beforeEach(() => {
    adapter = new MemoryStorageAdapter();
  });

  // ---------------------------------------------------------------------------
  // upload
  // ---------------------------------------------------------------------------
  describe("upload", () => {
    it("should upload a string body", async () => {
      const result = await adapter.upload({
        key: "test.txt",
        body: "hello world",
        contentType: "text/plain",
      });

      expect(result.key).toBe("test.txt");
      expect(result.size).toBe(new TextEncoder().encode("hello world").byteLength);
    });

    it("should upload a Uint8Array body", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await adapter.upload({
        key: "binary.dat",
        body: data,
      });

      expect(result.key).toBe("binary.dat");
      expect(result.size).toBe(5);
    });

    it("should upload a Buffer body", async () => {
      const buf = Buffer.from("buffer content");
      const result = await adapter.upload({
        key: "buffer.txt",
        body: buf,
      });

      expect(result.key).toBe("buffer.txt");
      expect(result.size).toBe(buf.byteLength);
    });

    it("should upload a Blob body", async () => {
      const blob = new Blob(["blob content"], { type: "text/plain" });
      const result = await adapter.upload({
        key: "blob.txt",
        body: blob,
      });

      expect(result.key).toBe("blob.txt");
      expect(result.size).toBe(new TextEncoder().encode("blob content").byteLength);
    });

    it("should upload a ReadableStream body", async () => {
      const chunks = [
        new TextEncoder().encode("chunk1"),
        new TextEncoder().encode("chunk2"),
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const result = await adapter.upload({
        key: "stream.txt",
        body: stream,
      });

      expect(result.key).toBe("stream.txt");
      expect(result.size).toBe(
        chunks.reduce((sum, c) => sum + c.byteLength, 0)
      );
    });

    it("should return a url for public visibility", async () => {
      const result = await adapter.upload({
        key: "public.txt",
        body: "public content",
        visibility: "public",
      });

      expect(result.url).toBe("memory://public.txt");
    });

    it("should not return a url for private visibility", async () => {
      const result = await adapter.upload({
        key: "private.txt",
        body: "private content",
        visibility: "private",
      });

      expect(result.url).toBeUndefined();
    });

    it("should not return a url when visibility is not set", async () => {
      const result = await adapter.upload({
        key: "default.txt",
        body: "content",
      });

      expect(result.url).toBeUndefined();
    });

    it("should store metadata", async () => {
      await adapter.upload({
        key: "meta.txt",
        body: "content",
        metadata: { author: "test", version: "1" },
      });

      const file = await adapter.head("meta.txt");
      expect(file).not.toBeNull();
      expect(file!.metadata).toEqual({ author: "test", version: "1" });
    });
  });

  // ---------------------------------------------------------------------------
  // download
  // ---------------------------------------------------------------------------
  describe("download", () => {
    it("should return file content as a ReadableStream", async () => {
      await adapter.upload({
        key: "dl.txt",
        body: "download me",
        contentType: "text/plain",
        metadata: { tag: "v1" },
      });

      const result = await adapter.download("dl.txt");
      expect(result).not.toBeNull();
      expect(result!.contentType).toBe("text/plain");
      expect(result!.metadata).toEqual({ tag: "v1" });
      expect(result!.size).toBe(new TextEncoder().encode("download me").byteLength);
      expect(result!.lastModified).toBeInstanceOf(Date);

      // Read the stream
      const reader = result!.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toBe("download me");
    });

    it("should return null for missing file", async () => {
      const result = await adapter.download("nonexistent.txt");
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------
  describe("delete", () => {
    it("should delete an existing file and return true", async () => {
      await adapter.upload({ key: "to-delete.txt", body: "bye" });

      const deleted = await adapter.delete("to-delete.txt");
      expect(deleted).toBe(true);

      const exists = await adapter.exists("to-delete.txt");
      expect(exists).toBe(false);
    });

    it("should return false for missing file", async () => {
      const deleted = await adapter.delete("nope.txt");
      expect(deleted).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteMany
  // ---------------------------------------------------------------------------
  describe("deleteMany", () => {
    it("should delete multiple files", async () => {
      await adapter.upload({ key: "a.txt", body: "a" });
      await adapter.upload({ key: "b.txt", body: "b" });
      await adapter.upload({ key: "c.txt", body: "c" });

      const result = await adapter.deleteMany(["a.txt", "b.txt"]);
      expect(result.deleted).toEqual(["a.txt", "b.txt"]);
      expect(result.errors).toEqual([]);

      expect(await adapter.exists("a.txt")).toBe(false);
      expect(await adapter.exists("b.txt")).toBe(false);
      expect(await adapter.exists("c.txt")).toBe(true);
    });

    it("should report errors for missing files", async () => {
      await adapter.upload({ key: "exists.txt", body: "yes" });

      const result = await adapter.deleteMany(["exists.txt", "missing.txt"]);
      expect(result.deleted).toEqual(["exists.txt"]);
      expect(result.errors).toEqual(["missing.txt"]);
    });

    it("should handle empty keys array", async () => {
      const result = await adapter.deleteMany([]);
      expect(result.deleted).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------
  describe("list", () => {
    beforeEach(async () => {
      await adapter.upload({ key: "users/1/avatar.png", body: "img1" });
      await adapter.upload({ key: "users/1/docs/resume.pdf", body: "pdf1" });
      await adapter.upload({ key: "users/2/avatar.png", body: "img2" });
      await adapter.upload({ key: "readme.txt", body: "readme" });
      await adapter.upload({ key: "config.json", body: "{}" });
    });

    it("should list all files with no filter", async () => {
      const result = await adapter.list();
      expect(result.files).toHaveLength(5);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
      expect(result.prefixes).toEqual([]);
    });

    it("should filter by prefix", async () => {
      const result = await adapter.list({ prefix: "users/" });
      expect(result.files).toHaveLength(3);
      for (const f of result.files) {
        expect(f.key.startsWith("users/")).toBe(true);
      }
    });

    it("should support delimiter for hierarchical listing", async () => {
      const result = await adapter.list({ delimiter: "/" });

      // Root-level files only
      expect(result.files.map((f) => f.key).sort()).toEqual([
        "config.json",
        "readme.txt",
      ]);
      // Common prefixes (directories)
      expect(result.prefixes).toEqual(["users/"]);
    });

    it("should support prefix + delimiter", async () => {
      const result = await adapter.list({
        prefix: "users/",
        delimiter: "/",
      });

      // No files directly under users/ without further path
      expect(result.files).toHaveLength(0);
      // Should see user directories
      expect(result.prefixes.sort()).toEqual(["users/1/", "users/2/"]);
    });

    it("should paginate with limit and cursor", async () => {
      const page1 = await adapter.list({ limit: 2 });
      expect(page1.files).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).not.toBeNull();

      const page2 = await adapter.list({ limit: 2, cursor: page1.cursor! });
      expect(page2.files).toHaveLength(2);
      expect(page2.hasMore).toBe(true);

      const page3 = await adapter.list({ limit: 2, cursor: page2.cursor! });
      expect(page3.files).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
      expect(page3.cursor).toBeNull();

      // All files should be unique across pages
      const allKeys = [
        ...page1.files.map((f) => f.key),
        ...page2.files.map((f) => f.key),
        ...page3.files.map((f) => f.key),
      ];
      expect(new Set(allKeys).size).toBe(5);
    });

    it("should return empty result for cursor past end", async () => {
      const result = await adapter.list({ cursor: "zzzzz" });
      expect(result.files).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });

    it("should return empty result when no files match prefix", async () => {
      const result = await adapter.list({ prefix: "nonexistent/" });
      expect(result.files).toHaveLength(0);
      expect(result.prefixes).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // head
  // ---------------------------------------------------------------------------
  describe("head", () => {
    it("should return file metadata for existing file", async () => {
      await adapter.upload({
        key: "head-test.txt",
        body: "content",
        contentType: "text/plain",
        metadata: { foo: "bar" },
        visibility: "public",
      });

      const file = await adapter.head("head-test.txt");
      expect(file).not.toBeNull();
      expect(file!.key).toBe("head-test.txt");
      expect(file!.size).toBe(new TextEncoder().encode("content").byteLength);
      expect(file!.contentType).toBe("text/plain");
      expect(file!.metadata).toEqual({ foo: "bar" });
      expect(file!.visibility).toBe("public");
      expect(file!.lastModified).toBeInstanceOf(Date);
    });

    it("should return null for missing file", async () => {
      const file = await adapter.head("missing.txt");
      expect(file).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // exists
  // ---------------------------------------------------------------------------
  describe("exists", () => {
    it("should return true for existing file", async () => {
      await adapter.upload({ key: "exists.txt", body: "yes" });
      expect(await adapter.exists("exists.txt")).toBe(true);
    });

    it("should return false for missing file", async () => {
      expect(await adapter.exists("missing.txt")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getUrl
  // ---------------------------------------------------------------------------
  describe("getUrl", () => {
    it("should return memory:// url for existing file", async () => {
      await adapter.upload({ key: "url-test.txt", body: "content" });
      const url = await adapter.getUrl("url-test.txt");
      expect(url).toBe("memory://url-test.txt");
    });

    it("should throw for missing file", async () => {
      expect(adapter.getUrl("missing.txt")).rejects.toThrow("File not found: missing.txt");
    });

    it("should add download param as string filename", async () => {
      await adapter.upload({ key: "docs/report.pdf", body: "pdf" });
      const url = await adapter.getUrl("docs/report.pdf", {
        download: "my-report.pdf",
      });
      expect(url).toBe("memory://docs/report.pdf?download=my-report.pdf");
    });

    it("should add download param as boolean using last path segment", async () => {
      await adapter.upload({ key: "docs/report.pdf", body: "pdf" });
      const url = await adapter.getUrl("docs/report.pdf", { download: true });
      expect(url).toBe("memory://docs/report.pdf?download=report.pdf");
    });
  });

  // ---------------------------------------------------------------------------
  // copy
  // ---------------------------------------------------------------------------
  describe("copy", () => {
    it("should copy a file to new destination", async () => {
      await adapter.upload({
        key: "original.txt",
        body: "original content",
        contentType: "text/plain",
        metadata: { version: "1" },
        visibility: "public",
      });

      const result = await adapter.copy({
        source: "original.txt",
        destination: "copy.txt",
      });

      expect(result.key).toBe("copy.txt");
      expect(result.size).toBe(
        new TextEncoder().encode("original content").byteLength
      );
      expect(result.url).toBe("memory://copy.txt");

      // Original should still exist
      expect(await adapter.exists("original.txt")).toBe(true);
      // Copy should exist
      expect(await adapter.exists("copy.txt")).toBe(true);

      // Verify copy content
      const dl = await adapter.download("copy.txt");
      const reader = dl!.body.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe("original content");

      // Copy should have same metadata
      const head = await adapter.head("copy.txt");
      expect(head!.metadata).toEqual({ version: "1" });
      expect(head!.visibility).toBe("public");
    });

    it("should throw when source does not exist", async () => {
      expect(
        adapter.copy({
          source: "nonexistent.txt",
          destination: "dest.txt",
        })
      ).rejects.toThrow("Source file not found: nonexistent.txt");
    });

    it("should allow overriding metadata on copy", async () => {
      await adapter.upload({
        key: "src.txt",
        body: "content",
        metadata: { a: "1", b: "2" },
      });

      await adapter.copy({
        source: "src.txt",
        destination: "dst.txt",
        metadata: { c: "3" },
      });

      const head = await adapter.head("dst.txt");
      expect(head!.metadata).toEqual({ c: "3" });
    });

    it("should allow overriding visibility on copy", async () => {
      await adapter.upload({
        key: "src.txt",
        body: "content",
        visibility: "private",
      });

      const result = await adapter.copy({
        source: "src.txt",
        destination: "dst.txt",
        visibility: "public",
      });

      expect(result.url).toBe("memory://dst.txt");
      const head = await adapter.head("dst.txt");
      expect(head!.visibility).toBe("public");
    });
  });

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------
  describe("stop", () => {
    it("should not throw", () => {
      adapter.stop();
    });
  });
});

// =============================================================================
// StorageImpl (via createStorage)
// =============================================================================

describe("StorageImpl via createStorage", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage({ provider: "memory" });
  });

  it("should delegate upload/download through the adapter", async () => {
    await storage.upload({ key: "test.txt", body: "hello" });

    const dl = await storage.download("test.txt");
    expect(dl).not.toBeNull();
    const reader = dl!.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("hello");
  });

  it("should return null for download of non-existent key", async () => {
    const dl = await storage.download("nope.txt");
    expect(dl).toBeNull();
  });

  it("should delegate delete", async () => {
    await storage.upload({ key: "del.txt", body: "bye" });
    const deleted = await storage.delete("del.txt");
    expect(deleted).toBe(true);
    expect(await storage.exists("del.txt")).toBe(false);
  });

  it("should delegate deleteMany", async () => {
    await storage.upload({ key: "a.txt", body: "a" });
    await storage.upload({ key: "b.txt", body: "b" });
    const result = await storage.deleteMany(["a.txt", "b.txt", "nope.txt"]);
    expect(result.deleted).toContain("a.txt");
    expect(result.deleted).toContain("b.txt");
  });

  it("should delegate list", async () => {
    await storage.upload({ key: "dir/f1.txt", body: "1" });
    await storage.upload({ key: "dir/f2.txt", body: "2" });
    const result = await storage.list({ prefix: "dir/" });
    expect(result.files.length).toBe(2);
  });

  it("should delegate head", async () => {
    await storage.upload({ key: "h.txt", body: "head-test" });
    const info = await storage.head("h.txt");
    expect(info).not.toBeNull();
    expect(info!.key).toBe("h.txt");
  });

  it("should delegate head (missing)", async () => {
    const info = await storage.head("missing.txt");
    expect(info).toBeNull();
  });

  it("should delegate exists", async () => {
    await storage.upload({ key: "ex.txt", body: "exists" });
    expect(await storage.exists("ex.txt")).toBe(true);
    expect(await storage.exists("nope.txt")).toBe(false);
  });

  it("should delegate getUrl", async () => {
    await storage.upload({ key: "url.txt", body: "url" });
    const url = await storage.getUrl("url.txt");
    expect(url).toContain("url.txt");
  });

  it("should delegate copy", async () => {
    await storage.upload({ key: "orig.txt", body: "copy me" });
    const result = await storage.copy({ source: "orig.txt", destination: "copy.txt" });
    expect(result.key).toBe("copy.txt");
    expect(await storage.exists("copy.txt")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // move (copy + delete)
  // ---------------------------------------------------------------------------
  describe("move", () => {
    it("should move a file (copy + delete source)", async () => {
      await storage.upload({
        key: "src.txt",
        body: "move me",
        contentType: "text/plain",
      });

      const result = await storage.move("src.txt", "dst.txt");
      expect(result.key).toBe("dst.txt");

      // Source should be deleted
      expect(await storage.exists("src.txt")).toBe(false);
      // Destination should exist
      expect(await storage.exists("dst.txt")).toBe(true);

      // Content should be preserved
      const dl = await storage.download("dst.txt");
      const reader = dl!.body.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe("move me");
    });
  });

  // ---------------------------------------------------------------------------
  // createStorage factory
  // ---------------------------------------------------------------------------
  describe("createStorage factory", () => {
    it("should create memory adapter when no config is provided", () => {
      const s = createStorage();
      expect(s).toBeDefined();
      // Verify it works
      s.stop();
    });

    it("should create memory adapter with explicit memory provider", () => {
      const s = createStorage({ provider: "memory" });
      expect(s).toBeDefined();
      s.stop();
    });

    it("should throw for unknown provider", () => {
      expect(() =>
        createStorage({ provider: "unknown" } as any)
      ).toThrow("Unknown storage provider: unknown");
    });
  });

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------
  describe("stop", () => {
    it("should call stop without error", () => {
      storage.stop();
    });
  });
});
