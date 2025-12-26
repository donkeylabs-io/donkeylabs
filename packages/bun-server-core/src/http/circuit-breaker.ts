/**
 * Circuit Breaker Pattern Implementation
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit is tripped, requests fail immediately
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 *
 * Transitions:
 * - CLOSED -> OPEN: When failure threshold is exceeded
 * - OPEN -> HALF_OPEN: After reset timeout expires
 * - HALF_OPEN -> CLOSED: When a test request succeeds
 * - HALF_OPEN -> OPEN: When a test request fails
 */

import { logger } from "@donkeylabs/audit-logs";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting to close circuit (default: 30000) */
  resetTimeout: number;
  /** Number of successful requests needed to close circuit from half-open (default: 2) */
  successThreshold: number;
  /** Optional callback when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState, serviceName: string) => void;
  /** Optional callback for monitoring */
  onFailure?: (error: Error, serviceName: string) => void;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeout: 30000,
  successThreshold: 2,
};

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private options: CircuitBreakerOptions;
  /** Track in-flight requests during HALF_OPEN to prevent thundering herd */
  private halfOpenInFlight = 0;
  /** Maximum concurrent requests allowed in HALF_OPEN state */
  private readonly halfOpenMaxConcurrent = 1;
  /** Flag to prevent TOCTOU race during OPEN -> HALF_OPEN transition */
  private transitioning = false;

  constructor(
    private serviceName: string,
    options: Partial<CircuitBreakerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats() {
    return {
      serviceName: this.serviceName,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  private setState(newState: CircuitState) {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.options.onStateChange?.(oldState, newState, this.serviceName);
      logger.http.tag("Circuit").info(`[${this.serviceName}] ${oldState} -> ${newState}`);
    }
  }

  private shouldAttemptReset(): boolean {
    return Date.now() - this.lastFailureTime >= this.options.resetTimeout;
  }

  /**
   * Check if a request can be executed.
   * In HALF_OPEN state, limits concurrent requests to prevent thundering herd.
   * Uses transitioning flag to prevent TOCTOU race during OPEN -> HALF_OPEN transition.
   */
  canExecute(): boolean {
    switch (this.state) {
      case "CLOSED":
        return true;

      case "OPEN":
        // Prevent TOCTOU race: if already transitioning, reject additional requests
        if (this.transitioning) {
          return false;
        }

        if (this.shouldAttemptReset()) {
          // Atomically claim the transition
          this.transitioning = true;
          try {
            this.setState("HALF_OPEN");
            this.successCount = 0;
            this.halfOpenInFlight = 0;
            // Allow first test request
            return true;
          } finally {
            this.transitioning = false;
          }
        }
        return false;

      case "HALF_OPEN":
        // Only allow limited concurrent requests in HALF_OPEN to prevent flood
        if (this.halfOpenInFlight >= this.halfOpenMaxConcurrent) {
          return false;
        }
        return true;

      default:
        return false;
    }
  }

  /**
   * Mark that a request is starting (for HALF_OPEN tracking)
   */
  private markRequestStart(): void {
    if (this.state === "HALF_OPEN") {
      this.halfOpenInFlight++;
    }
  }

  /**
   * Mark that a request has completed (for HALF_OPEN tracking)
   */
  private markRequestEnd(): void {
    if (this.state === "HALF_OPEN" && this.halfOpenInFlight > 0) {
      this.halfOpenInFlight--;
    }
  }

  recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        this.setState("CLOSED");
        this.successCount = 0;
      }
    }
  }

  recordFailure(error: Error): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.options.onFailure?.(error, this.serviceName);

    if (this.state === "HALF_OPEN") {
      this.setState("OPEN");
      this.successCount = 0;
    } else if (this.failureCount >= this.options.failureThreshold) {
      this.setState("OPEN");
    }
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      const error = new CircuitBreakerOpenError(
        `Circuit breaker is OPEN for service: ${this.serviceName}. ` +
          `Will retry after ${Math.ceil((this.options.resetTimeout - (Date.now() - this.lastFailureTime)) / 1000)}s`,
      );
      throw error;
    }

    // Track in-flight request for HALF_OPEN state
    this.markRequestStart();

    try {
      const result = await fn();
      this.markRequestEnd();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.markRequestEnd();
      this.recordFailure(error as Error);
      throw error;
    }
  }

  /**
   * Reset the circuit breaker to initial state
   */
  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.halfOpenInFlight = 0;
    this.transitioning = false;
  }
}

