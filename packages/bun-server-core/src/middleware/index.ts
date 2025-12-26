import express from "express";
import { Chalk } from "chalk";
import { UAParser } from "ua-parser-js";
import geoip from "geoip-lite";
import { Buffer } from "node:buffer";
import { serverStats } from "../stats";
import { SecurityMetadataSchema } from "@donkeylabs/core";
import { logger } from "@donkeylabs/audit-logs";

export * from "./errors";
export { RateLimiter, type RateLimitResult, type RateLimitResultWithLimit } from "./rate-limit";
export * from "./request-timeout";

const userAgentParser = new UAParser();

const decodeBase64Url = (value: string) => {
  try {
    const normalized = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return undefined;
  }
};

export const CHALK = new Chalk({ level: 3 });
const formatStatus = (status: number) => {
  if (status >= 500) return CHALK.bgRed.white.bold(` ${status} `);
  if (status >= 400) return CHALK.bgYellow.black.bold(` ${status} `);
  if (status >= 300) return CHALK.bgCyan.black.bold(` ${status} `);
  if (status >= 200) return CHALK.bgGreen.white.bold(` ${status} `);
  return CHALK.bgGray.white.bold(` ${status} `);
};

const formatMethod = (method: string) => {
  switch (method.toUpperCase()) {
    case "GET":
      return CHALK.bgBlue.white.bold(` ${method} `);
    case "POST":
      return CHALK.bgGreen.white.bold(` ${method} `);
    case "PUT":
      return CHALK.bgYellow.black.bold(` ${method} `);
    case "DELETE":
      return CHALK.bgRed.white.bold(` ${method} `);
    case "PATCH":
      return CHALK.bgMagenta.white.bold(` ${method} `);
    default:
      return CHALK.bgGray.white.bold(` ${method} `);
  }
};

const formatResponseTime = (time: number) => {
  const timeStr = `${time}ms`;
  if (time < 100) return CHALK.green.bold(`${timeStr}`);
  if (time < 500) return CHALK.black.bold(`${timeStr}`);
  return CHALK.bgRed.white.bold(`${timeStr}`);
};

function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

// Trusted proxy configuration
// Since we host directly on Vultr without proxies, only trust localhost for development
// X-Forwarded-For headers from external requests will be IGNORED to prevent IP spoofing
const TRUSTED_PROXIES = new Set([
  "127.0.0.1",
  "::1",
]);

// Check if an IP is a trusted proxy
function isTrustedProxy(ip: string | undefined): boolean {
  if (!ip) return false;
  // Normalize IPv6-mapped IPv4 addresses
  const normalizedIP = ip.replace(/^::ffff:/, "");
  return TRUSTED_PROXIES.has(normalizedIP);
}

// Helper function to check if IP is private/local
export function isPrivateIP(ip: string): boolean {
  if (ip === "unknown" || ip === "::1") return true;
  if (ip.startsWith("127.")) return true; // Loopback
  if (ip.startsWith("10.")) return true; // Class A private
  if (ip.startsWith("192.168.")) return true; // Class C private
  // Class B private: 172.16.0.0 - 172.31.255.255
  if (ip.startsWith("172.")) {
    const secondOctet = parseInt(ip.split(".")[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  if (ip.startsWith("169.254.")) return true; // Link-local
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // IPv6 private
  if (ip.startsWith("fe80:")) return true; // IPv6 link-local
  return false;
}

// Helper function to get client IP with proxy trust validation
export function getClientIP(req: express.Request): string {
  // Get the direct connection IP first
  const directIP = req.socket.remoteAddress || req.ip || "unknown";
  const normalizedDirectIP = directIP.replace(/^::ffff:/, "");

  // Only trust proxy headers if the direct connection is from a trusted proxy
  // OR if we're in development (direct IP is private)
  const shouldTrustHeaders = isTrustedProxy(normalizedDirectIP) || isPrivateIP(normalizedDirectIP);

  if (shouldTrustHeaders) {
    // Check for IP in various headers (for proxy/load balancer scenarios)
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      // x-forwarded-for can contain multiple IPs: client, proxy1, proxy2, ...
      // The rightmost untrusted IP is the actual client
      const ips = (typeof forwarded === "string" ? forwarded : forwarded[0])
        .split(",")
        .map((ip) => ip.trim());

      // Find the first non-trusted IP from the left (the original client)
      for (const ip of ips) {
        if (!isTrustedProxy(ip)) {
          return ip;
        }
      }
      // All IPs are trusted proxies, return the first one
      return ips[0];
    }

    const realIP = req.headers["x-real-ip"];
    if (realIP) {
      return typeof realIP === "string" ? realIP : realIP[0];
    }
  }

  // Don't trust headers - use direct connection IP
  // This prevents IP spoofing when requests don't come through trusted proxies
  return normalizedDirectIP;
}

// Helper function to format location info
function formatLocationInfo(ip: string, geo?: geoip.Lookup | null): string {
  if (isPrivateIP(ip)) {
    return CHALK.gray("Local/Private");
  }

  if (!geo) {
    return CHALK.cyan("External IP");
  }

  // Format location info
  const locationParts = [];
  if (geo.city) locationParts.push(geo.city);
  if (geo.region) locationParts.push(geo.region);
  if (geo.country) locationParts.push(geo.country);

  const locationText = locationParts.length > 0 ? locationParts.join(", ") : "Unknown Location";

  // Add flag emoji for country if available
  const countryFlag = getCountryFlag(geo.country);

  return CHALK.cyan(`${countryFlag} ${locationText}`);
}

// Helper to get flag emoji for country code
function getCountryFlag(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return "🌍";

  // Convert country code to flag emoji
  const flagEmoji = countryCode
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));

  return flagEmoji;
}

