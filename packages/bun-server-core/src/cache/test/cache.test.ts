import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { SimpleCache } from "../index";

let cache: SimpleCache;

beforeEach(async () => {
  cache = await SimpleCache.newSimpleInstance({ dbFile: undefined });
  await cache.clear();
});

afterAll(async () => {
  await cache.clear();
});

describe("SimpleCache", () => {
  it("stores and retrieves values", async () => {
    await cache.set("key", { hello: "world" }, 10);
    const value = await cache.get<{ hello: string }>("key");
    expect(value).toEqual({ hello: "world" });
  });

  it("deletes values", async () => {
    await cache.set("remove", 1, 10);
    await cache.delete("remove");
    expect(await cache.get("remove")).toBeUndefined();
  });

  it("respects ttl expiry", async () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 1000;
      await cache.set("ttl", "value", 1); // ttl in seconds

      Date.now = () => 2500; // move past ttl
      expect(await cache.get("ttl")).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });
});
