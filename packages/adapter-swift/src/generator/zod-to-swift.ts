/**
 * Zod source string -> Swift type converter
 *
 * Parses Zod schema source strings (not runtime schemas) and converts
 * them to Swift type representations with auxiliary struct/enum declarations.
 */

import {
  splitTopLevel,
  extractParenContent,
  toPascalCase,
} from "@donkeylabs/server/generator";

// ==========================================
// Types
// ==========================================

export interface SwiftDeclaration {
  name: string;
  code: string;
}

export interface SwiftTypeContext {
  namespace: string;
  declarations: SwiftDeclaration[];
  currentTypeName?: string;
}

export interface ZodToSwiftResult {
  inlineType: string;
  auxiliaryDeclarations: SwiftDeclaration[];
}

// ==========================================
// Main Converter
// ==========================================

/**
 * Convert a Zod source string to a Swift type.
 *
 * Returns the inline type name (e.g. "String", "[UserItem]", "CreateInput")
 * and any auxiliary declarations (structs, enums) needed.
 */
export function zodToSwift(
  zodSource: string,
  context: SwiftTypeContext
): ZodToSwiftResult {
  if (!zodSource) {
    return { inlineType: "AnyCodable", auxiliaryDeclarations: [] };
  }

  const auxiliaryDeclarations: SwiftDeclaration[] = [];

  const inlineType = convertZodSource(zodSource.trim(), context, auxiliaryDeclarations);

  return { inlineType, auxiliaryDeclarations };
}

// ==========================================
// Internal Conversion
// ==========================================

const SIMPLE_TYPE_MAP: Record<string, string> = {
  "z.string()": "String",
  "z.number()": "Double",
  "z.boolean()": "Bool",
  "z.date()": "Date",
  "z.any()": "AnyCodable",
  "z.unknown()": "AnyCodable",
  "z.null()": "AnyCodable",
  "z.undefined()": "AnyCodable",
  "z.void()": "AnyCodable",
  "z.never()": "Never",
  "z.bigint()": "Int64",
};

function convertZodSource(
  source: string,
  context: SwiftTypeContext,
  declarations: SwiftDeclaration[]
): string {
  // Check simple type map first
  if (SIMPLE_TYPE_MAP[source]) {
    return SIMPLE_TYPE_MAP[source];
  }

  let inner = source;
  let optional = false;

  // Handle .optional() / .nullable() suffix
  if (inner.endsWith(".optional()")) {
    inner = inner.slice(0, -".optional()".length);
    optional = true;
  } else if (inner.endsWith(".nullable()")) {
    inner = inner.slice(0, -".nullable()".length);
    optional = true;
  }

  // Check simple map again after stripping modifiers
  if (SIMPLE_TYPE_MAP[inner]) {
    const base = SIMPLE_TYPE_MAP[inner];
    return optional ? `${base}?` : base;
  }

  let result: string;

  // z.object({...})
  if (inner.startsWith("z.object(")) {
    result = convertObject(inner, context, declarations);
  }
  // z.array(...)
  else if (inner.startsWith("z.array(")) {
    result = convertArray(inner, context, declarations);
  }
  // z.enum([...])
  else if (inner.startsWith("z.enum(")) {
    result = convertEnum(inner, context, declarations);
  }
  // z.union([...])
  else if (inner.startsWith("z.union(")) {
    result = convertUnion(inner, context, declarations);
  }
  // z.record(...)
  else if (inner.startsWith("z.record(")) {
    result = convertRecord(inner, context, declarations);
  }
  // z.tuple([...])
  else if (inner.startsWith("z.tuple(")) {
    result = convertTuple(inner, context, declarations);
  }
  // z.literal(...)
  else if (inner.startsWith("z.literal(")) {
    result = convertLiteral(inner, context, declarations);
  }
  // z.string() with refinements (e.g. z.string().email())
  else if (inner.startsWith("z.string()")) {
    result = "String";
  }
  // z.number() with refinements (e.g. z.number().min(0))
  else if (inner.startsWith("z.number()")) {
    result = "Double";
  }
  // z.boolean() with refinements
  else if (inner.startsWith("z.boolean()")) {
    result = "Bool";
  }
  // z.bigint() with refinements
  else if (inner.startsWith("z.bigint()")) {
    result = "Int64";
  }
  // Fallback
  else {
    result = "AnyCodable";
  }

  return optional ? `${result}?` : result;
}

// ==========================================
// z.object({...}) -> struct
// ==========================================