// Helper function to parse user agent
function parseUserAgent(userAgent: string) {
  const result = userAgentParser.setUA(userAgent).getResult();

  const browser = result.browser.name
    ? `${result.browser.name} ${result.browser.version || ""}`.trim()
    : "Unknown";
  const os = result.os.name ? `${result.os.name} ${result.os.version || ""}`.trim() : "Unknown";
  const device = result.device.type || "desktop";
  const isBot = /bot|crawl|spider|scraper/i.test(userAgent);

  return {
    browser,
    os,
    device,
    isBot,
    formatted: `${browser} on ${os}${device !== "desktop" ? ` (${device})` : ""}${isBot ? " [BOT]" : ""}`,
  };
}

// Helper function to detect request source
function detectRequestSource(req: express.Request): string {
  const userAgent = req.headers["user-agent"] || "";
  const referer = req.headers.referer || "";

  // Check for specific app identifiers
  if (userAgent.includes("app.pitsafrp.com")) return "🖥️  Web App";
  if (userAgent.includes("pitsafrp-mobile")) return "📱 Mobile App";

  // Check for API clients
  if (/postman|insomnia|curl|wget|httpie/i.test(userAgent)) return "🔧 API Client";

  // Check for bots
  if (/bot|crawl|spider|scraper/i.test(userAgent)) return "🤖 Bot/Crawler";

  // Check referer
  if (referer.includes("pitsafrp.com")) return "🌐 Website";
  if (referer.includes("localhost")) return "💻 Local Dev";

  // Check device type
  const parsed = parseUserAgent(userAgent);
  if (parsed.device === "mobile") return "📱 Mobile Browser";
  if (parsed.device === "tablet") return "📟 Tablet Browser";

  return "🖥️  Desktop Browser";
}

// Helper function to get username from request (if authenticated)
function getUsername(req: express.Request): string | undefined {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return undefined;

    // Decode JWT payload (without verification for stats purposes only)
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;

    const payloadJson = decodeBase64Url(parts[1]);
    if (!payloadJson) return undefined;
    const payload = JSON.parse(payloadJson);
    return payload.username || payload.sub || "authenticated_user";
  } catch (error) {
    logger.http.tag("Route").debug("Unable to decode JWT", error);
    return undefined;
  }
}

