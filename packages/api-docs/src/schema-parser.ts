/**
 * Zod v4 Schema Parser
 * Parses Zod v4 schemas using the new internal structure to extract documentation metadata
 */

import type { z } from "zod";
import type { SchemaDoc, SchemaFieldType, SchemaConstraints } from "./types";

/**
 * Parse a Zod v4 schema into a documentable SchemaDoc structure
 */
export function parseZodSchema(schema: z.ZodTypeAny): SchemaDoc {
  // In Zod v4, the type is directly on the schema object or in _def
  const schemaType = (schema as any).type || (schema as any)._def?.type;

  if (!schemaType) {
    // Check for wrapper types by looking at the schema structure
    if ((schema as any)._def?.innerType) {
      // Optional or nullable wrapper
      const inner = parseZodSchema((schema as any)._def.innerType);
      const isOptional = schema.isOptional?.() ?? false;
      const isNullable = schema.isNullable?.() ?? false;
      return { ...inner, isOptional, isNullable };
    }
    return createBaseDoc("unknown");
  }

  // Handle based on type
  switch (schemaType) {
    case "string":
      return parseStringSchema(schema);

    case "number":
      return parseNumberSchema(schema);

    case "boolean":
      return createBaseDoc("boolean", {
        description: getDescription(schema),
      });

    case "date":
      return createBaseDoc("date", {
        description: getDescription(schema),
      });

    case "object":
      return parseObjectSchema(schema);

    case "array":
      return parseArraySchema(schema);

    case "enum":
      return parseEnumSchema(schema);

    case "union":
      return parseUnionSchema(schema);

    case "literal":
      return {
        ...createBaseDoc("literal"),
        constraints: { literalValue: (schema as any)._def?.value ?? (schema as any).value },
        description: getDescription(schema),
      };

    case "optional":
      const optInner = parseZodSchema((schema as any)._def?.innerType || (schema as any).unwrap?.());
      return { ...optInner, isOptional: true };

    case "nullable":
      const nullInner = parseZodSchema((schema as any)._def?.innerType || (schema as any).unwrap?.());
      return { ...nullInner, isNullable: true };

    case "default":
      const defInner = parseZodSchema((schema as any)._def?.innerType || (schema as any).unwrap?.());
      let defaultValue: unknown;
      try {
        defaultValue = (schema as any)._def?.defaultValue?.();
      } catch (e) {
        if (process.env.NODE_ENV === "development") {
          console.warn("[api-docs] Failed to extract default value:", e);
        }
        defaultValue = undefined;
      }
      return { ...defInner, isOptional: true, defaultValue };

    case "any":
      return createBaseDoc("any", { description: getDescription(schema) });

    case "unknown":
      return createBaseDoc("unknown", { description: getDescription(schema) });

    case "void":
    case "undefined":
    case "null":
      return createBaseDoc("unknown", { isNullable: true });

    case "record":
      return {
        ...createBaseDoc("object"),
        description: getDescription(schema) || "Record/Dictionary type",
      };

    case "tuple":
      return {
        ...createBaseDoc("array"),
        description: getDescription(schema) || "Tuple type",
      };

    case "lazy":
      return createBaseDoc("object", { description: "Recursive type" });

    case "pipe":
    case "transform":
    case "effect":
      // For pipes/transforms, try to get the input schema
      const innerSchema = (schema as any)._def?.in || (schema as any)._def?.schema;
      if (innerSchema) {
        return parseZodSchema(innerSchema);
      }
      return createBaseDoc("unknown");

    default:
      // Don't log - just return unknown
      return createBaseDoc("unknown");
  }
}

function createBaseDoc(
  type: SchemaFieldType,
  overrides: Partial<SchemaDoc> = {}
): SchemaDoc {
  return {
    type,
    isOptional: false,
    isNullable: false,
    ...overrides,
  };
}

function getDescription(schema: z.ZodTypeAny): string | undefined {
  // Zod v4 stores description in different places
  return (schema as any).description || (schema as any)._def?.description || (schema as any).meta?.()?.description;
}

function parseStringSchema(schema: z.ZodTypeAny): SchemaDoc {
  const constraints: SchemaConstraints = {};
  let errorMessage: string | undefined;

  // In Zod v4, constraints are directly on the schema object
  const s = schema as any;

  if (s.minLength != null) {
    constraints.minLength = s.minLength;
  }
  if (s.maxLength != null) {
    constraints.maxLength = s.maxLength;
  }
  if (s.format) {
    constraints.pattern = s.format;
  }

  // Also check _def.checks for error messages
  const checks = s._def?.checks || s.def?.checks || [];
  for (const check of checks) {
    if (check.message) {
      errorMessage = check.message;
      break;
    }
  }

  return {
    ...createBaseDoc("string"),
    constraints: Object.keys(constraints).length > 0 ? constraints : undefined,
    errorMessage,
    description: getDescription(schema),
  };
}

function parseNumberSchema(schema: z.ZodTypeAny): SchemaDoc {
  const constraints: SchemaConstraints = {};
  let errorMessage: string | undefined;

  // In Zod v4, constraints are directly on the schema object
  const s = schema as any;

  if (s.minValue != null) {
    constraints.min = s.minValue;
  }
  if (s.maxValue != null) {
    constraints.max = s.maxValue;
  }

  // Also check _def.checks for error messages
  const checks = s._def?.checks || s.def?.checks || [];
  for (const check of checks) {
    if (check.message) {
      errorMessage = check.message;
      break;
    }
  }

  return {
    ...createBaseDoc("number"),
    constraints: Object.keys(constraints).length > 0 ? constraints : undefined,
    errorMessage,
    description: getDescription(schema),
  };
}

