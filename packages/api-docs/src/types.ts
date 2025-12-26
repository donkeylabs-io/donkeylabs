/**
 * Documentation types for API auto-generation
 */

export type SchemaFieldType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "enum"
  | "union"
  | "literal"
  | "date"
  | "any"
  | "unknown";

export interface SchemaConstraints {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enumValues?: string[];
  literalValue?: unknown;
}

export interface SchemaDoc {
  type: SchemaFieldType;
  isOptional: boolean;
  isNullable: boolean;
  description?: string;
  defaultValue?: unknown;
  constraints?: SchemaConstraints;
  errorMessage?: string;
  children?: Record<string, SchemaDoc>;
  itemType?: SchemaDoc;
}

export interface RateLimitDoc {
  maxAttempts: number;
  window: string;
  keyStrategy: string;
  errorMessage?: string;
}

export interface RouteDoc {
  routerName: string;
  routeName: string;
  version?: string;
  path: string;
  method: "get" | "post" | "put" | "delete" | "patch";
  permissions: string[];
  rateLimit?: RateLimitDoc;
  request: SchemaDoc;
  response: SchemaDoc;
  sdkExample: string;
}

export interface RouterDoc {
  name: string;
  permissions: Record<string, string>;
  routes: RouteDoc[];
}

export interface ApiDocs {
  routers: RouterDoc[];
  generatedAt: string;
  version: string;
}
