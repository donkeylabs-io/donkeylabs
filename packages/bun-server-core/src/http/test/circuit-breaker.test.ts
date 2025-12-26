import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CircuitBreaker, CircuitBreakerOpenError, circuitBreakerRegistry } from "../circuit-breaker";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;
  const originalNow = Date.now;

  beforeEach(() => {
    breaker = new CircuitBreaker("test-service", {
      failureThreshold: 3,
      resetTimeout: 1000,
      successThreshold: 2,
    });
  });

  afterEach(() => {
    Date.now = originalNow;
    circuitBreakerRegistry.clear();
  });

  describe("state transitions", () => {
    it("starts in CLOSED state", () => {
      expect(breaker.getState()).toBe("CLOSED");
    });

    it("transitions to OPEN after failure threshold is reached", () => {
      expect(breaker.getState()).toBe("CLOSED");

      // Record failures
      breaker.recordFailure(new Error("fail 1"));
      expect(breaker.getState()).toBe("CLOSED");

      breaker.recordFailure(new Error("fail 2"));
      expect(breaker.getState()).toBe("CLOSED");

      breaker.recordFailure(new Error("fail 3"));
      expect(breaker.getState()).toBe("OPEN");
    });

    it("transitions to HALF_OPEN after reset timeout", () => {
      Date.now = () => 1000;

      // Open the circuit
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      expect(breaker.getState()).toBe("OPEN");

      // Not enough time passed
      Date.now = () => 1500;
      expect(breaker.canExecute()).toBe(false);
      expect(breaker.getState()).toBe("OPEN");

      // Reset timeout passed
      Date.now = () => 2001;
      expect(breaker.canExecute()).toBe(true);
      expect(breaker.getState()).toBe("HALF_OPEN");
    });

    it("transitions from HALF_OPEN to CLOSED after success threshold", () => {
      Date.now = () => 1000;

      // Open the circuit
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));

      // Transition to HALF_OPEN
      Date.now = () => 2001;
      breaker.canExecute();
      expect(breaker.getState()).toBe("HALF_OPEN");

      // Record successes
      breaker.recordSuccess();
      expect(breaker.getState()).toBe("HALF_OPEN");

      breaker.recordSuccess();
      expect(breaker.getState()).toBe("CLOSED");
    });

    it("transitions from HALF_OPEN back to OPEN on failure", () => {
      Date.now = () => 1000;

      // Open the circuit
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));

      // Transition to HALF_OPEN
      Date.now = () => 2001;
      breaker.canExecute();
      expect(breaker.getState()).toBe("HALF_OPEN");

      // Record failure
      breaker.recordFailure(new Error("fail"));
      expect(breaker.getState()).toBe("OPEN");
    });
  });

  describe("canExecute", () => {
    it("returns true in CLOSED state", () => {
      expect(breaker.canExecute()).toBe(true);
    });

    it("returns false in OPEN state before timeout", () => {
      Date.now = () => 1000;

      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));

      Date.now = () => 1500;
      expect(breaker.canExecute()).toBe(false);
    });

    it("returns true in OPEN state after timeout", () => {
      Date.now = () => 1000;

      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));

      Date.now = () => 2001;
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe("HALF_OPEN concurrent request limiting", () => {
    it("limits concurrent requests in HALF_OPEN state", async () => {
      Date.now = () => 1000;

      // Open the circuit
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));

      // Transition to HALF_OPEN
      Date.now = () => 2001;

      // First request should be allowed
      expect(breaker.canExecute()).toBe(true);

      // Start a long-running request
      const promise = breaker.execute(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "success";
      });

      // Second concurrent request should be blocked
      expect(breaker.canExecute()).toBe(false);

      // Wait for first request to complete
      await promise;

      // Now another request should be allowed
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe("execute", () => {
    it("executes function when circuit is closed", async () => {
      const result = await breaker.execute(async () => "success");
      expect(result).toBe("success");
    });

    it("throws CircuitBreakerOpenError when circuit is open", async () => {
      Date.now = () => 1000;

      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));

      Date.now = () => 1500;

      try {
        await breaker.execute(async () => "success");
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error instanceof CircuitBreakerOpenError).toBe(true);
      }
    });

    it("records success on successful execution", async () => {
      await breaker.execute(async () => "success");
      expect(breaker.getStats().failureCount).toBe(0);
    });

    it("records failure and re-throws on failed execution", async () => {
      const error = new Error("test error");

      try {
        await breaker.execute(async () => {
          throw error;
        });
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBe(error);
      }

      expect(breaker.getStats().failureCount).toBe(1);
    });
  });

  describe("reset", () => {
    it("resets circuit breaker to initial state", () => {
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      expect(breaker.getState()).toBe("OPEN");

      breaker.reset();

      expect(breaker.getState()).toBe("CLOSED");
      expect(breaker.getStats().failureCount).toBe(0);
    });
  });

  describe("callbacks", () => {
    it("calls onStateChange when state changes", () => {
      const stateChanges: { from: string; to: string }[] = [];

      breaker = new CircuitBreaker("test-service", {
        failureThreshold: 2,
        onStateChange: (from, to) => {
          stateChanges.push({ from, to });
        },
      });

      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));

      expect(stateChanges).toEqual([{ from: "CLOSED", to: "OPEN" }]);
    });

    it("calls onFailure when failure is recorded", () => {
      const failures: Error[] = [];

      breaker = new CircuitBreaker("test-service", {
        failureThreshold: 5,
        onFailure: (error) => {
          failures.push(error);
        },
      });

      const error = new Error("test error");
      breaker.recordFailure(error);

      expect(failures.length).toBe(1);
      expect(failures[0]).toBe(error);
    });
  });
});

