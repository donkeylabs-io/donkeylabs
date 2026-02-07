import { describe, it, expect } from "bun:test";
import {
  isProcessAlive,
  parseJobMessage,
  createInitialPayload,
  generateSocketPath,
  isStartedMessage,
  isProgressMessage,
  isHeartbeatMessage,
  isLogMessage,
  isCompletedMessage,
  isFailedMessage,
  isExternalJob,
  type AnyExternalJobMessage,
  type ExternalJob,
} from "../src/core/external-jobs";
import type { Job } from "../src/core/jobs";

// ==========================================
// External Jobs Unit Tests
// ==========================================

describe("isProcessAlive", () => {
  it("should return true for the current process PID", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("should return false for a non-existent PID", () => {
    // Use a very high PID that is unlikely to exist
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

describe("parseJobMessage", () => {
  const baseFields = {
    jobId: "job-123",
    timestamp: Date.now(),
  };

  it("should parse a valid started message", () => {
    const msg = JSON.stringify({ ...baseFields, type: "started" });
    const result = parseJobMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("started");
    expect(result!.jobId).toBe("job-123");
  });

  it("should parse a valid progress message", () => {
    const msg = JSON.stringify({
      ...baseFields,
      type: "progress",
      percent: 50,
      message: "Halfway done",
      data: { step: 5 },
    });
    const result = parseJobMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("progress");
    expect((result as any).percent).toBe(50);
    expect((result as any).message).toBe("Halfway done");
    expect((result as any).data).toEqual({ step: 5 });
  });

  it("should parse a valid completed message", () => {
    const msg = JSON.stringify({
      ...baseFields,
      type: "completed",
      result: { output: "done" },
    });
    const result = parseJobMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("completed");
    expect((result as any).result).toEqual({ output: "done" });
  });

  it("should parse a valid failed message", () => {
    const msg = JSON.stringify({
      ...baseFields,
      type: "failed",
      error: "Something broke",
      stack: "Error: Something broke\n  at foo.js:1:1",
    });
    const result = parseJobMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("failed");
    expect((result as any).error).toBe("Something broke");
    expect((result as any).stack).toContain("foo.js");
  });

  it("should parse a valid heartbeat message", () => {
    const msg = JSON.stringify({ ...baseFields, type: "heartbeat" });
    const result = parseJobMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("heartbeat");
  });

  it("should parse a valid log message", () => {
    const msg = JSON.stringify({
      ...baseFields,
      type: "log",
      level: "info",
      message: "Processing item",
      data: { itemId: 42 },
    });
    const result = parseJobMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("log");
    expect((result as any).level).toBe("info");
    expect((result as any).message).toBe("Processing item");
  });

  it("should return null for invalid JSON", () => {
    expect(parseJobMessage("not json at all")).toBeNull();
    expect(parseJobMessage("{broken")).toBeNull();
    expect(parseJobMessage("")).toBeNull();
  });

  it("should return null when type is missing", () => {
    const msg = JSON.stringify({ jobId: "job-1", timestamp: 123 });
    expect(parseJobMessage(msg)).toBeNull();
  });

  it("should return null when jobId is missing", () => {
    const msg = JSON.stringify({ type: "started", timestamp: 123 });
    expect(parseJobMessage(msg)).toBeNull();
  });

  it("should return null when timestamp is missing", () => {
    const msg = JSON.stringify({ type: "started", jobId: "job-1" });
    expect(parseJobMessage(msg)).toBeNull();
  });

  it("should return null when timestamp is not a number", () => {
    const msg = JSON.stringify({
      type: "started",
      jobId: "job-1",
      timestamp: "not-a-number",
    });
    expect(parseJobMessage(msg)).toBeNull();
  });
});

describe("createInitialPayload", () => {
  it("should create a JSON string with all fields", () => {
    const payload = createInitialPayload(
      "job-456",
      "processData",
      { input: "test" },
      "/tmp/donkeylabs-jobs/job_456.sock"
    );

    const parsed = JSON.parse(payload);
    expect(parsed.jobId).toBe("job-456");
    expect(parsed.name).toBe("processData");
    expect(parsed.data).toEqual({ input: "test" });
    expect(parsed.socketPath).toBe("/tmp/donkeylabs-jobs/job_456.sock");
  });

  it("should handle null data", () => {
    const payload = createInitialPayload("job-1", "myJob", null, "/tmp/sock");
    const parsed = JSON.parse(payload);
    expect(parsed.data).toBeNull();
  });

  it("should produce valid JSON", () => {
    const payload = createInitialPayload("id", "name", { nested: { deep: true } }, "/path");
    expect(() => JSON.parse(payload)).not.toThrow();
  });
});

describe("generateSocketPath", () => {
  it("should combine socketDir and jobId into a path", () => {
    const result = generateSocketPath("/tmp/donkeylabs-jobs", "abc-123");
    expect(result).toBe("/tmp/donkeylabs-jobs/job_abc-123.sock");
  });

  it("should work with different directory paths", () => {
    const result = generateSocketPath("/var/run/jobs", "xyz");
    expect(result).toBe("/var/run/jobs/job_xyz.sock");
  });
});

describe("Type Guards", () => {
  function makeMsg(type: string, extra: Record<string, any> = {}): AnyExternalJobMessage {
    return {
      type: type as any,
      jobId: "job-1",
      timestamp: Date.now(),
      ...extra,
    } as AnyExternalJobMessage;
  }

  describe("isStartedMessage", () => {
    it("should return true for started messages", () => {
      expect(isStartedMessage(makeMsg("started"))).toBe(true);
    });

    it("should return false for other message types", () => {
      expect(isStartedMessage(makeMsg("progress", { percent: 10 }))).toBe(false);
      expect(isStartedMessage(makeMsg("completed"))).toBe(false);
      expect(isStartedMessage(makeMsg("failed", { error: "err" }))).toBe(false);
      expect(isStartedMessage(makeMsg("heartbeat"))).toBe(false);
      expect(isStartedMessage(makeMsg("log", { level: "info", message: "hi" }))).toBe(false);
    });
  });

  describe("isProgressMessage", () => {
    it("should return true for progress messages", () => {
      expect(isProgressMessage(makeMsg("progress", { percent: 50 }))).toBe(true);
    });

    it("should return false for other message types", () => {
      expect(isProgressMessage(makeMsg("started"))).toBe(false);
      expect(isProgressMessage(makeMsg("completed"))).toBe(false);
    });
  });

  describe("isHeartbeatMessage", () => {
    it("should return true for heartbeat messages", () => {
      expect(isHeartbeatMessage(makeMsg("heartbeat"))).toBe(true);
    });

    it("should return false for other message types", () => {
      expect(isHeartbeatMessage(makeMsg("started"))).toBe(false);
      expect(isHeartbeatMessage(makeMsg("log", { level: "info", message: "hi" }))).toBe(false);
    });
  });

  describe("isLogMessage", () => {
    it("should return true for log messages", () => {
      expect(isLogMessage(makeMsg("log", { level: "warn", message: "alert" }))).toBe(true);
    });

    it("should return false for other message types", () => {
      expect(isLogMessage(makeMsg("heartbeat"))).toBe(false);
      expect(isLogMessage(makeMsg("progress", { percent: 10 }))).toBe(false);
    });
  });

  describe("isCompletedMessage", () => {
    it("should return true for completed messages", () => {
      expect(isCompletedMessage(makeMsg("completed"))).toBe(true);
    });

    it("should return false for other message types", () => {
      expect(isCompletedMessage(makeMsg("failed", { error: "err" }))).toBe(false);
      expect(isCompletedMessage(makeMsg("started"))).toBe(false);
    });
  });

  describe("isFailedMessage", () => {
    it("should return true for failed messages", () => {
      expect(isFailedMessage(makeMsg("failed", { error: "err" }))).toBe(true);
    });

    it("should return false for other message types", () => {
      expect(isFailedMessage(makeMsg("completed"))).toBe(false);
      expect(isFailedMessage(makeMsg("started"))).toBe(false);
    });
  });

  describe("isExternalJob", () => {
    it("should return true for external jobs", () => {
      const externalJob: ExternalJob = {
        id: "job-1",
        name: "processData",
        data: {},
        status: "running",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 1,
        external: true,
        pid: 1234,
        socketPath: "/tmp/job.sock",
        processState: "running",
      };
      expect(isExternalJob(externalJob)).toBe(true);
    });

    it("should return false for regular jobs", () => {
      const regularJob: Job = {
        id: "job-2",
        name: "sendEmail",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 3,
      };
      expect(isExternalJob(regularJob)).toBe(false);
    });

    it("should return false when external is false", () => {
      const job = {
        id: "job-3",
        name: "test",
        data: {},
        status: "pending" as const,
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 1,
        external: false,
      } as Job;
      expect(isExternalJob(job)).toBe(false);
    });

    it("should return false when external is undefined", () => {
      const job: Job = {
        id: "job-4",
        name: "test",
        data: {},
        status: "pending",
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 1,
      };
      expect(isExternalJob(job)).toBe(false);
    });
  });
});
