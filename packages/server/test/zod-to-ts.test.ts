import { describe, it, expect } from "bun:test";
import { zodSchemaToTs } from "../src/generator/zod-to-ts";
import { z } from "zod";

describe("zodSchemaToTs", () => {
  // Primitives
  it("should convert ZodString to 'string'", () => {
    expect(zodSchemaToTs(z.string())).toBe("string");
  });

  it("should convert ZodNumber to 'number'", () => {
    expect(zodSchemaToTs(z.number())).toBe("number");
  });

  it("should convert ZodBoolean to 'boolean'", () => {
    expect(zodSchemaToTs(z.boolean())).toBe("boolean");
  });

  it("should convert ZodDate to 'Date'", () => {
    expect(zodSchemaToTs(z.date())).toBe("Date");
  });

  it("should convert ZodUndefined to 'undefined'", () => {
    expect(zodSchemaToTs(z.undefined())).toBe("undefined");
  });

  it("should convert ZodNull to 'null'", () => {
    expect(zodSchemaToTs(z.null())).toBe("null");
  });

  it("should convert ZodAny to 'any'", () => {
    expect(zodSchemaToTs(z.any())).toBe("any");
  });

  it("should convert ZodUnknown to 'unknown'", () => {
    expect(zodSchemaToTs(z.unknown())).toBe("unknown");
  });

  it("should convert ZodVoid to 'void'", () => {
    expect(zodSchemaToTs(z.void())).toBe("void");
  });

  it("should convert ZodNever to 'never'", () => {
    expect(zodSchemaToTs(z.never())).toBe("never");
  });

  // Literal
  it("should convert string literal", () => {
    expect(zodSchemaToTs(z.literal("hello"))).toBe('"hello"');
  });

  it("should convert number literal", () => {
    expect(zodSchemaToTs(z.literal(42))).toBe("42");
  });

  it("should convert boolean literal", () => {
    expect(zodSchemaToTs(z.literal(true))).toBe("true");
  });

  // Array
  it("should convert ZodArray", () => {
    expect(zodSchemaToTs(z.array(z.string()))).toBe("string[]");
  });

  it("should convert nested array", () => {
    expect(zodSchemaToTs(z.array(z.array(z.number())))).toBe("number[][]");
  });

  // Object
  it("should convert ZodObject", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = zodSchemaToTs(schema);
    expect(result).toContain("name: string;");
    expect(result).toContain("age: number;");
  });

  it("should mark optional fields with ?", () => {
    const schema = z.object({ name: z.string(), email: z.string().optional() });
    const result = zodSchemaToTs(schema);
    expect(result).toContain("name: string;");
    expect(result).toContain("email?: string;");
  });

  // Optional
  it("should convert ZodOptional standalone", () => {
    expect(zodSchemaToTs(z.string().optional())).toBe("string");
  });

  // Nullable
  it("should convert ZodNullable", () => {
    expect(zodSchemaToTs(z.string().nullable())).toBe("string | null");
  });

  // Default
  it("should convert ZodDefault (unwrap to inner type)", () => {
    expect(zodSchemaToTs(z.string().default("hello"))).toBe("string");
  });

  // Union
  it("should convert ZodUnion", () => {
    const result = zodSchemaToTs(z.union([z.string(), z.number()]));
    expect(result).toBe("string | number");
  });

  // Enum
  it("should convert ZodEnum", () => {
    const result = zodSchemaToTs(z.enum(["active", "inactive", "pending"]));
    expect(result).toBe('"active" | "inactive" | "pending"');
  });

  // NativeEnum
  it("should convert ZodNativeEnum", () => {
    enum Status { Active, Inactive }
    expect(zodSchemaToTs(z.nativeEnum(Status))).toBe("number | string");
  });

  // Record
  it("should convert ZodRecord with default string key", () => {
    expect(zodSchemaToTs(z.record(z.number()))).toBe("Record<string, number>");
  });

  it("should convert ZodRecord with explicit key type", () => {
    expect(zodSchemaToTs(z.record(z.string(), z.boolean()))).toBe("Record<string, boolean>");
  });

  // Tuple
  it("should convert ZodTuple", () => {
    const result = zodSchemaToTs(z.tuple([z.string(), z.number(), z.boolean()]));
    expect(result).toBe("[string, number, boolean]");
  });

  // Promise
  it("should convert ZodPromise", () => {
    expect(zodSchemaToTs(z.promise(z.string()))).toBe("Promise<string>");
  });

  // Effects (transform/refine)
  it("should convert ZodEffects (transform)", () => {
    const schema = z.string().transform((s) => s.length);
    expect(zodSchemaToTs(schema)).toBe("string");
  });

  it("should convert ZodEffects (refine)", () => {
    const schema = z.number().refine((n) => n > 0);
    expect(zodSchemaToTs(schema)).toBe("number");
  });

  // Lazy
  it("should convert ZodLazy", () => {
    const schema = z.lazy(() => z.string());
    expect(zodSchemaToTs(schema)).toBe("string");
  });

  // Intersection
  it("should convert ZodIntersection", () => {
    const a = z.object({ name: z.string() });
    const b = z.object({ age: z.number() });
    const result = zodSchemaToTs(z.intersection(a, b));
    expect(result).toContain("&");
    expect(result).toContain("name: string;");
    expect(result).toContain("age: number;");
  });

  // Unknown/fallback
  it("should return 'unknown' for unrecognized schema types", () => {
    // Create a mock schema with unknown typeName
    const fakeSchema = { _def: { typeName: "ZodFooBar" } } as any;
    expect(zodSchemaToTs(fakeSchema)).toBe("unknown");
  });
});