function convertObject(
  source: string,
  context: SwiftTypeContext,
  declarations: SwiftDeclaration[]
): string {
  const innerContent = extractParenContent(source, 8);
  const trimmed = innerContent.trim();

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return "AnyCodable";
  }

  const propsSource = trimmed.slice(1, -1).trim();
  if (!propsSource) {
    // Empty object
    const typeName = context.currentTypeName || "EmptyObject";
    declarations.push({
      name: typeName,
      code: `public struct ${typeName}: Codable, Sendable {}`,
    });
    return typeName;
  }

  const entries = splitTopLevel(propsSource, ",");
  const typeName = context.currentTypeName || `${context.namespace}Object`;

  const properties: string[] = [];
  const codingKeys: string[] = [];
  let needsCodingKeys = false;

  for (const entry of entries) {
    const colonIndex = entry.indexOf(":");
    if (colonIndex === -1) continue;

    const rawName = entry.slice(0, colonIndex).trim();
    let schema = entry.slice(colonIndex + 1).trim();

    let isOptional = false;
    if (schema.endsWith(".optional()")) {
      schema = schema.slice(0, -".optional()".length);
      isOptional = true;
    }

    // Swift property name (camelCase, safe)
    const swiftName = toSwiftPropertyName(rawName);
    if (swiftName !== rawName) {
      needsCodingKeys = true;
    }

    // Recursively convert the property type
    const propContext: SwiftTypeContext = {
      namespace: context.namespace,
      declarations: [],
      currentTypeName: `${typeName}${toPascalCase(rawName)}`,
    };
    const propType = convertZodSource(schema, propContext, declarations);

    const optionalSuffix = isOptional && !propType.endsWith("?") ? "?" : "";
    properties.push(`    public let ${swiftName}: ${propType}${optionalSuffix}`);
    codingKeys.push(`        case ${swiftName} = "${rawName}"`);
  }

  let structCode = `public struct ${typeName}: Codable, Sendable {\n`;
  structCode += properties.join("\n") + "\n";

  if (needsCodingKeys) {
    structCode += "\n    enum CodingKeys: String, CodingKey {\n";
    structCode += codingKeys.join("\n") + "\n";
    structCode += "    }\n";
  }

  structCode += "}";

  declarations.push({ name: typeName, code: structCode });
  return typeName;
}

// ==========================================
// z.array(T) -> [SwiftType]
// ==========================================

function convertArray(
  source: string,
  context: SwiftTypeContext,
  declarations: SwiftDeclaration[]
): string {
  const innerContent = extractParenContent(source, 7);
  if (!innerContent) return "[AnyCodable]";

  const elementContext: SwiftTypeContext = {
    namespace: context.namespace,
    declarations: [],
    currentTypeName: context.currentTypeName
      ? `${context.currentTypeName}Item`
      : `${context.namespace}Item`,
  };
  const elementType = convertZodSource(innerContent.trim(), elementContext, declarations);

  return `[${elementType}]`;
}

// ==========================================
// z.enum(["a", "b"]) -> enum: String, Codable
// ==========================================

function convertEnum(
  source: string,
  context: SwiftTypeContext,
  declarations: SwiftDeclaration[]
): string {
  const match = source.match(/z\.enum\s*\(\s*\[([^\]]+)\]\s*\)/);
  if (!match?.[1]) return "String";

  const values = match[1]
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.replace(/^["']|["']$/g, ""));

  const typeName = context.currentTypeName || `${context.namespace}Enum`;

  const cases = values.map((v) => {
    const caseName = toSwiftEnumCase(v);
    if (caseName !== v) {
      return `    case ${caseName} = "${v}"`;
    }
    return `    case ${caseName}`;
  });

  const enumCode = `public enum ${typeName}: String, Codable, Sendable {\n${cases.join("\n")}\n}`;

  declarations.push({ name: typeName, code: enumCode });
  return typeName;
}

// ==========================================
// z.union([A, B]) -> enum with associated values
// ==========================================

function convertUnion(
  source: string,
  context: SwiftTypeContext,
  declarations: SwiftDeclaration[]
): string {
  const match = source.match(/z\.union\s*\(\s*\[([^\]]+)\]\s*\)/);
  if (!match?.[1]) return "AnyCodable";

  const schemas = splitTopLevel(match[1], ",");
  const typeName = context.currentTypeName || `${context.namespace}Union`;

  // Check if all variants are literals - make a simple enum
  const allLiterals = schemas.every((s) => s.trim().startsWith("z.literal("));
  if (allLiterals) {
    const values = schemas.map((s) => {
      const litMatch = s.trim().match(/z\.literal\s*\(\s*([^)]+)\s*\)/);
      return litMatch?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
    });

    const cases = values.map((v) => {
      const caseName = toSwiftEnumCase(v);
      return caseName !== v
        ? `    case ${caseName} = "${v}"`
        : `    case ${caseName}`;
    });

    const enumCode = `public enum ${typeName}: String, Codable, Sendable {\n${cases.join("\n")}\n}`;
    declarations.push({ name: typeName, code: enumCode });
    return typeName;
  }

  // General union: enum with associated values
  const cases: string[] = [];
  for (let i = 0; i < schemas.length; i++) {
    const schema = schemas[i]!.trim();
    const variantContext: SwiftTypeContext = {
      namespace: context.namespace,
      declarations: [],
      currentTypeName: `${typeName}Variant${i}`,
    };
    const variantType = convertZodSource(schema, variantContext, declarations);
    cases.push(`    case variant${i}(${variantType})`);
  }

  const enumCode = `public enum ${typeName}: Codable, Sendable {\n${cases.join("\n")}\n}`;
  declarations.push({ name: typeName, code: enumCode });
  return typeName;
}

