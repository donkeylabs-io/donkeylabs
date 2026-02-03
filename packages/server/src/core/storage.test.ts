import { describe, it, expect } from "bun:test";
import { createStorage, MemoryStorageAdapter } from "./storage";

describe("Storage Service", () => {
  describe("MemoryStorageAdapter", () => {
    it("should upload and download a file", async () => {
      const storage = createStorage({ provider: "memory" });

      const result = await storage.upload({
        key: "test/hello.txt",
        body: "Hello, World!",
        contentType: "text/plain",
        visibility: "public",
      });

      expect(result.key).toBe("test/hello.txt");
      expect(result.size).toBe(13);
      expect(result.url).toBe("memory://test/hello.txt");

      const downloaded = await storage.download("test/hello.txt");
      expect(downloaded).not.toBeNull();
      expect(downloaded!.contentType).toBe("text/plain");

      // Read stream content
      const reader = downloaded!.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toBe("Hello, World!");
    });

    it("should return null for non-existent file", async () => {
      const storage = createStorage({ provider: "memory" });
      const result = await storage.download("nonexistent.txt");
      expect(result).toBeNull();
    });

    it("should check file existence", async () => {
      const storage = createStorage({ provider: "memory" });

      await storage.upload({
        key: "exists.txt",
        body: "test",
      });

      expect(await storage.exists("exists.txt")).toBe(true);
      expect(await storage.exists("doesnt-exist.txt")).toBe(false);
    });

    it("should delete a file", async () => {
      const storage = createStorage({ provider: "memory" });

      await storage.upload({
        key: "to-delete.txt",
        body: "delete me",
      });

      expect(await storage.delete("to-delete.txt")).toBe(true);
      expect(await storage.exists("to-delete.txt")).toBe(false);
      expect(await storage.delete("to-delete.txt")).toBe(false); // Already deleted
    });

    it("should list files with prefix", async () => {
      const storage = createStorage({ provider: "memory" });

      await storage.upload({ key: "users/1/avatar.png", body: "img" });
      await storage.upload({ key: "users/1/banner.png", body: "img" });
      await storage.upload({ key: "users/2/avatar.png", body: "img" });
      await storage.upload({ key: "products/1.jpg", body: "img" });

      const usersResult = await storage.list({ prefix: "users/" });
      expect(usersResult.files.length).toBe(3);

      const user1Result = await storage.list({ prefix: "users/1/" });
      expect(user1Result.files.length).toBe(2);

      const allResult = await storage.list();
      expect(allResult.files.length).toBe(4);
    });

    it("should list with delimiter for directory-like listing", async () => {
      const storage = createStorage({ provider: "memory" });

      await storage.upload({ key: "a/1.txt", body: "a" });
      await storage.upload({ key: "a/2.txt", body: "a" });
      await storage.upload({ key: "b/1.txt", body: "b" });
      await storage.upload({ key: "root.txt", body: "root" });

      const result = await storage.list({ delimiter: "/" });
      expect(result.files.length).toBe(1); // root.txt only
      expect(result.files[0].key).toBe("root.txt");
      expect(result.prefixes).toContain("a/");
      expect(result.prefixes).toContain("b/");
    });

    it("should get file metadata with head", async () => {
      const storage = createStorage({ provider: "memory" });

      await storage.upload({
        key: "meta-test.txt",
        body: "Hello",
        contentType: "text/plain",
        metadata: { author: "test" },
        visibility: "private",
      });

      const head = await storage.head("meta-test.txt");
      expect(head).not.toBeNull();
      expect(head!.key).toBe("meta-test.txt");
      expect(head!.size).toBe(5);
      expect(head!.contentType).toBe("text/plain");
      expect(head!.metadata).toEqual({ author: "test" });
      expect(head!.visibility).toBe("private");
    });

    it("should copy a file", async () => {
      const storage = createStorage({ provider: "memory" });

      await storage.upload({
        key: "original.txt",
        body: "Original content",
        contentType: "text/plain",
      });

      const result = await storage.copy({
        source: "original.txt",
        destination: "copy.txt",
      });

      expect(result.key).toBe("copy.txt");
      expect(await storage.exists("original.txt")).toBe(true);
      expect(await storage.exists("copy.txt")).toBe(true);
    });

    it("should move a file", async () => {
      const storage = createStorage({ provider: "memory" });

      await storage.upload({
        key: "to-move.txt",
        body: "Moving",
      });

      const result = await storage.move("to-move.txt", "moved.txt");

      expect(result.key).toBe("moved.txt");
      expect(await storage.exists("to-move.txt")).toBe(false);
      expect(await storage.exists("moved.txt")).toBe(true);
    });

    it("should delete multiple files", async () => {
      const storage = createStorage({ provider: "memory" });

      await storage.upload({ key: "batch/1.txt", body: "1" });
      await storage.upload({ key: "batch/2.txt", body: "2" });
      await storage.upload({ key: "batch/3.txt", body: "3" });

      const result = await storage.deleteMany([
        "batch/1.txt",
        "batch/2.txt",
        "batch/nonexistent.txt",
      ]);

      expect(result.deleted).toContain("batch/1.txt");
      expect(result.deleted).toContain("batch/2.txt");
      expect(result.errors).toContain("batch/nonexistent.txt");
      expect(await storage.exists("batch/3.txt")).toBe(true);
    });

    it("should handle pagination", async () => {
      const storage = createStorage({ provider: "memory" });

      // Create 10 files
      for (let i = 0; i < 10; i++) {
        await storage.upload({ key: `page/${i}.txt`, body: String(i) });
      }

      // Get first page
      const page1 = await storage.list({ prefix: "page/", limit: 3 });
      expect(page1.files.length).toBe(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).not.toBeNull();

      // Get second page
      const page2 = await storage.list({
        prefix: "page/",
        limit: 3,
        cursor: page1.cursor!,
      });
      expect(page2.files.length).toBe(3);
      expect(page2.hasMore).toBe(true);

      // Ensure no duplicates
      const page1Keys = page1.files.map((f) => f.key);
      const page2Keys = page2.files.map((f) => f.key);
      expect(page1Keys.some((k) => page2Keys.includes(k))).toBe(false);
    });
  });
});