describe("CircuitBreakerRegistry", () => {
  afterEach(() => {
    circuitBreakerRegistry.clear();
  });

  it("creates and returns circuit breakers", () => {
    const breaker = circuitBreakerRegistry.get("service-a");
    expect(breaker).toBeDefined();
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("returns the same breaker for the same service name", () => {
    const breaker1 = circuitBreakerRegistry.get("service-b");
    const breaker2 = circuitBreakerRegistry.get("service-b");
    expect(breaker1).toBe(breaker2);
  });

  it("has() returns true for existing breakers", () => {
    circuitBreakerRegistry.get("service-c");
    expect(circuitBreakerRegistry.has("service-c")).toBe(true);
    expect(circuitBreakerRegistry.has("non-existent")).toBe(false);
  });

  it("remove() deletes a circuit breaker", () => {
    circuitBreakerRegistry.get("service-d");
    expect(circuitBreakerRegistry.has("service-d")).toBe(true);

    const removed = circuitBreakerRegistry.remove("service-d");
    expect(removed).toBe(true);
    expect(circuitBreakerRegistry.has("service-d")).toBe(false);
  });

  it("clear() removes all circuit breakers", () => {
    circuitBreakerRegistry.get("service-e");
    circuitBreakerRegistry.get("service-f");
    expect(circuitBreakerRegistry.size()).toBe(2);

    circuitBreakerRegistry.clear();
    expect(circuitBreakerRegistry.size()).toBe(0);
  });

  it("resetAll() resets all circuit breakers", () => {
    const breaker1 = circuitBreakerRegistry.get("service-g", { failureThreshold: 2 });
    const breaker2 = circuitBreakerRegistry.get("service-h", { failureThreshold: 2 });

    breaker1.recordFailure(new Error("fail"));
    breaker1.recordFailure(new Error("fail"));
    breaker2.recordFailure(new Error("fail"));
    breaker2.recordFailure(new Error("fail"));

    expect(breaker1.getState()).toBe("OPEN");
    expect(breaker2.getState()).toBe("OPEN");

    circuitBreakerRegistry.resetAll();

    expect(breaker1.getState()).toBe("CLOSED");
    expect(breaker2.getState()).toBe("CLOSED");
  });

  it("getAllStats() returns stats for all breakers", () => {
    circuitBreakerRegistry.get("service-i");
    circuitBreakerRegistry.get("service-j");

    const stats = circuitBreakerRegistry.getAllStats();
    expect(stats.length).toBe(2);
    expect(stats.map((s) => s.serviceName).sort()).toEqual(["service-i", "service-j"]);
  });
});
