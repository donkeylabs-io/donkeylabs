// Core Rate Limiter Service
// Request throttling with IP detection

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
  retryAfter?: number; // seconds until retry
}

export interface RateLimitAdapter {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: Date }>;
  get(key: string): Promise<{ count: number; resetAt: Date } | null>;
  reset(key: string): Promise<void>;
}

export interface RateLimiterConfig {
  adapter?: RateLimitAdapter;
}

export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

// In-memory rate limit adapter using sliding window
export class MemoryRateLimitAdapter implements RateLimitAdapter {
  private windows = new Map<string, { count: number; resetAt: Date }>();

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: Date }> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (existing && existing.resetAt.getTime() > now) {
      // Window still active
      existing.count++;
      return { count: existing.count, resetAt: existing.resetAt };
    }

    // Create new window
    const resetAt = new Date(now + windowMs);
    const entry = { count: 1, resetAt };
    this.windows.set(key, entry);

    // Clean up old entries periodically
    this.cleanup();

    return entry;
  }

  async get(key: string): Promise<{ count: number; resetAt: Date } | null> {
    const entry = this.windows.get(key);
    if (!entry) return null;

    if (entry.resetAt.getTime() <= Date.now()) {
      this.windows.delete(key);
      return null;
    }

    return entry;
  }

  async reset(key: string): Promise<void> {
    this.windows.delete(key);
  }

  private cleanup(): void {
    const now = Date.now();
    // Only cleanup occasionally to avoid performance issues
    if (Math.random() > 0.1) return;

    for (const [key, entry] of this.windows.entries()) {
      if (entry.resetAt.getTime() <= now) {
        this.windows.delete(key);
      }
    }
  }
}

class RateLimiterImpl implements RateLimiter {
  private adapter: RateLimitAdapter;

  constructor(config: RateLimiterConfig = {}) {
    this.adapter = config.adapter ?? new MemoryRateLimitAdapter();
  }

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const { count, resetAt } = await this.adapter.increment(key, windowMs);

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);

    const result: RateLimitResult = {
      allowed,
      remaining,
      limit,
      resetAt,
    };

    if (!allowed) {
      result.retryAfter = Math.ceil((resetAt.getTime() - Date.now()) / 1000);
    }

    return result;
  }

  async reset(key: string): Promise<void> {
    await this.adapter.reset(key);
  }
}

export function createRateLimiter(config?: RateLimiterConfig): RateLimiter {
  return new RateLimiterImpl(config);
}

// ==========================================
// IP Extraction Utilities
// ==========================================

/**
 * Priority order for IP detection headers:
 * 1. CF-Connecting-IP (Cloudflare)
 * 2. True-Client-IP (Akamai, Cloudflare Enterprise)
 * 3. X-Real-IP (Nginx)
 * 4. X-Forwarded-For (first IP in chain)
 * 5. Request socket address (direct connection)
 */
const IP_HEADERS = [
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
  "x-forwarded-for",
] as const;

/**
 * Extract client IP address from request headers
 * Handles various proxy configurations (Cloudflare, Nginx, etc.)
 */
export function extractClientIP(req: Request, socketAddr?: string): string {
  for (const header of IP_HEADERS) {
    const value = req.headers.get(header);
    if (value) {
      // X-Forwarded-For may contain multiple IPs: "client, proxy1, proxy2"
      if (header === "x-forwarded-for") {
        const firstIP = value.split(",")[0]?.trim();
        if (firstIP && isValidIP(firstIP)) return firstIP;
      } else {
        if (isValidIP(value)) return value;
      }
    }
  }

  // Fall back to socket address
  if (socketAddr && isValidIP(socketAddr)) {
    return socketAddr;
  }

  return "unknown";
}

/**
 * Basic IP address validation (IPv4 and IPv6)
 */
function isValidIP(ip: string): boolean {
  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Pattern.test(ip)) {
    const parts = ip.split(".").map(Number);
    return parts.every(n => n >= 0 && n <= 255);
  }

  // IPv6 pattern (simplified)
  const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  if (ipv6Pattern.test(ip)) return true;

  // IPv4-mapped IPv6
  if (ip.startsWith("::ffff:")) {
    const ipv4Part = ip.slice(7);
    return isValidIP(ipv4Part);
  }

  return false;
}

// ==========================================
// Rate Limit Helper Utilities
// ==========================================

/**
 * Parse duration string to milliseconds
 * Supports: "100ms", "10s", "5m", "1h", "1d"
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid duration format: ${duration}. Use format like "10s", "5m", "1h"`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Create a rate limit key for a specific route + IP combination
 */
export function createRateLimitKey(route: string, ip: string): string {
  return `ratelimit:${route}:${ip}`;
}