export const routeLogger = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const start = Date.now();
  const clientIP = getClientIP(req);
  const geo = geoip.lookup(clientIP);
  const userAgent = req.headers["user-agent"] || "Unknown";
  const requestSource = detectRequestSource(req);
  const userAgentInfo = parseUserAgent(userAgent);
  const username = getUsername(req);

  // Batch request detection
  const isBatchRequest = req.headers["x-batch-request"] === "true";
  const batchTraceId = req.headers["x-batch-trace-id"] as string | undefined;

  const country = isPrivateIP(clientIP) ? undefined : geo?.country;

  // Create security metadata object
  const securityMetadata = {
    clientIP,
    userAgent,
    requestSource,
    userAgentInfo,
    username,
    country,
  };

  // Validate with Zod schema for type safety
  req.securityMetadata = SecurityMetadataSchema.parse(securityMetadata);

  // Use to catch send() as you're doing now
  const originalSend = res.send;
  res.send = function (...args) {
    const body = args[0];

    if (!res.getHeader("Content-Length")) {
      if (Buffer.isBuffer(body)) {
        res.setHeader("Content-Length", body.length);
      } else if (typeof body === "string") {
        res.setHeader("Content-Length", Buffer.byteLength(body));
      }
    }

    return originalSend.apply(this, args);
  };

  // 🔥 Always logs after response is sent — even for doc.pipe(res) or res.end()
  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const size = res.getHeader("Content-Length") || 0;
    const locationInfo = formatLocationInfo(clientIP, geo);

    // Track stats (skip for internal batch requests to avoid double counting)
    if (!isBatchRequest) {
      serverStats.trackRequest(
        req.method,
        req.path,
        status,
        duration,
        requestSource,
        userAgentInfo.formatted,
        username,
        country,
      );
    }

    // Compact log format for internal batch requests
    if (isBatchRequest) {
      const statusColor = status >= 400 ? CHALK.red : status >= 300 ? CHALK.cyan : CHALK.green;
      const traceShort = batchTraceId ? batchTraceId.slice(0, 20) : "unknown";
      console.log(
        CHALK.dim("  │ ") +
        CHALK.magenta("BATCH") + " " +
        CHALK.dim(`[${traceShort}]`) + " " +
        formatMethod(req.method) + " " +
        statusColor(`${status}`) + " " +
        CHALK.bold(req.path) + " " +
        formatResponseTime(duration)
      );
      return;
    }

    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Mexico_City",
      weekday: "long", // Friday
      day: "2-digit", // 20
      year: "numeric", // 2025
      month: "long", // April
      hour: "numeric", // 4
      minute: "2-digit", // 20
      hour12: true, // PM
    });

    // Enhanced logging output
    const botWarning = userAgentInfo.isBot ? CHALK.red.bold(" [BOT]") : "";
    const slowWarning = duration > 1000 ? CHALK.red.bold(" [SLOW]") : "";
    const errorWarning = status >= 400 ? CHALK.red.bold(" [ERROR]") : "";

    console.log(
      `-------------------------------------------------------
${formatter.format(now)}\n${formatMethod(req.method)} ${formatStatus(status)} ${CHALK.bold(req.path)}${errorWarning}${slowWarning}${botWarning}
IP: ${CHALK.yellow(clientIP)} ${locationInfo}
Source: ${requestSource}
Client: ${CHALK.cyan(userAgentInfo.formatted)}
Processing time: ${formatResponseTime(duration)}
Payload Size: ${CHALK.cyan(formatSize(Number(size)))}
-------------------------------------------------------\n\n`,
    );
  });

  next();
};

// export const AuthHandlerImpl = async <A, B>(
//   router: express.Router,
//   definition: RouteDefinition<A, B>,
//   permissions: string[],
//   implementation: (request: A, session: TokenPayload) => Promise<B>,
// ) => {
//   router[definition.method](definition.path, async (req, res) => {
//     try {
//       const token = req.headers.authorization?.split(" ")[1];
//       const session = AuthLogic.verifyToken(token ?? "");
//       verifyPermissions(permissions, session);

//       let result = definition.parseBody(req.body);
//       let response = await implementation(result, session);
//       res.json(response);
//     } catch (error) {
//       res.status(500).json({ message: "Internal Server Error " + error });
//     }
//   });
// };

// export const PublicHandlerImpl = async <A, B>(
//   router: express.Router,
//   definition: RouteDefinition<A, B>,
//   implementation: (request: A) => Promise<B>,
// ) => {
//   router[definition.method](definition.path, async (req, res) => {
//     try {
//       let result = definition.parseBody(req.body);
//       let response = await implementation(result);
//       res.json(response);
//     } catch (error) {
//       res.status(500).json({ message: "Internal Server Error " + error });
//     }
//   });
// };
