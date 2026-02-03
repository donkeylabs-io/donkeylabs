import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createStorage } from "./storage";

const TEST_DIR = "/tmp/donkeylabs-storage-test";

describe("LocalStorageAdapter", () => {
  beforeEach(async () => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  it("should upload and download a file", async () => {
    const storage = createStorage({
      provider: "local",
      directory: TEST_DIR,
      baseUrl: "/files",
    });

    const result = await storage.upload({
      key: "test/hello.txt",
      body: "Hello, Local Storage!",
      contentType: "text/plain",
      visibility: "public",
    });

    expect(result.key).toBe("test/hello.txt");
    expect(result.size).toBe(21);
    expect(result.url).toBe("/files/test/hello.txt");

    // Verify file exists on disk
    const filePath = join(TEST_DIR, "test/hello.txt");
    expect(existsSync(filePath)).toBe(true);
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("Hello, Local Storage!");

    // Download the file
    const downloaded = await storage.download("test/hello.txt");
    expect(downloaded).not.toBeNull();

    const reader = downloaded!.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    expect(text).toBe("Hello, Local Storage!");
  });

  it("should store and retrieve metadata", async () => {
    const storage = createStorage({
      provider: "local",
      directory: TEST_DIR,
    });

    await storage.upload({
      key: "with-meta.txt",
      body: "test",
      contentType: "text/plain",
      metadata: { author: "tester", version: "1.0" },
      visibility: "private",
    });

    const head = await storage.head("with-meta.txt");
    expect(head).not.toBeNull();
    expect(head!.contentType).toBe("text/plain");
    expect(head!.metadata).toEqual({ author: "tester", version: "1.0" });
    expect(head!.visibility).toBe("private");

    // Verify metadata file exists
    const metaPath = join(TEST_DIR, ".with-meta.txt.meta.json");
    expect(existsSync(metaPath)).toBe(true);
  });

  it("should delete files and metadata", async () => {
    const storage = createStorage({
      provider: "local",
      directory: TEST_DIR,
    });

    await storage.upload({
      key: "to-delete.txt",
      body: "delete me",
      metadata: { temp: "true" },
    });

    const filePath = join(TEST_DIR, "to-delete.txt");
    const metaPath = join(TEST_DIR, ".to-delete.txt.meta.json");

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);

    await storage.delete("to-delete.txt");

    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(metaPath)).toBe(false);
  });

  it("should list files", async () => {
    const storage = createStorage({
      provider: "local",
      directory: TEST_DIR,
    });

    await storage.upload({ key: "a/1.txt", body: "a1" });
    await storage.upload({ key: "a/2.txt", body: "a2" });
    await storage.upload({ key: "b/1.txt", body: "b1" });
    await storage.upload({ key: "root.txt", body: "root" });

    const allFiles = await storage.list();
    // Filter out metadata files from count
    const dataFiles = allFiles.files.filter((f) => !f.key.includes(".meta.json"));
    expect(dataFiles.length).toBe(4);
  });

  it("should copy files", async () => {
    const storage = createStorage({
      provider: "local",
      directory: TEST_DIR,
    });

    await storage.upload({
      key: "original.txt",
      body: "Original",
      contentType: "text/plain",
    });

    await storage.copy({
      source: "original.txt",
      destination: "copy.txt",
    });

    expect(existsSync(join(TEST_DIR, "original.txt"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "copy.txt"))).toBe(true);

    const copyContent = await readFile(join(TEST_DIR, "copy.txt"), "utf-8");
    expect(copyContent).toBe("Original");
  });

  it("should move files", async () => {
    const storage = createStorage({
      provider: "local",
      directory: TEST_DIR,
    });

    await storage.upload({
      key: "to-move.txt",
      body: "Moving",
    });

    await storage.move("to-move.txt", "moved.txt");

    expect(existsSync(join(TEST_DIR, "to-move.txt"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "moved.txt"))).toBe(true);
  });

  it("should handle various body types", async () => {
    const storage = createStorage({
      provider: "local",
      directory: TEST_DIR,
    });

    // String body
    await storage.upload({
      key: "string.txt",
      body: "string content",
    });

    // Buffer body
    await storage.upload({
      key: "buffer.txt",
      body: Buffer.from("buffer content"),
    });

    // Uint8Array body
    await storage.upload({
      key: "uint8.txt",
      body: new TextEncoder().encode("uint8 content"),
    });

    expect(await readFile(join(TEST_DIR, "string.txt"), "utf-8")).toBe("string content");
    expect(await readFile(join(TEST_DIR, "buffer.txt"), "utf-8")).toBe("buffer content");
    expect(await readFile(join(TEST_DIR, "uint8.txt"), "utf-8")).toBe("uint8 content");
  });
});
