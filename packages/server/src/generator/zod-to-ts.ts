import { z } from "zod";

/**
 * Convert a Zod schema to TypeScript type string at runtime
 * Uses Zod's internal _def to introspect the schema
 */
export function zodSchemaToTs(schema: z.ZodType<any>): string {
  return convertZodType(schema);
}

function convertZodType(schema: z.ZodType<any>): string {
  const def = (schema as any)._def;
  const typeName = def?.typeName;

  switch (typeName) {
    case "ZodString":
      return "string";

    case "ZodNumber":
      return "number";

    case "ZodBoolean":
      return "boolean";

    case "ZodDate":
      return "Date";

    case "ZodUndefined":
      return "undefined";

    case "ZodNull":
      return "null";

    case "ZodAny":
      return "any";

    case "ZodUnknown":
      return "unknown";

    case "ZodVoid":
      return "void";

    case "ZodNever":
      return "never";

    case "ZodLiteral":
      const value = def.value;
      return typeof value === "string" ? `"${value}"` : String(value);

    case "ZodArray":
      const itemType = convertZodType(def.type);
      return `${itemType}[]`;

    case "ZodObject":
      const shape = def.shape();
      const props = Object.entries(shape).map(([key, value]) => {
        const propSchema = value as z.ZodType<any>;
        const isOptional = (propSchema as any)._def?.typeName === "ZodOptional";
        const innerType = isOptional
          ? convertZodType((propSchema as any)._def.innerType)
          : convertZodType(propSchema);
        return `  ${key}${isOptional ? "?" : ""}: ${innerType};`;
      });
      return `{\n${props.join("\n")}\n}`;

    case "ZodOptional":
      return convertZodType(def.innerType);

    case "ZodNullable":
      return `${convertZodType(def.innerType)} | null`;

    case "ZodDefault":
      return convertZodType(def.innerType);

    case "ZodUnion":
      const options = def.options.map((opt: z.ZodType<any>) => convertZodType(opt));
      return options.join(" | ");

    case "ZodEnum":
      return def.values.map((v: string) => `"${v}"`).join(" | ");

    case "ZodNativeEnum":
      return "number | string"; // Simplified

    case "ZodRecord":
      const keyType = def.keyType ? convertZodType(def.keyType) : "string";
      const valueType = convertZodType(def.valueType);
      return `Record<${keyType}, ${valueType}>`;

    case "ZodTuple":
      const items = def.items.map((item: z.ZodType<any>) => convertZodType(item));
      return `[${items.join(", ")}]`;

    case "ZodPromise":
      return `Promise<${convertZodType(def.type)}>`;

    case "ZodEffects":
      // .transform(), .refine(), etc - use the inner schema
      return convertZodType(def.schema);

    case "ZodLazy":
      // Lazy schemas - try to resolve
      return convertZodType(def.getter());

    case "ZodIntersection":
      const left = convertZodType(def.left);
      const right = convertZodType(def.right);
      return `${left} & ${right}`;

    default:
      // Fallback for unknown types
      return "unknown";
  }
}
