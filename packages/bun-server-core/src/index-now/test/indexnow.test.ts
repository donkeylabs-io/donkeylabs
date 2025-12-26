import { describe, expect, it } from "bun:test";
import { IndexNowAPI } from "../index";

const ORIGINAL_STAGE = Bun.env.STAGE;

describe("IndexNowAPI", () => {
  it("skips submissions when not in production", async () => {
    Bun.env.STAGE = "dev";
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error("fetch should not be called in non-prod");
    }) as unknown as typeof fetch;

    const api = new IndexNowAPI("key", "example.com");
    await api.submitURL(["https://example.com/page"]);

    expect(called).toBeFalse();
    globalThis.fetch = originalFetch;
  });

  it("submits urls when STAGE=prod", async () => {
    Bun.env.STAGE = "prod";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const api = new IndexNowAPI("key", "example.com");
    const result = await api.submitURL(["https://example.com/page"]);
    expect(result).toEqual({ success: true });

    globalThis.fetch = originalFetch;
    Bun.env.STAGE = ORIGINAL_STAGE;
  });
});
