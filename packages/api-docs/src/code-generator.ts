/**
 * SDK Code Example Generator
 * Generates TypeScript code examples using the APIRequest builder pattern
 */

const API_BASE_URL = "https://api.example.com"; // Replace with your API URL

/**
 * Generate an SDK example for a route
 */
export function generateSdkExample(
  routerName: string,
  routeName: string,
  exampleInput: unknown,
  version?: string
): string {
  const safeRouterName = escapeString(routerName);
  const safeRouteName = escapeString(routeName);
  const safeVersion = version ? escapeString(version) : undefined;
  const inputStr = formatInput(exampleInput);
  const hasInput = inputStr !== "{}";
  const apiRequestStart = safeVersion
    ? `APIRequest\n    .version("${safeVersion}")`
    : "APIRequest";

  if (hasInput) {
    return `const response = await client.run(
  ${apiRequestStart}
    .router("${safeRouterName}")
    .route("${safeRouteName}")
    .input(${inputStr})
    .build()
);`;
  }

  return `const response = await client.run(
  ${apiRequestStart}
    .router("${safeRouterName}")
    .route("${safeRouteName}")
    .build()
);`;
}

/**
 * Format an input value as TypeScript code
 */
function formatInput(value: unknown, indent: number = 4): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  if (typeof value === "string") {
    return `"${escapeString(value)}"`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return `new Date("${value.toISOString()}")`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => formatInput(item, indent + 2));
    return `[${items.join(", ")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";

    const spaces = " ".repeat(indent);
    const innerSpaces = " ".repeat(indent + 2);

    const props = entries.map(([key, val]) => {
      const formattedValue = formatInput(val, indent + 2);
      // Use quotes if key has special characters
      const formattedKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
        ? key
        : `"${key}"`;
      return `${innerSpaces}${formattedKey}: ${formattedValue}`;
    });

    return `{\n${props.join(",\n")}\n${spaces}}`;
  }

  return String(value);
}

/**
 * Escape special characters in a string
 */
function escapeString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Generate a full example with imports and setup
 */
export function generateFullExample(
  routerName: string,
  routeName: string,
  exampleInput: unknown,
  version?: string
): string {
  const basicExample = generateSdkExample(routerName, routeName, exampleInput, version);

  return `import { APIClient, APIRequest } from "@donkeylabs/core";

// Initialize the client
const client = new APIClient(API_BASE_URL);

// Make the request
${basicExample}

console.log(response);`;
}

/**
 * Generate example with error handling
 */
export function generateExampleWithErrorHandling(
  routerName: string,
  routeName: string,
  exampleInput: unknown,
  version?: string
): string {
  const basicExample = generateSdkExample(routerName, routeName, exampleInput, version);

  return `import { APIClient, APIRequest, ApiError, ErrorType } from "@donkeylabs/core";

const client = new APIClient(API_BASE_URL);

try {
  ${basicExample.split("\n").join("\n  ")}
  console.log("Success:", response);
} catch (error) {
  if (error instanceof ApiError) {
    switch (error.type) {
      case ErrorType.VALIDATION_ERROR:
        console.error("Validation failed:", error.details);
        break;
      case ErrorType.UNAUTHORIZED:
        console.error("Authentication required");
        break;
      case ErrorType.RATE_LIMIT_EXCEEDED:
        console.error("Too many requests, try again later");
        break;
      default:
        console.error("API Error:", error.message);
    }
  } else {
    throw error;
  }
}`;
}