// ==========================================
// z.record(K, V) -> [String: SwiftType]
// ==========================================

function convertRecord(
  source: string,
  context: SwiftTypeContext,
  declarations: SwiftDeclaration[]
): string {
  const innerContent = extractParenContent(source, 8);
  if (!innerContent) return "[String: AnyCodable]";

  const parts = splitTopLevel(innerContent, ",");
  if (parts.length === 2) {
    const valueContext: SwiftTypeContext = {
      namespace: context.namespace,
      declarations: [],
      currentTypeName: context.currentTypeName
        ? `${context.currentTypeName}Value`
        : `${context.namespace}Value`,
    };
    const valueType = convertZodSource(parts[1]!.trim(), valueContext, declarations);
    return `[String: ${valueType}]`;
  }

  // Single argument: z.record(valueSchema)
  const valueContext: SwiftTypeContext = {
    namespace: context.namespace,
    declarations: [],
    currentTypeName: context.currentTypeName
      ? `${context.currentTypeName}Value`
      : `${context.namespace}Value`,
  };
  const valueType = convertZodSource(parts[0]!.trim(), valueContext, declarations);
  return `[String: ${valueType}]`;
}

// ==========================================
// z.tuple([A, B]) -> struct with _0, _1
// ==========================================

function convertTuple(
  source: string,
  context: SwiftTypeContext,
  declarations: SwiftDeclaration[]
): string {
  const match = source.match(/z\.tuple\s*\(\s*\[([^\]]+)\]\s*\)/);
  if (!match?.[1]) return "AnyCodable";

  const schemas = splitTopLevel(match[1], ",");
  const typeName = context.currentTypeName || `${context.namespace}Tuple`;

  const properties: string[] = [];
  for (let i = 0; i < schemas.length; i++) {
    const elementContext: SwiftTypeContext = {
      namespace: context.namespace,
      declarations: [],
      currentTypeName: `${typeName}Element${i}`,
    };
    const elementType = convertZodSource(schemas[i]!.trim(), elementContext, declarations);
    properties.push(`    public let _${i}: ${elementType}`);
  }

  const structCode = `public struct ${typeName}: Codable, Sendable {\n${properties.join("\n")}\n}`;
  declarations.push({ name: typeName, code: structCode });
  return typeName;
}

// ==========================================
// z.literal("x") -> static constant
// ==========================================

function convertLiteral(
  _source: string,
  _context: SwiftTypeContext,
  _declarations: SwiftDeclaration[]
): string {
  const match = _source.match(/z\.literal\s*\(\s*([^)]+)\s*\)/);
  if (!match?.[1]) return "AnyCodable";

  const value = match[1].trim();

  // String literal
  if (value.startsWith('"') || value.startsWith("'")) {
    return "String";
  }
  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return value.includes(".") ? "Double" : "Int";
  }
  // Boolean literal
  if (value === "true" || value === "false") {
    return "Bool";
  }

  return "AnyCodable";
}

// ==========================================
// Helpers
// ==========================================

/** Convert a JSON property name to a safe Swift property name */
function toSwiftPropertyName(name: string): string {
  // Remove quotes if present
  let clean = name.replace(/^["']|["']$/g, "");

  // Replace non-alphanumeric with underscore
  clean = clean.replace(/[^a-zA-Z0-9_]/g, "_");

  // Ensure it starts with a letter or underscore
  if (/^\d/.test(clean)) {
    clean = `_${clean}`;
  }

  // Swift reserved words
  const reserved = new Set([
    "class", "struct", "enum", "protocol", "extension", "func", "var", "let",
    "if", "else", "switch", "case", "default", "for", "while", "repeat",
    "return", "break", "continue", "throw", "try", "catch", "import", "self",
    "Self", "nil", "true", "false", "in", "as", "is", "type", "Type",
    "where", "guard", "do", "defer",
  ]);

  if (reserved.has(clean)) {
    clean = `\`${clean}\``;
  }

  return clean;
}

/** Convert a string value to a safe Swift enum case name */
function toSwiftEnumCase(value: string): string {
  let clean = value.replace(/[^a-zA-Z0-9_]/g, "_");

  // Ensure it starts with a lowercase letter
  if (/^\d/.test(clean)) {
    clean = `_${clean}`;
  }

  // camelCase
  if (clean.includes("_")) {
    const parts = clean.split("_").filter(Boolean);
    clean = parts[0]! + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  }

  // Ensure first char is lowercase
  clean = clean.charAt(0).toLowerCase() + clean.slice(1);

  return clean;
}
