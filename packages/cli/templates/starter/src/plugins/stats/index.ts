import { createPlugin, createMiddleware } from "@donkeylabs/server";

export interface RequestStats {
  totalRequests: number;
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  requestsPerRoute: Map<string, number>;
}

export interface StatsService {
  /** Record a request with its duration */
  recordRequest(route: string, durationMs: number): void;
  /** Get current stats snapshot */
  getStats(): RequestStats;
  /** Reset all stats */
  reset(): void;
}

export const statsPlugin = createPlugin.define({
  name: "stats",
  version: "1.0.0",

  // Service must come before middleware for TypeScript to infer the Service type
  service: async (ctx): Promise<StatsService> => {
    const logger = ctx.core.logger.child({ plugin: "stats" });

    // In-memory stats
    let totalRequests = 0;
    let totalTime = 0;
    let minTime = Infinity;
    let maxTime = 0;
    const requestsPerRoute = new Map<string, number>();

    function getStats(): RequestStats {
      return {
        totalRequests,
        avgResponseTime: totalRequests > 0 ? totalTime / totalRequests : 0,
        minResponseTime: minTime,
        maxResponseTime: maxTime,
        requestsPerRoute: new Map(requestsPerRoute),
      };
    }

    logger.info("Stats plugin initialized");

    return {
      recordRequest(route: string, durationMs: number) {
        totalRequests++;
        totalTime += durationMs;
        minTime = Math.min(minTime, durationMs);
        maxTime = Math.max(maxTime, durationMs);
        requestsPerRoute.set(route, (requestsPerRoute.get(route) ?? 0) + 1);

        logger.debug("Request recorded", { route, durationMs: durationMs.toFixed(2) });
      },

      getStats,

      reset() {
        totalRequests = 0;
        totalTime = 0;
        minTime = Infinity;
        maxTime = 0;
        requestsPerRoute.clear();
        logger.info("Stats reset");
      },
    };
  },

  // Middleware - ctx is typed PluginContext, service is typed StatsService
  middleware: (ctx, service) => ({
    /** Timing middleware - records request duration and updates stats */
    timing: createMiddleware(async (req, _reqCtx, next) => {
      const logger = ctx.core.logger;
      const route = new URL(req.url).pathname.slice(1);
      const start = performance.now();
      const response = await next();
      const duration = performance.now() - start;

      // Use own service to record stats - service is typed!
      service.recordRequest(route, duration);
      logger.info("Request processed", { route, durationMs: duration.toFixed(2) });

      return response;
    }),
  }),

  // Register crons, events, etc. after service is created
  init: (ctx, service) => {
    const logger = ctx.core.logger.child({ plugin: "stats" });

    // Log stats every minute
    ctx.core.cron.schedule("* * * * *", () => {
      const stats = service.getStats();
      logger.info("Server stats", {
        requests: stats.totalRequests,
        avgMs: stats.avgResponseTime.toFixed(2),
        minMs: stats.minResponseTime === Infinity ? 0 : stats.minResponseTime.toFixed(2),
        maxMs: stats.maxResponseTime.toFixed(2),
        routes: Object.fromEntries(stats.requestsPerRoute),
      });
    }, { name: "stats-reporter" });
  },
});
