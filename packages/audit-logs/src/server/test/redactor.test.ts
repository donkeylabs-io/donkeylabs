import { describe, expect, it } from "bun:test";
import { Redactor, defaultRedactor } from "../redactor";
import { REDACTED_PLACEHOLDER } from "../../shared/types";

describe("Redactor", () => {
  describe("shouldRedactField", () => {
    it("redacts password fields", () => {
      expect(defaultRedactor.shouldRedactField("password")).toBe(true);
      expect(defaultRedactor.shouldRedactField("Password")).toBe(true);
      expect(defaultRedactor.shouldRedactField("user_password")).toBe(true);
      expect(defaultRedactor.shouldRedactField("passwordHash")).toBe(true);
    });

    it("redacts secret fields", () => {
      expect(defaultRedactor.shouldRedactField("secret")).toBe(true);
      expect(defaultRedactor.shouldRedactField("clientSecret")).toBe(true);
      expect(defaultRedactor.shouldRedactField("api_secret")).toBe(true);
    });

    it("redacts token fields", () => {
      expect(defaultRedactor.shouldRedactField("token")).toBe(true);
      expect(defaultRedactor.shouldRedactField("accessToken")).toBe(true);
      expect(defaultRedactor.shouldRedactField("refresh_token")).toBe(true);
    });

    it("redacts API key fields", () => {
      expect(defaultRedactor.shouldRedactField("apikey")).toBe(true);
      expect(defaultRedactor.shouldRedactField("api_key")).toBe(true);
      expect(defaultRedactor.shouldRedactField("api-key")).toBe(true);
      expect(defaultRedactor.shouldRedactField("apiKey")).toBe(true);
    });

    it("redacts authorization fields", () => {
      expect(defaultRedactor.shouldRedactField("authorization")).toBe(true);
      expect(defaultRedactor.shouldRedactField("Authorization")).toBe(true);
    });

    it("redacts auth fields", () => {
      expect(defaultRedactor.shouldRedactField("auth")).toBe(true);
      expect(defaultRedactor.shouldRedactField("authHeader")).toBe(true);
    });

    it("redacts cookie and session fields", () => {
      expect(defaultRedactor.shouldRedactField("cookie")).toBe(true);
      expect(defaultRedactor.shouldRedactField("session")).toBe(true);
      expect(defaultRedactor.shouldRedactField("sessionId")).toBe(true);
    });

    it("redacts credential fields", () => {
      expect(defaultRedactor.shouldRedactField("credential")).toBe(true);
      expect(defaultRedactor.shouldRedactField("credentials")).toBe(true);
    });

    it("redacts credit card fields", () => {
      expect(defaultRedactor.shouldRedactField("creditcard")).toBe(true);
      expect(defaultRedactor.shouldRedactField("credit_card")).toBe(true);
      expect(defaultRedactor.shouldRedactField("cardnumber")).toBe(true);
      expect(defaultRedactor.shouldRedactField("card_number")).toBe(true);
      expect(defaultRedactor.shouldRedactField("cvv")).toBe(true);
      expect(defaultRedactor.shouldRedactField("cvc")).toBe(true);
    });

    it("redacts SSN fields", () => {
      expect(defaultRedactor.shouldRedactField("ssn")).toBe(true);
      expect(defaultRedactor.shouldRedactField("socialsecurity")).toBe(true);
      expect(defaultRedactor.shouldRedactField("social_security")).toBe(true);
    });

    it("redacts encryption key fields", () => {
      expect(defaultRedactor.shouldRedactField("privatekey")).toBe(true);
      expect(defaultRedactor.shouldRedactField("private_key")).toBe(true);
      expect(defaultRedactor.shouldRedactField("encryptionkey")).toBe(true);
      expect(defaultRedactor.shouldRedactField("encryption_key")).toBe(true);
    });

    it("does not redact safe fields", () => {
      expect(defaultRedactor.shouldRedactField("username")).toBe(false);
      expect(defaultRedactor.shouldRedactField("email")).toBe(false);
      expect(defaultRedactor.shouldRedactField("name")).toBe(false);
      expect(defaultRedactor.shouldRedactField("id")).toBe(false);
      expect(defaultRedactor.shouldRedactField("count")).toBe(false);
    });
  });

  describe("shouldRedactValue", () => {
    it("redacts JWT tokens", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      expect(defaultRedactor.shouldRedactValue(jwt)).toBe(true);
    });

    it("redacts Bearer tokens", () => {
      expect(defaultRedactor.shouldRedactValue("Bearer abc123xyz")).toBe(true);
      expect(defaultRedactor.shouldRedactValue("bearer TOKEN")).toBe(true);
    });

    it("redacts credit card numbers", () => {
      expect(defaultRedactor.shouldRedactValue("4111111111111111")).toBe(true);
      expect(defaultRedactor.shouldRedactValue("5500000000000004")).toBe(true);
      // 12 digits (too short for CC)
      expect(defaultRedactor.shouldRedactValue("123456789012")).toBe(false);
    });

    it("does not redact safe values", () => {
      expect(defaultRedactor.shouldRedactValue("hello world")).toBe(false);
      expect(defaultRedactor.shouldRedactValue("user@example.com")).toBe(false);
      expect(defaultRedactor.shouldRedactValue("12345")).toBe(false);
    });
  });

  describe("redact", () => {
    it("returns null and undefined unchanged", () => {
      expect(defaultRedactor.redact(null)).toBe(null);
      expect(defaultRedactor.redact(undefined)).toBe(undefined);
    });

    it("redacts sensitive string values", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc";
      expect(defaultRedactor.redact(jwt)).toBe(REDACTED_PLACEHOLDER);
    });

    it("preserves safe string values", () => {
      expect(defaultRedactor.redact("hello")).toBe("hello");
    });

    it("redacts sensitive fields in objects", () => {
      const input = {
        username: "john",
        password: "secret123",
        apiKey: "key123",
      };

      const result = defaultRedactor.redact(input);
      expect(result).toEqual({
        username: "john",
        password: REDACTED_PLACEHOLDER,
        apiKey: REDACTED_PLACEHOLDER,
      });
    });

    it("redacts sensitive values regardless of field name", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc";
      const input = {
        someField: jwt,
        normalField: "hello",
      };

      const result = defaultRedactor.redact(input);
      expect(result).toEqual({
        someField: REDACTED_PLACEHOLDER,
        normalField: "hello",
      });
    });

    it("recursively redacts nested objects", () => {
      const input = {
        user: {
          name: "John",
          credentials: {
            password: "secret",
            apiKey: "abc123",
          },
        },
      };

      const result = defaultRedactor.redact(input);
      // "credentials" is a sensitive field, so it gets redacted entirely
      expect(result).toEqual({
        user: {
          name: "John",
          credentials: REDACTED_PLACEHOLDER,
        },
      });
    });

    it("recursively redacts when parent field is not sensitive", () => {
      const input = {
        user: {
          name: "John",
          settings: {
            password: "secret",
            theme: "dark",
          },
        },
      };

      const result = defaultRedactor.redact(input);
      expect(result).toEqual({
        user: {
          name: "John",
          settings: {
            password: REDACTED_PLACEHOLDER,
            theme: "dark",
          },
        },
      });
    });

    it("redacts sensitive values in arrays", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc";
      const input = ["hello", jwt, "world"];

      const result = defaultRedactor.redact(input);
      expect(result).toEqual(["hello", REDACTED_PLACEHOLDER, "world"]);
    });

    it("handles arrays of objects", () => {
      const input = [
        { name: "John", password: "pass1" },
        { name: "Jane", password: "pass2" },
      ];

      const result = defaultRedactor.redact(input);
      expect(result).toEqual([
        { name: "John", password: REDACTED_PLACEHOLDER },
        { name: "Jane", password: REDACTED_PLACEHOLDER },
      ]);
    });

    it("preserves non-string values", () => {
      const input = {
        count: 42,
        active: true,
        password: "secret",
      };

      const result = defaultRedactor.redact(input);
      expect(result).toEqual({
        count: 42,
        active: true,
        password: REDACTED_PLACEHOLDER,
      });
    });
  });

  describe("redactJSON", () => {
    it("returns null for null input", () => {
      expect(defaultRedactor.redactJSON(null)).toBe(null);
    });

    it("returns null for undefined input", () => {
      expect(defaultRedactor.redactJSON(undefined)).toBe(null);
    });

    it("redacts sensitive fields in JSON string", () => {
      const input = JSON.stringify({
        username: "john",
        password: "secret",
      });

      const result = defaultRedactor.redactJSON(input);
      expect(JSON.parse(result!)).toEqual({
        username: "john",
        password: REDACTED_PLACEHOLDER,
      });
    });

    it("returns original string for invalid JSON", () => {
      expect(defaultRedactor.redactJSON("not json")).toBe("not json");
    });

    it("redacts entire value if string is sensitive", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc";
      expect(defaultRedactor.redactJSON(jwt)).toBe(REDACTED_PLACEHOLDER);
    });
  });

  describe("redactHeaders", () => {
    it("redacts authorization header", () => {
      const headers = {
        "content-type": "application/json",
        authorization: "Bearer token123",
      };

      const result = defaultRedactor.redactHeaders(headers);
      expect(result).toEqual({
        "content-type": "application/json",
        authorization: REDACTED_PLACEHOLDER,
      });
    });

    it("redacts cookie header", () => {
      const headers = {
        "content-type": "text/html",
        cookie: "session=abc123",
      };

      const result = defaultRedactor.redactHeaders(headers);
      expect(result).toEqual({
        "content-type": "text/html",
        cookie: REDACTED_PLACEHOLDER,
      });
    });

    it("handles undefined header values", () => {
      const headers: Record<string, string | undefined> = {
        "content-type": "application/json",
        "x-custom": undefined,
      };

      const result = defaultRedactor.redactHeaders(headers);
      expect(result).toEqual({
        "content-type": "application/json",
      });
    });

    it("handles array header values", () => {
      const headers: Record<string, string | string[]> = {
        "content-type": "application/json",
        "set-cookie": ["cookie1=a", "cookie2=b"],
      };

      const result = defaultRedactor.redactHeaders(headers);
      expect(result).toEqual({
        "content-type": "application/json",
        "set-cookie": REDACTED_PLACEHOLDER,
      });
    });

    it("redacts header values containing sensitive data", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc";
      const headers = {
        "x-custom-token": jwt,
      };

      const result = defaultRedactor.redactHeaders(headers);
      expect(result).toEqual({
        "x-custom-token": REDACTED_PLACEHOLDER,
      });
    });
  });

  describe("custom patterns", () => {
    it("accepts additional field patterns", () => {
      const customRedactor = new Redactor([
        { type: "field", pattern: /myCustomField/i },
      ]);

      const input = {
        username: "john",
        myCustomField: "sensitive",
      };

      const result = customRedactor.redact(input);
      expect(result).toEqual({
        username: "john",
        myCustomField: REDACTED_PLACEHOLDER,
      });
    });

    it("accepts additional value patterns", () => {
      const customRedactor = new Redactor([
        { type: "value", pattern: /^CUSTOM-\d+$/ },
      ]);

      const input = {
        code: "CUSTOM-12345",
        name: "John",
      };

      const result = customRedactor.redact(input);
      expect(result).toEqual({
        code: REDACTED_PLACEHOLDER,
        name: "John",
      });
    });

    it("combines default and custom patterns", () => {
      const customRedactor = new Redactor([
        { type: "field", pattern: /internalId/i },
      ]);

      const input = {
        password: "secret",
        internalId: "id-123",
        name: "John",
      };

      const result = customRedactor.redact(input);
      expect(result).toEqual({
        password: REDACTED_PLACEHOLDER,
        internalId: REDACTED_PLACEHOLDER,
        name: "John",
      });
    });
  });

  describe("createFieldPatterns", () => {
    it("creates field patterns from array of names", () => {
      const patterns = Redactor.createFieldPatterns(["customField", "anotherField"]);

      expect(patterns).toHaveLength(2);
      expect(patterns[0].type).toBe("field");
      expect(patterns[1].type).toBe("field");
      expect(patterns[0].pattern.test("customField")).toBe(true);
      expect(patterns[0].pattern.test("CUSTOMFIELD")).toBe(true); // Case insensitive
      expect(patterns[1].pattern.test("anotherField")).toBe(true);
    });
  });
});
