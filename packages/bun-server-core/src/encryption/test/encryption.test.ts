import { describe, expect, it } from "bun:test";
import { decryptData, encryptData } from "../encryption";

const VALID_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("encryption helpers", () => {
  it("round-trips encrypted data with the same key", () => {
    const secret = "sensitive payload";
    const encrypted = encryptData(VALID_KEY, secret);
    expect(typeof encrypted).toBe("string");
    const decrypted = decryptData(VALID_KEY, encrypted);
    expect(decrypted).toBe(secret);
  });

  it("returns empty string when decryption fails", () => {
    const encrypted = encryptData(VALID_KEY, "data");
    const wrongKey =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const decrypted = decryptData(wrongKey, encrypted);
    expect(decrypted).toBe("");
  });

  it("throws when key length is invalid", () => {
    expect(() => encryptData("1234", "payload")).toThrow();
    expect(decryptData("abcd", "abcdef:1234")).toBe("");
  });
});
