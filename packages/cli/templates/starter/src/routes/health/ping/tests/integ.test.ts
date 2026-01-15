import { describe, it, expect } from "bun:test";
import type { Output } from "../models/model";

const BASE_URL = "http://localhost:3000";

describe("health/ping integration", () => {
  // Note: Server must be running for integration tests
  // Run with: bun run dev & bun test src/routes/health/ping/tests/integ.test.ts

  it("POST /health.ping returns ok", async () => {
    const res = await fetch(`${BASE_URL}/health.ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as Output;
    expect(data.status).toBe("ok");
  });
});
