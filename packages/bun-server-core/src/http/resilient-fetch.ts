/**
 * Resilient Fetch - HTTP client with timeout, retry, and circuit breaker support
 *
 * Features:
 * - Configurable timeout (default: 10s)
 * - Automatic retry with exponential backoff
 * - Circuit breaker integration
 * - Request/response logging
 * - Error classification
 */

import { CircuitBreaker, CircuitBreakerOpenError, circuitBreakerRegistry } from "./circuit-breaker";
import type { CircuitBreakerOptions } from "./circuit-breaker";
import { logger } from "@donkeylabs/audit-logs";

export interface ResilientFetchOptions {
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Number of retry attempts (default: 3) */
  retries?: number;
  /** Initial retry delay in ms, doubles each attempt (default: 1000) */
  retryDelay?: number;
  /** Maximum retry delay in ms (default: 10000) */
  maxRetryDelay?: number;
  /** HTTP status codes that should trigger a retry (default: [408, 429, 500, 502, 503, 504]) */
  retryableStatuses?: number[];
  /** Circuit breaker options (if provided, enables circuit breaker) */
  circuitBreaker?: {
    name: string;
    options?: Partial<CircuitBreakerOptions>;
  };
  /** Enable request/response logging (default: false in prod) */
  logging?: boolean;
  /** Custom headers to add to all requests */
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_OPTIONS: Required<Omit<ResilientFetchOptions, "circuitBreaker" | "defaultHeaders">> = {
  timeout: 10000,
  retries: 3,
  retryDelay: 1000,
  maxRetryDelay: 10000,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
  logging: Bun.env.STAGE === "dev",
};

export class TimeoutError extends Error {
  readonly isTimeout = true;

  constructor(
    message: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class HttpError extends Error {
  readonly isHttpError = true;

  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RetryExhaustedError extends Error {
  readonly isRetryExhausted = true;

  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: Error,
  ) {
    super(message);
    this.name = "RetryExhaustedError";
  }
}

/**
 * Fetch with timeout support using AbortController
 * Uses a flag to distinguish intentional timeout aborts from other abort reasons
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeout: number },
): Promise<Response> {
  const { timeout, ...fetchInit } = init;
  const controller = new AbortController();
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
    });
    // Clear timeout immediately after successful fetch to prevent race
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    // Only treat as timeout if we actually triggered the abort
    if (timedOut && error instanceof Error && error.name === "AbortError") {
      throw new TimeoutError(`Request timed out after ${timeout}ms: ${url}`, timeout);
    }
    throw error;
  }
}

/**
 * Calculate retry delay with exponential backoff and jitter
 */
function calculateRetryDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (error instanceof TypeError) return true; // Network errors
  if (error instanceof Error && error.message.includes("fetch failed")) return true;
  return false;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a resilient fetch client with configurable options
 */
export function createResilientFetch(clientOptions: ResilientFetchOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...clientOptions };
  const circuitBreaker = clientOptions.circuitBreaker
    ? circuitBreakerRegistry.get(clientOptions.circuitBreaker.name, clientOptions.circuitBreaker.options)
    : null;

  /**
   * Execute fetch with timeout, retry, and circuit breaker
   */
  async function resilientFetch<T = unknown>(
    url: string,
    init: RequestInit = {},
  ): Promise<{ data: T; response: Response }> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    // Merge default headers
    const headers = new Headers(init.headers);
    if (options.defaultHeaders) {
      Object.entries(options.defaultHeaders).forEach(([key, value]) => {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      });
    }

    const fetchFn = async (): Promise<{ data: T; response: Response }> => {
      for (let attempt = 0; attempt <= options.retries; attempt++) {
        try {
          if (options.logging) {
            logger.http.debug(`${init.method || "GET"} ${url} (attempt ${attempt + 1}/${options.retries + 1})`);
          }

          const response = await fetchWithTimeout(url, {
            ...init,
            headers,
            timeout: options.timeout,
          });

          // Check if response is retryable
          if (!response.ok && options.retryableStatuses.includes(response.status)) {
            const errorBody = await response.text().catch(() => "");
            lastError = new HttpError(
              `HTTP ${response.status}: ${response.statusText}`,
              response.status,
              response.statusText,
              url,
              errorBody,
            );

            if (attempt < options.retries) {
              const delay = calculateRetryDelay(attempt, options.retryDelay, options.maxRetryDelay);
              if (options.logging) {
                logger.http.debug(`Retryable error (${response.status}), retrying in ${Math.round(delay)}ms...`);
              }
              await sleep(delay);
              continue;
            }
          }

          // Non-retryable error status
          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new HttpError(
              `HTTP ${response.status}: ${response.statusText}`,
              response.status,
              response.statusText,
              url,
              errorBody,
            );
          }

          // Success - parse response
          const contentType = response.headers.get("content-type") || "";
          let data: T;

          if (contentType.includes("application/json")) {
            data = (await response.json()) as T;
          } else {
            data = (await response.text()) as unknown as T;
          }

          if (options.logging) {
            const duration = Date.now() - startTime;
            logger.http.debug(`Success: ${url} (${duration}ms)`);
          }

          return { data, response };
        } catch (error) {
          lastError = error as Error;

          // Don't retry circuit breaker errors
          if (error instanceof CircuitBreakerOpenError) {
            throw error;
          }

          // Check if error is retryable
          if (isRetryableError(error) && attempt < options.retries) {
            const delay = calculateRetryDelay(attempt, options.retryDelay, options.maxRetryDelay);
            if (options.logging) {
              logger.http.debug(`Error: ${(error as Error).message}, retrying in ${Math.round(delay)}ms...`);
            }
            await sleep(delay);
            continue;
          }

          throw error;
        }
      }

      // All retries exhausted
      throw new RetryExhaustedError(
        `All ${options.retries + 1} attempts failed for ${url}`,
        options.retries + 1,
        lastError!,
      );
    };

