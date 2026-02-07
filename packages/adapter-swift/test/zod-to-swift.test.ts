import { describe, it, expect } from "bun:test";
import { zodToSwift, type SwiftTypeContext } from "../src/generator/zod-to-swift";

function convert(source: string, typeName?: string) {
  const ctx: SwiftTypeContext = {
    namespace: "Test",
    declarations: [],
    currentTypeName: typeName || "TestType",
  };
  return zodToSwift(source, ctx);
}

describe("zodToSwift - simple types", () => {
  it("maps z.string() to String", () => {
    expect(convert("z.string()").inlineType).toBe("String");
  });

  it("maps z.number() to Double", () => {
    expect(convert("z.number()").inlineType).toBe("Double");
  });

  it("maps z.boolean() to Bool", () => {
    expect(convert("z.boolean()").inlineType).toBe("Bool");
  });

  it("maps z.date() to Date", () => {
    expect(convert("z.date()").inlineType).toBe("Date");
  });

  it("maps z.any() to AnyCodable", () => {
    expect(convert("z.any()").inlineType).toBe("AnyCodable");
  });

  it("maps z.unknown() to AnyCodable", () => {
    expect(convert("z.unknown()").inlineType).toBe("AnyCodable");
  });

  it("maps z.bigint() to Int64", () => {
    expect(convert("z.bigint()").inlineType).toBe("Int64");
  });

  it("maps z.never() to Never", () => {
    expect(convert("z.never()").inlineType).toBe("Never");
  });

  it("maps empty source to AnyCodable", () => {
    expect(convert("").inlineType).toBe("AnyCodable");
  });
});

describe("zodToSwift - optional/nullable", () => {
  it("makes .optional() types optional", () => {
    expect(convert("z.string().optional()").inlineType).toBe("String?");
  });

  it("makes .nullable() types optional", () => {
    expect(convert("z.number().nullable()").inlineType).toBe("Double?");
  });
});

describe("zodToSwift - refinements", () => {
  it("z.string() with refinements stays String", () => {
    expect(convert("z.string().email()").inlineType).toBe("String");
  });

  it("z.number() with refinements stays Double", () => {
    expect(convert("z.number().min(0).max(100)").inlineType).toBe("Double");
  });
});

describe("zodToSwift - z.object()", () => {
  it("generates a Codable struct for z.object()", () => {
    const result = convert(
      'z.object({ name: z.string(), age: z.number() })',
      "User"
    );
    expect(result.inlineType).toBe("User");
    expect(result.auxiliaryDeclarations).toHaveLength(1);
    const decl = result.auxiliaryDeclarations[0]!;
    expect(decl.name).toBe("User");
    expect(decl.code).toContain("public struct User: Codable, Sendable");
    expect(decl.code).toContain("public let name: String");
    expect(decl.code).toContain("public let age: Double");
  });

  it("handles optional properties", () => {
    const result = convert(
      'z.object({ email: z.string().optional() })',
      "Profile"
    );
    const decl = result.auxiliaryDeclarations[0]!;
    expect(decl.code).toContain("email: String?");
  });

  it("handles empty object", () => {
    const result = convert("z.object({})", "EmptyObj");
    expect(result.auxiliaryDeclarations).toHaveLength(1);
    expect(result.auxiliaryDeclarations[0]!.code).toContain("public struct EmptyObj: Codable, Sendable {}");
  });
});

describe("zodToSwift - z.array()", () => {
  it("generates array type", () => {
    const result = convert("z.array(z.string())", "Tags");
    expect(result.inlineType).toBe("[String]");
  });

  it("generates array of objects", () => {
    const result = convert(
      'z.array(z.object({ id: z.string() }))',
      "Items"
    );
    expect(result.inlineType).toBe("[ItemsItem]");
    expect(result.auxiliaryDeclarations.length).toBeGreaterThan(0);
  });
});

describe("zodToSwift - z.enum()", () => {
  it("generates a String enum", () => {
    const result = convert(
      'z.enum(["active", "inactive", "banned"])',
      "Status"
    );
    expect(result.inlineType).toBe("Status");
    const decl = result.auxiliaryDeclarations[0]!;
    expect(decl.code).toContain("public enum Status: String, Codable, Sendable");
    expect(decl.code).toContain("case active");
    expect(decl.code).toContain("case inactive");
    expect(decl.code).toContain("case banned");
  });
});

describe("zodToSwift - z.union()", () => {
  it("literal union becomes a simple enum", () => {
    const result = convert(
      'z.union([z.literal("a"), z.literal("b")])',
      "Choice"
    );
    expect(result.inlineType).toBe("Choice");
    const decl = result.auxiliaryDeclarations[0]!;
    expect(decl.code).toContain("public enum Choice: String, Codable, Sendable");
    expect(decl.code).toContain("case a");
    expect(decl.code).toContain("case b");
  });

  it("mixed union becomes enum with associated values", () => {
    const result = convert(
      "z.union([z.string(), z.number()])",
      "Mixed"
    );
    expect(result.inlineType).toBe("Mixed");
    const decl = result.auxiliaryDeclarations[0]!;
    expect(decl.code).toContain("public enum Mixed: Codable, Sendable");
    expect(decl.code).toContain("case variant0(String)");
    expect(decl.code).toContain("case variant1(Double)");
  });
});

describe("zodToSwift - z.record()", () => {
  it("generates dictionary type with two args", () => {
    const result = convert("z.record(z.string(), z.number())", "Scores");
    expect(result.inlineType).toBe("[String: Double]");
  });

  it("generates dictionary type with single arg", () => {
    const result = convert("z.record(z.boolean())", "Flags");
    expect(result.inlineType).toBe("[String: Bool]");
  });
});

describe("zodToSwift - z.tuple()", () => {
  it("generates a struct with _0, _1 fields", () => {
    const result = convert(
      "z.tuple([z.string(), z.number()])",
      "Pair"
    );
    expect(result.inlineType).toBe("Pair");
    const decl = result.auxiliaryDeclarations[0]!;
    expect(decl.code).toContain("public struct Pair: Codable, Sendable");
    expect(decl.code).toContain("public let _0: String");
    expect(decl.code).toContain("public let _1: Double");
  });
});

describe("zodToSwift - z.literal()", () => {
  it("string literal maps to String", () => {
    expect(convert('z.literal("hello")').inlineType).toBe("String");
  });

  it("number literal maps to Int", () => {
    expect(convert("z.literal(42)").inlineType).toBe("Int");
  });

  it("float literal maps to Double", () => {
    expect(convert("z.literal(3.14)").inlineType).toBe("Double");
  });

  it("boolean literal maps to Bool", () => {
    expect(convert("z.literal(true)").inlineType).toBe("Bool");
  });
});
