import { z } from "zod";

// Rate limiting configuration schema with secure defaults
export const RateLimitConfigSchema = z
  .object({
    // Maximum attempts within the time window
    maxAttempts: z.number().min(1).default(400), // 400 req/min - allows more concurrent usage

    // Time window options (human readable)
    window: z.enum(["30s", "1m", "5m", "15m", "1h", "24h"]).default("1m"),

    // Key generation strategy for different scenarios
    keyStrategy: z
      .enum([
        "ip", // Just IP address (default for most endpoints)
        "ip-user", // IP + username (for auth endpoints)
        "ip-endpoint", // IP + endpoint path (for endpoint-specific limits)
        "user", // Just username (requires authentication)
        "global", // Single global bucket (for system-wide limits)
      ])
      .default("ip"),

    // Advanced options
    skipAuthenticated: z.boolean().default(false), // Skip rate limiting for authenticated users

    // Custom error message
    errorMessage: z.string().default("Demasiados intentos. Inténtalo de nuevo más tarde."),
  })
  .partial(); // Make all fields optional with defaults

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

// Helper function to convert human-readable time to milliseconds
export function parseTimeWindow(window: string): number {
  const timeMap: Record<string, number> = {
    "30s": 30 * 1000,
    "1m": 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
  };

  return timeMap[window] || 60 * 1000; // Default to 1 minute
}

// Predefined rate limiting configurations for common scenarios
export const RATE_LIMIT_PRESETS = {
  // General API usage - allows multiple queries per view
  DEFAULT: {
    maxAttempts: 400, // 400 req/min - increased capacity
    window: "1m",
    keyStrategy: "ip",
  } as RateLimitConfig,

  // Authentication endpoints - moderate for OTP
  AUTH_STRICT: {
    maxAttempts: 10, // 10 OTP login attempts (increased from 5)
    window: "15m", // 15 minute lockout
    keyStrategy: "ip-user",
    errorMessage: "Demasiados intentos de autenticación.",
  } as RateLimitConfig,

  // Authentication challenges - strict for passkey
  AUTH_MODERATE: {
    maxAttempts: 5, // 5 passkey attempts (decreased from 10)
    window: "5m",
    keyStrategy: "ip-user",
    errorMessage: "Demasiados intentos de verificación.",
  } as RateLimitConfig,

  // Challenge generation - lenient
  AUTH_LENIENT: {
    maxAttempts: 30, // Allow UI retries for challenges
    window: "1m",
    keyStrategy: "ip",
    errorMessage: "Demasiadas solicitudes rápidas.",
  } as RateLimitConfig,

  // Username enumeration protection
  USERNAME_CHECK: {
    maxAttempts: 20,
    window: "1m",
    keyStrategy: "ip",
    errorMessage: "Demasiados intentos. Inténtalo de nuevo más tarde.",
  } as RateLimitConfig,

  // Read-heavy endpoints (listings, dropdowns)
  READ_HEAVY: {
    maxAttempts: 800, // 800 requests per minute for heavy read operations
    window: "1m",
    keyStrategy: "ip",
  } as RateLimitConfig,

  // Write endpoints - more restrictive
  WRITE_RESTRICTIVE: {
    maxAttempts: 60, // 1 write per second max
    window: "1m",
    keyStrategy: "ip-user",
  } as RateLimitConfig,

  // Global system protection
  GLOBAL_PROTECTION: {
    maxAttempts: 1000, // System-wide protection
    window: "1m",
    keyStrategy: "ip",
  } as RateLimitConfig,
} as const;