function parseObjectSchema(schema: z.ZodTypeAny): SchemaDoc {
  const children: Record<string, SchemaDoc> = {};

  // In Zod v4, shape is directly accessible
  const s = schema as any;
  const shape = s.shape || s._def?.shape;

  if (shape && typeof shape === "object") {
    for (const [key, value] of Object.entries(shape)) {
      if (value && typeof value === "object") {
        children[key] = parseZodSchema(value as z.ZodTypeAny);
      }
    }
  }

  return {
    ...createBaseDoc("object"),
    children: Object.keys(children).length > 0 ? children : undefined,
    description: getDescription(schema),
  };
}

function parseArraySchema(schema: z.ZodTypeAny): SchemaDoc {
  const s = schema as any;

  // In Zod v4, element is directly on the schema
  const element = s.element || s._def?.element;
  const itemType = element ? parseZodSchema(element) : undefined;

  const constraints: SchemaConstraints = {};
  // Check for min/max length on arrays
  if (s._def?.minLength != null) {
    constraints.min = s._def.minLength;
  }
  if (s._def?.maxLength != null) {
    constraints.max = s._def.maxLength;
  }

  return {
    ...createBaseDoc("array"),
    itemType,
    constraints: Object.keys(constraints).length > 0 ? constraints : undefined,
    description: getDescription(schema),
  };
}

function parseEnumSchema(schema: z.ZodTypeAny): SchemaDoc {
  const s = schema as any;

  // In Zod v4, enum values are in options or entries
  const options = s.options || Object.values(s.enum || {}) || Object.values(s._def?.entries || {});
  const enumValues = options.filter((v: unknown) => typeof v === "string") as string[];

  return {
    ...createBaseDoc("enum"),
    constraints: { enumValues },
    description: getDescription(schema),
  };
}

function parseUnionSchema(schema: z.ZodTypeAny): SchemaDoc {
  const s = schema as any;
  const options = s.options || s._def?.options || [];

  if (options.length === 0) {
    return createBaseDoc("union");
  }

  // Check if it's a simple literal union (like enum)
  const allLiterals = options.every(
    (opt: any) => opt.type === "literal" || opt._def?.type === "literal"
  );

  if (allLiterals) {
    const enumValues = options.map((opt: any) => String(opt.value || opt._def?.value));
    return {
      ...createBaseDoc("enum"),
      constraints: { enumValues },
      description: getDescription(schema),
    };
  }

  return {
    ...createBaseDoc("union"),
    description: getDescription(schema),
  };
}

/**
 * Extract example values from a schema for documentation
 */
export function generateExampleValue(schema: SchemaDoc, fieldName?: string): unknown {
  switch (schema.type) {
    case "string":
      if (schema.constraints?.enumValues) {
        return schema.constraints.enumValues[0];
      }
      // Generate contextual example based on field name
      return getStringExample(fieldName);

    case "number":
      // Only use min if it's a reasonable value (not -Infinity)
      if (schema.constraints?.min !== undefined && isFinite(schema.constraints.min) && schema.constraints.min > 0) {
        return schema.constraints.min;
      }
      // Generate contextual example based on field name
      return getNumberExample(fieldName);

    case "boolean":
      return true;

    case "date":
      return new Date().toISOString();

    case "enum":
      return schema.constraints?.enumValues?.[0] || "value";

    case "literal":
      return schema.constraints?.literalValue;

    case "array":
      if (schema.itemType) {
        return [generateExampleValue(schema.itemType)];
      }
      return [];

    case "object":
      if (schema.children) {
        const example: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(schema.children)) {
          if (!child.isOptional) {
            example[key] = generateExampleValue(child, key);
          }
        }
        return example;
      }
      return {};

    default:
      return null;
  }
}

/**
 * Generate contextual string examples based on field name
 */
function getStringExample(fieldName?: string): string {
  if (!fieldName) return "example";

  const name = fieldName.toLowerCase();

  if (name.includes("email")) return "user@example.com";
  if (name.includes("name")) return "Example Name";
  if (name.includes("phone")) return "+1234567890";
  if (name.includes("url") || name.includes("link")) return "https://example.com";
  if (name.includes("description") || name.includes("notes")) return "Description text here";
  if (name.includes("address")) return "123 Main Street";
  if (name.includes("code") || name.includes("sku")) return "ABC-123";
  if (name.includes("uuid") || name.includes("guid")) return "550e8400-e29b-41d4-a716-446655440000";
  if (name.includes("password") || name.includes("secret")) return "********";
  if (name.includes("token")) return "eyJhbGciOiJIUzI1NiIs...";

  return "example";
}

/**
 * Generate contextual number examples based on field name
 */
function getNumberExample(fieldName?: string): number {
  if (!fieldName) return 1;

  const name = fieldName.toLowerCase();

  if (name.includes("id")) return 123;
  if (name.includes("page")) return 1;
  if (name.includes("size") || name.includes("limit")) return 20;
  if (name.includes("quantity") || name.includes("qty")) return 10;
  if (name.includes("price") || name.includes("cost") || name.includes("amount")) return 99.99;
  if (name.includes("year")) return new Date().getFullYear();
  if (name.includes("month")) return new Date().getMonth() + 1;
  if (name.includes("day")) return new Date().getDate();
  if (name.includes("percent") || name.includes("rate")) return 15;
  if (name.includes("count") || name.includes("total")) return 100;

  return 1;
}
