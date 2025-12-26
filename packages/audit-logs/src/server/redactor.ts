import {
  type RedactionPattern,
  DEFAULT_REDACTION_PATTERNS,
  REDACTED_PLACEHOLDER,
} from "../shared/types";

/**
 * Redactor class for sanitizing sensitive data from log entries.
 * Recursively processes objects and arrays to redact sensitive fields and values.
 */
export class Redactor {
  private fieldPatterns: RegExp[];
  private valuePatterns: RegExp[];

  constructor(additionalPatterns: RedactionPattern[] = []) {
    const allPatterns = [...DEFAULT_REDACTION_PATTERNS, ...additionalPatterns];

    this.fieldPatterns = allPatterns.filter((p) => p.type === "field").map((p) => p.pattern);

    this.valuePatterns = allPatterns.filter((p) => p.type === "value").map((p) => p.pattern);
  }

  /**
   * Check if a field name should be redacted
   */
  shouldRedactField(fieldName: string): boolean {
    return this.fieldPatterns.some((pattern) => pattern.test(fieldName));
  }

  /**
   * Check if a value matches sensitive patterns
   */
  shouldRedactValue(value: string): boolean {
    return this.valuePatterns.some((pattern) => pattern.test(value));
  }

  /**
   * Recursively redact sensitive data from an object
   */
  redact<T>(data: T): T {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === "string") {
      // Check if the string value itself is sensitive
      if (this.shouldRedactValue(data)) {
        return REDACTED_PLACEHOLDER as T;
      }
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.redact(item)) as T;
    }

    if (typeof data === "object") {
      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (this.shouldRedactField(key)) {
          result[key] = REDACTED_PLACEHOLDER;
        } else if (typeof value === "string" && this.shouldRedactValue(value)) {
          result[key] = REDACTED_PLACEHOLDER;
        } else if (typeof value === "object" && value !== null) {
          result[key] = this.redact(value);
        } else {
          result[key] = value;
        }
      }

      return result as T;
    }

    return data;
  }

  /**
   * Redact a JSON string
   */
  redactJSON(jsonString: string | null | undefined): string | null {
    if (!jsonString) {
      return null;
    }

    try {
      const parsed = JSON.parse(jsonString);
      const redacted = this.redact(parsed);
      return JSON.stringify(redacted);
    } catch {
      // If it's not valid JSON, check if the whole string is sensitive
      if (this.shouldRedactValue(jsonString)) {
        return REDACTED_PLACEHOLDER;
      }
      return jsonString;
    }
  }

  /**
   * Redact headers object (common use case)
   */
  redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;

      const stringValue = Array.isArray(value) ? value.join(", ") : value;

      if (this.shouldRedactField(key)) {
        result[key] = REDACTED_PLACEHOLDER;
      } else if (this.shouldRedactValue(stringValue)) {
        result[key] = REDACTED_PLACEHOLDER;
      } else {
        result[key] = stringValue;
      }
    }

    return result;
  }

  /**
   * Create additional patterns from field names
   */
  static createFieldPatterns(fieldNames: string[]): RedactionPattern[] {
    return fieldNames.map((name) => ({
      type: "field" as const,
      pattern: new RegExp(name, "i"),
    }));
  }
}

/**
 * Default redactor instance
 */
export const defaultRedactor = new Redactor();
