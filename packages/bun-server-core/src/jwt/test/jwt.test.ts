import { describe, expect, it } from "bun:test";
import {
  createAuthToken,
  createAuthTokenGeneric,
  verifyAuthToken,
  verifyAuthTokenGeneric,
} from "../jwt";

const SECRET = "super-secret-token";

describe("jwt helpers", () => {
  it("creates and verifies auth tokens", () => {
    const token = createAuthToken(SECRET, { userId: 42, permissions: ["test:read"] });
    expect(typeof token).toBe("string");

    const payload = verifyAuthToken(SECRET, token);
    expect(payload.userId).toBe(42);
    expect(payload.permissions).toContain("test:read");
  });

  it("supports generic payloads", () => {
    const token = createAuthTokenGeneric(SECRET, { custom: "value" }, "10m");
    const payload = verifyAuthTokenGeneric<{ custom: string }>(SECRET, token);
    expect(payload.custom).toBe("value");
  });

  it("throws when token is invalid", () => {
    const token = createAuthToken(SECRET, { userId: 1, permissions: [] });
    expect(() => verifyAuthToken("different-secret", token)).toThrow();
  });
});