    // Execute with or without circuit breaker
    if (circuitBreaker) {
      return circuitBreaker.execute(fetchFn);
    }
    return fetchFn();
  }

  /**
   * GET request helper
   */
  async function get<T = unknown>(url: string, init: Omit<RequestInit, "method" | "body"> = {}) {
    return resilientFetch<T>(url, { ...init, method: "GET" });
  }

  /**
   * POST request helper
   */
  async function post<T = unknown>(url: string, body: unknown, init: Omit<RequestInit, "method" | "body"> = {}) {
    // Safely convert headers to a plain object
    let existingHeaders: Record<string, string> = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          existingHeaders[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([key, value]) => {
          existingHeaders[key] = value;
        });
      } else {
        existingHeaders = init.headers as Record<string, string>;
      }
    }

    return resilientFetch<T>(url, {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        ...existingHeaders,
      },
    });
  }

  /**
   * Fetch raw response (for file downloads, streaming, etc.)
   * Returns the Response object directly without parsing
   */
  async function fetchRaw(url: string, init: RequestInit = {}): Promise<Response> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    // Merge default headers
    const headers = new Headers(init.headers);
    if (options.defaultHeaders) {
      Object.entries(options.defaultHeaders).forEach(([key, value]) => {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      });
    }

    const fetchFn = async (): Promise<Response> => {
      for (let attempt = 0; attempt <= options.retries; attempt++) {
        try {
          if (options.logging) {
            logger.http.tag("Raw").debug(`${init.method || "GET"} ${url} (attempt ${attempt + 1}/${options.retries + 1})`);
          }

          const response = await fetchWithTimeout(url, {
            ...init,
            headers,
            timeout: options.timeout,
          });

          // Check if response is retryable
          if (!response.ok && options.retryableStatuses.includes(response.status)) {
            lastError = new HttpError(
              `HTTP ${response.status}: ${response.statusText}`,
              response.status,
              response.statusText,
              url,
            );

            if (attempt < options.retries) {
              const delay = calculateRetryDelay(attempt, options.retryDelay, options.maxRetryDelay);
              if (options.logging) {
                logger.http.tag("Raw").debug(`Retryable error (${response.status}), retrying in ${Math.round(delay)}ms...`);
              }
              await sleep(delay);
              continue;
            }
          }

          // Non-retryable error status
          if (!response.ok) {
            throw new HttpError(
              `HTTP ${response.status}: ${response.statusText}`,
              response.status,
              response.statusText,
              url,
            );
          }

          if (options.logging) {
            const duration = Date.now() - startTime;
            logger.http.tag("Raw").debug(`Success: ${url} (${duration}ms)`);
          }

          return response;
        } catch (error) {
          lastError = error as Error;

          if (error instanceof CircuitBreakerOpenError) {
            throw error;
          }

          if (isRetryableError(error) && attempt < options.retries) {
            const delay = calculateRetryDelay(attempt, options.retryDelay, options.maxRetryDelay);
            if (options.logging) {
              logger.http.tag("Raw").debug(`Error: ${(error as Error).message}, retrying in ${Math.round(delay)}ms...`);
            }
            await sleep(delay);
            continue;
          }

          throw error;
        }
      }

      throw new RetryExhaustedError(
        `All ${options.retries + 1} attempts failed for ${url}`,
        options.retries + 1,
        lastError!,
      );
    };

    if (circuitBreaker) {
      return circuitBreaker.execute(fetchFn);
    }
    return fetchFn();
  }

  /**
   * Get circuit breaker stats
   */
  function getCircuitBreakerStats() {
    return circuitBreaker?.getStats() ?? null;
  }

  return {
    fetch: resilientFetch,
    get,
    post,
    fetchRaw,
    getCircuitBreakerStats,
    circuitBreaker,
  };
}

/**
 * Default resilient fetch instance (no circuit breaker)
 */
export const resilientFetch = createResilientFetch();
