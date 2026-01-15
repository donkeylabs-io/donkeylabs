import { describe, it, expect } from "bun:test";
import { PingModel } from "../models/model";
import { Input } from "../schema";

describe("health/ping model", () => {
  it("returns ok status", () => {
    const input = Input.parse({});
    const ctx = {} as any;
    const model = new PingModel(ctx);
    const result = model.handle(input);
    expect(result.status).toBe("ok");
  });

  it("echoes input", () => {
    const input = Input.parse({ echo: "hello" });
    const ctx = {} as any;
    const model = new PingModel(ctx);
    const result = model.handle(input);
    expect(result.echo).toBe("hello");
  });
});