export class CircuitBreakerOpenError extends Error {
  readonly isCircuitBreakerOpen = true;

  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

/**
 * Configuration for circuit breaker registry
 */
interface RegistryConfig {
  /** Maximum number of circuit breakers to keep (default: 1000) */
  maxBreakers?: number;
  /** TTL in ms after which unused breakers can be evicted (default: 30 minutes) */
  evictionTtl?: number;
}

const DEFAULT_REGISTRY_CONFIG: Required<RegistryConfig> = {
  maxBreakers: 1000,
  evictionTtl: 30 * 60 * 1000, // 30 minutes
};

/**
 * Registry for managing multiple circuit breakers.
 * Includes LRU-like eviction to prevent unbounded memory growth.
 */
class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private lastAccessTime = new Map<string, number>();
  private config: Required<RegistryConfig>;

  constructor(config: RegistryConfig = {}) {
    this.config = { ...DEFAULT_REGISTRY_CONFIG, ...config };
  }

  get(serviceName: string, options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
    let breaker = this.breakers.get(serviceName);
    if (!breaker) {
      // Evict old entries if we're at capacity
      this.evictIfNeeded();

      breaker = new CircuitBreaker(serviceName, options);
      this.breakers.set(serviceName, breaker);
    }

    // Update last access time for LRU tracking
    this.lastAccessTime.set(serviceName, Date.now());
    return breaker;
  }

  /**
   * Evict least recently used breakers if we're at capacity
   */
  private evictIfNeeded(): void {
    if (this.breakers.size < this.config.maxBreakers) {
      return;
    }

    const now = Date.now();
    const entries: Array<{ name: string; lastAccess: number; state: CircuitState }> = [];

    // Collect entries with their last access time
    for (const [name, breaker] of this.breakers) {
      const lastAccess = this.lastAccessTime.get(name) || 0;
      entries.push({ name, lastAccess, state: breaker.getState() });
    }

    // Sort by last access time (oldest first)
    entries.sort((a, b) => a.lastAccess - b.lastAccess);

    // Evict entries that are:
    // 1. Old enough (past TTL)
    // 2. In CLOSED state (don't evict OPEN or HALF_OPEN breakers that are actively protecting)
    let evictCount = Math.max(1, Math.floor(this.config.maxBreakers * 0.1)); // Evict at least 10%

    for (const entry of entries) {
      if (evictCount <= 0) break;

      const age = now - entry.lastAccess;
      // Only evict CLOSED breakers that are old enough
      if (entry.state === "CLOSED" && age > this.config.evictionTtl) {
        this.breakers.delete(entry.name);
        this.lastAccessTime.delete(entry.name);
        evictCount--;
      }
    }
  }

  /**
   * Check if a circuit breaker exists for a service
   */
  has(serviceName: string): boolean {
    return this.breakers.has(serviceName);
  }

  getAll(): Map<string, CircuitBreaker> {
    return new Map(this.breakers);
  }

  getAllStats() {
    return Array.from(this.breakers.values()).map((b) => b.getStats());
  }

  reset(serviceName: string): void {
    this.breakers.get(serviceName)?.reset();
  }

  resetAll(): void {
    this.breakers.forEach((breaker) => breaker.reset());
  }

  /**
   * Remove a circuit breaker from the registry.
   * Use this to clean up breakers that are no longer needed.
   */
  remove(serviceName: string): boolean {
    this.lastAccessTime.delete(serviceName);
    return this.breakers.delete(serviceName);
  }

  /**
   * Remove all circuit breakers from the registry.
   * Useful for testing or cleanup during shutdown.
   */
  clear(): void {
    this.breakers.clear();
    this.lastAccessTime.clear();
  }

  /**
   * Get the number of registered circuit breakers
   */
  size(): number {
    return this.breakers.size;
  }
}

// Singleton registry
export const circuitBreakerRegistry = new CircuitBreakerRegistry();
