import { describe, it, expect } from "bun:test";
import {
  parseSemVer,
  compareSemVer,
  satisfies,
  resolveVersion,
  type SemVer,
} from "../src/versioning";

describe("versioning", () => {
  describe("parseSemVer", () => {
    it("parses full semver", () => {
      const v = parseSemVer("2.1.3");
      expect(v).toEqual({ major: 2, minor: 1, patch: 3, raw: "2.1.3" });
    });

    it("parses with leading v", () => {
      const v = parseSemVer("v2.1.3");
      expect(v).toEqual({ major: 2, minor: 1, patch: 3, raw: "2.1.3" });
    });

    it("parses major.minor (patch defaults to 0)", () => {
      const v = parseSemVer("2.1");
      expect(v).toEqual({ major: 2, minor: 1, patch: 0, raw: "2.1.0" });
    });

    it("parses major only (minor/patch default to 0)", () => {
      const v = parseSemVer("3");
      expect(v).toEqual({ major: 3, minor: 0, patch: 0, raw: "3.0.0" });
    });

    it("returns null for empty string", () => {
      expect(parseSemVer("")).toBeNull();
    });

    it("returns null for invalid input", () => {
      expect(parseSemVer("abc")).toBeNull();
      expect(parseSemVer("1.2.3.4")).toBeNull();
      expect(parseSemVer("-1.0.0")).toBeNull();
    });

    it("trims whitespace", () => {
      const v = parseSemVer("  1.0.0  ");
      expect(v).toEqual({ major: 1, minor: 0, patch: 0, raw: "1.0.0" });
    });
  });

  describe("compareSemVer", () => {
    it("compares equal versions", () => {
      const a = parseSemVer("1.2.3")!;
      const b = parseSemVer("1.2.3")!;
      expect(compareSemVer(a, b)).toBe(0);
    });

    it("compares major versions", () => {
      const a = parseSemVer("2.0.0")!;
      const b = parseSemVer("1.0.0")!;
      expect(compareSemVer(a, b)).toBeGreaterThan(0);
      expect(compareSemVer(b, a)).toBeLessThan(0);
    });

    it("compares minor versions", () => {
      const a = parseSemVer("1.2.0")!;
      const b = parseSemVer("1.1.0")!;
      expect(compareSemVer(a, b)).toBeGreaterThan(0);
    });

    it("compares patch versions", () => {
      const a = parseSemVer("1.0.2")!;
      const b = parseSemVer("1.0.1")!;
      expect(compareSemVer(a, b)).toBeGreaterThan(0);
    });
  });

  describe("satisfies", () => {
    const v210 = parseSemVer("2.1.0")!;
    const v200 = parseSemVer("2.0.0")!;
    const v100 = parseSemVer("1.0.0")!;

    it("matches major only", () => {
      expect(satisfies(v210, "2")).toBe(true);
      expect(satisfies(v200, "2")).toBe(true);
      expect(satisfies(v100, "2")).toBe(false);
    });

    it("matches major.minor", () => {
      expect(satisfies(v210, "2.1")).toBe(true);
      expect(satisfies(v200, "2.1")).toBe(false);
      expect(satisfies(v200, "2.0")).toBe(true);
    });

    it("matches exact version", () => {
      expect(satisfies(v210, "2.1.0")).toBe(true);
      expect(satisfies(v210, "2.1.1")).toBe(false);
    });

    it("matches wildcard minor", () => {
      expect(satisfies(v210, "2.x")).toBe(true);
      expect(satisfies(v210, "2.*")).toBe(true);
      expect(satisfies(v100, "2.x")).toBe(false);
    });

    it("matches wildcard patch", () => {
      expect(satisfies(v210, "2.1.x")).toBe(true);
      expect(satisfies(v210, "2.1.*")).toBe(true);
      expect(satisfies(v210, "2.0.x")).toBe(false);
    });

    it("matches with v prefix", () => {
      expect(satisfies(v210, "v2")).toBe(true);
      expect(satisfies(v210, "v2.1.0")).toBe(true);
    });
  });

  describe("resolveVersion", () => {
    const versions: SemVer[] = [
      parseSemVer("1.0.0")!,
      parseSemVer("1.1.0")!,
      parseSemVer("2.0.0")!,
      parseSemVer("2.1.0")!,
      parseSemVer("2.1.5")!,
      parseSemVer("3.0.0")!,
    ];

    it("resolves major request to highest matching", () => {
      const v = resolveVersion(versions, "2");
      expect(v?.raw).toBe("2.1.5");
    });

    it("resolves major.minor to highest matching patch", () => {
      const v = resolveVersion(versions, "2.1");
      expect(v?.raw).toBe("2.1.5");
    });

    it("resolves exact version", () => {
      const v = resolveVersion(versions, "2.1.0");
      expect(v?.raw).toBe("2.1.0");
    });

    it("resolves wildcard", () => {
      const v = resolveVersion(versions, "1.x");
      expect(v?.raw).toBe("1.1.0");
    });

    it("returns null for non-matching", () => {
      const v = resolveVersion(versions, "4");
      expect(v).toBeNull();
    });

    it("returns null for empty versions list", () => {
      const v = resolveVersion([], "1");
      expect(v).toBeNull();
    });

    it("handles unsorted input", () => {
      const unsorted: SemVer[] = [
        parseSemVer("1.0.0")!,
        parseSemVer("3.0.0")!,
        parseSemVer("2.0.0")!,
      ];
      const v = resolveVersion(unsorted, "2");
      expect(v?.raw).toBe("2.0.0");
    });
  });
});
