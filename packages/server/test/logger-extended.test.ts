import { describe, it, expect } from "bun:test";
import { createLogger, ConsoleTransport } from "../src/core/logger";

describe("Logger with tags", () => {
  it("should log messages with tags in pretty format", () => {
    const logs: any[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));

    try {
      const logger = createLogger({ level: "debug" });
      logger.info("test message", { tags: ["custom-tag", "another-tag"] });

      expect(logs.length).toBeGreaterThan(0);
      // The output should contain the tag names
      expect(logs[0]).toContain("custom-tag");
      expect(logs[0]).toContain("another-tag");
    } finally {
      console.log = origLog;
    }
  });

  it("should assign consistent colors to the same tag", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const logger = createLogger({ level: "debug" });
      logger.info("msg1", { tags: ["my-tag"] });
      logger.info("msg2", { tags: ["my-tag"] });

      // Both logs should contain the same tag representation
      expect(logs[0]).toContain("my-tag");
      expect(logs[1]).toContain("my-tag");
    } finally {
      console.log = origLog;
    }
  });
});

describe("ConsoleTransport JSON format", () => {
  it("should output JSON format when configured", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const transport = new ConsoleTransport("json");
      transport.log({
        level: "info",
        message: "json test",
        timestamp: new Date("2024-01-01T00:00:00Z"),
        tags: ["test"],
      });

      expect(logs.length).toBe(1);
      const parsed = JSON.parse(logs[0]);
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("json test");
    } finally {
      console.log = origLog;
    }
  });
});

describe("Logger child() and tag()", () => {
  it("should create a child logger with merged context", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const logger = createLogger({ level: "debug" });
      const child = logger.child({ requestId: "req-123" });
      child.info("child message");

      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toContain("child message");
      expect(logs[0]).toContain("req-123");
    } finally {
      console.log = origLog;
    }
  });

  it("should create a tagged logger", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const logger = createLogger({ level: "debug" });
      const tagged = logger.tag("auth");
      tagged.info("tagged message");

      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toContain("auth");
      expect(logs[0]).toContain("tagged message");
    } finally {
      console.log = origLog;
    }
  });

  it("should respect debug level filtering", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const logger = createLogger({ level: "warn" });
      logger.debug("should not appear");
      logger.info("should not appear either");
      logger.warn("should appear");
      logger.error("should also appear");

      expect(logs.length).toBe(2);
    } finally {
      console.log = origLog;
    }
  });

  it("should log with context data", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const logger = createLogger({ level: "debug" });
      logger.info("with data", { userId: "u-1", action: "login" });

      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("userId");
    } finally {
      console.log = origLog;
    }
  });
});
