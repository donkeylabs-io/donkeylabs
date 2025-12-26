/**
 * Clean Rate Limiting Implementation
 *
 * Core design principles:
 * 1. Framework-agnostic core (RateLimit class)
 * 2. Clean input: pass keys directly, not request objects
 * 3. No framework-specific middleware - users decide integration
 * 4. Graceful fallbacks for optional authentication data
 * 5. Runtime username parameter for maximum flexibility
 *
 * Usage:
 *
 * // Direct usage (framework-agnostic)
 * const limiter = new RateLimit(cache, 60000, 5);
 * const result = await limiter.check("user:123");
 * if (!result.allowed) { ... }
 *
 * // Using RateLimitBuilder with configs
 * const builder = new RateLimitBuilder(cache);
 * const limiter = builder.build({
 *   maxAttempts: 10,
 *   window: "1m",
 *   keyStrategy: "ip-user"
 * });
 * const keyExtractor = builder.buildKeyExtractor({
 *   keyStrategy: "ip-user"
 * });
 *
 * // Extract username from your custom logic
 * const username = getUsernameFromRequest(req);
 * const key = keyExtractor(req, username);
 * const result = await limiter.check(key);
 *
 * // Pre-configured rate limiters for common scenarios
 * const limiters = createRateLimiters(cache);
 * const authLimiter = limiters.auth.otp;
 * const apiLimiter = limiters.api.default;
 *
 * // Key strategies with graceful fallbacks:
 * // - "user": Falls back to IP-based key if username not provided
 * // - "ip-user": Falls back to IP-only key if username not provided
 * // - "ip": Always uses IP address
 * // - "ip-endpoint": Uses IP + endpoint path
 * // - "global": Single global bucket for all requests
 *
 * // Integration with any framework (Express, Fastify, etc.)
 * app.get("/api/data", async (req, res) => {
 *   const username = extractUsername(req); // Your custom logic
 *   const key = keyExtractor(req, username);
 *   const result = await limiter.check(key);
 *
 *   if (!result.allowed) {
 *     return res.status(429).json({ error: "Rate limited" });
 *   }
 *
 *   // Your business logic here
 *   res.json({ data: "success" });
 * });
 */

import type { Request } from "express";
import type { SimpleCache } from "../cache";
import type { RateLimitConfig } from "@donkeylabs/core/src/interfaces/server/rate-limit";
import { parseTimeWindow } from "@donkeylabs/core/src/interfaces/server/rate-limit";
import geoip from "geoip-lite";
import { getClientIP, isPrivateIP } from "./index";
import { LOG } from "../log";

// Core types - framework agnostic
export interface RateLimitResult {
  allowed: boolean;
  count: number;
  resetTime: number;
  remaining: number;
}

interface RateLimitData {
  count: number;
  firstAttempt: number;
}

// Core rate limiter - completely decoupled from Express
export class RateLimit {
  constructor(
    private cache: SimpleCache,
    private windowMs: number,
    private maxAttempts: number,
  ) {}

  async check(key: string): Promise<RateLimitResult> {
    // Use atomic increment to prevent race conditions
    const result = await this.cache.atomicRateLimitIncrement(key, this.windowMs);

    const resetTime = result.firstAttempt + this.windowMs;

    return {
      allowed: result.count <= this.maxAttempts,
      count: result.count,
      resetTime,
      remaining: Math.max(0, this.maxAttempts - result.count),
    };
  }
}

// Extended result that includes the limit for headers
export interface RateLimitResultWithLimit extends RateLimitResult {
  limit: number;
}

class RateLimitAdapter {
  private rateLimit: RateLimit;
  private config: RateLimitConfig;
  private request: Request | null = null;
  private maxAttempts: number;

  constructor(cache: SimpleCache, config?: RateLimitConfig) {
    if (!config) {
      config = {
        window: "1m",
        maxAttempts: 400,
        keyStrategy: "ip",
      };
    }
    const windowMs = parseTimeWindow(config.window || "1m");
    const maxAttempts = config.maxAttempts || 400;

    this.config = config;
    this.maxAttempts = maxAttempts;

    this.rateLimit = new RateLimit(cache, windowMs, maxAttempts);
  }

  async check(request: Request, username?: string): Promise<RateLimitResultWithLimit> {
    // Store request for later use in getLocationString
    this.request = request;

    // Check skipAuthenticated option - skip rate limiting for authenticated users
    if (this.config.skipAuthenticated && request.headers.authorization) {
      return {
        allowed: true,
        count: 0,
        resetTime: Date.now(),
        remaining: this.maxAttempts,
        limit: this.maxAttempts,
      };
    }

    const keySelector = this.getKey(request, username);
    const result = await this.rateLimit.check(keySelector);

    // Log rate limit violations
    if (!result.allowed) {
      const ip = getClientIP(request);
      LOG.tag("RateLimit").warn("Rate limit exceeded", {
        ip,
        path: request.path,
        key: keySelector,
        count: result.count,
        limit: this.maxAttempts,
        location: this.getLocationString(),
      });
    } else if (result.count > this.maxAttempts * 0.8) {
      // Warn when approaching limit (80%+)
      LOG.tag("RateLimit").debug("Approaching rate limit", {
        path: request.path,
        count: result.count,
        limit: this.maxAttempts,
        remaining: result.remaining,
      });
    }

    return {
      ...result,
      limit: this.maxAttempts,
    };
  }

  /**
   * Returns a string with IP address and location information
   * Format: "IP: <ip> - Location: <city, region, country>" or "IP: <ip> - Location: Local/Private"
   */
  getLocationString(): string {
    if (!this.request) {
      return "IP: unknown - Location: unknown";
    }

    const ip = getClientIP(this.request);
    const geo = geoip.lookup(ip);

    // Check if it's a local/private IP
    if (isPrivateIP(ip)) {
      return `IP: ${ip} - Location: Local/Private`;
    }

    if (!geo) {
      return `IP: ${ip} - Location: Unknown`;
    }

    // Format location info
    const locationParts = [];
    if (geo.city) locationParts.push(geo.city);
    if (geo.region) locationParts.push(geo.region);
    if (geo.country) locationParts.push(geo.country);

    const locationText = locationParts.length > 0 ? locationParts.join(", ") : "Unknown Location";

    return `IP: ${ip} - Location: ${locationText}`;
  }

  private getKey(request: Request, username?: string): string {
    const strategy = this.config?.keyStrategy || "ip";
    const ip = getClientIP(request);

    switch (strategy) {
      case "ip":
        return ip;

      case "user":
        if (!username) {
          // Fallback to IP-based key when user is not provided
          return `ip:${ip}`;
        }
        return `user:${username}`;

      case "ip-user":
        if (username) {
          return `ip:${ip}:user:${username}`;
        }
        // Fallback to IP-only when user is not provided
        return `ip:${ip}`;

      case "ip-endpoint":
        return `ip:${ip}:endpoint:${request.path}`;

      case "global":
        // Single global bucket for system-wide rate limiting
        return "global";

      default:
        throw new Error(`Unknown key strategy: ${strategy}`);
    }
  }
}

// Key extraction strategies for different scenarios
export interface KeyExtractor {
  (req: Request, username?: string): string;
}

export { RateLimitAdapter as RateLimiter };
