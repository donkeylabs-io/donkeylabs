import { Chalk } from "chalk";

const CHALK = new Chalk({ level: 3 });

interface RequestStats {
  totalRequests: number;
  errorCount: number;
  totalResponseTime: number;
  slowRequests: number;
  requestsByMethod: Map<string, number>;
  requestsByPath: Map<string, number>;
  requestsBySource: Map<string, number>;
  requestsByUserAgent: Map<string, number>;
  requestsByCountry: Map<string, number>;
  authRequests: number;
  publicRequests: number;
  activeUsers: Set<string>;
  lastReset: Date;
}

interface SystemMetrics {
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: NodeJS.CpuUsage;
  uptime: number;
  timestamp: Date;
}

interface DatabaseMetrics {
  queryCount: number;
  slowQueryCount: number;
  totalQueryTime: number;
  avgQueryTime: number;
  lastReset: Date;
}

class StatsCollector {
  private stats: RequestStats;
  private dbMetrics: DatabaseMetrics;
  private startCpuUsage: NodeJS.CpuUsage;
  private startTime: Date;

  constructor() {
    this.startTime = new Date();
    this.startCpuUsage = process.cpuUsage();
    this.stats = this.createEmptyStats();
    this.dbMetrics = this.createEmptyDbMetrics();
  }

  private createEmptyStats(): RequestStats {
    return {
      totalRequests: 0,
      errorCount: 0,
      totalResponseTime: 0,
      slowRequests: 0,
      requestsByMethod: new Map(),
      requestsByPath: new Map(),
      requestsBySource: new Map(),
      requestsByUserAgent: new Map(),
      requestsByCountry: new Map(),
      authRequests: 0,
      publicRequests: 0,
      activeUsers: new Set(),
      lastReset: new Date(),
    };
  }

  private createEmptyDbMetrics(): DatabaseMetrics {
    return {
      queryCount: 0,
      slowQueryCount: 0,
      totalQueryTime: 0,
      avgQueryTime: 0,
      lastReset: new Date(),
    };
  }

  // Request tracking methods
  trackRequest(
    method: string,
    path: string,
    status: number,
    responseTime: number,
    source: string,
    userAgent: string,
    username?: string,
    country?: string,
  ) {
    this.stats.totalRequests++;
    this.stats.totalResponseTime += responseTime;

    if (status >= 400) {
      this.stats.errorCount++;
    }

    if (responseTime > 1000) {
      this.stats.slowRequests++;
    }

    // Track by method
    this.stats.requestsByMethod.set(method, (this.stats.requestsByMethod.get(method) || 0) + 1);

    // Track by path (simplified)
    const simplifiedPath = this.simplifyPath(path);
    this.stats.requestsByPath.set(simplifiedPath, (this.stats.requestsByPath.get(simplifiedPath) || 0) + 1);

    // Track by source
    this.stats.requestsBySource.set(source, (this.stats.requestsBySource.get(source) || 0) + 1);

    // Track by user agent
    this.stats.requestsByUserAgent.set(userAgent, (this.stats.requestsByUserAgent.get(userAgent) || 0) + 1);

    // Track by country if available
    if (country) {
      this.stats.requestsByCountry.set(country, (this.stats.requestsByCountry.get(country) || 0) + 1);
    }

    // Track auth vs public
    if (username) {
      this.stats.authRequests++;
      this.stats.activeUsers.add(username);
    } else {
      this.stats.publicRequests++;
    }
  }

  // Database tracking methods
  trackDatabaseQuery(queryTime: number) {
    this.dbMetrics.queryCount++;
    this.dbMetrics.totalQueryTime += queryTime;
    this.dbMetrics.avgQueryTime = this.dbMetrics.totalQueryTime / this.dbMetrics.queryCount;

    if (queryTime > 100) {
      // Slow queries > 100ms
      this.dbMetrics.slowQueryCount++;
    }
  }

  private simplifyPath(path: string): string {
    // Replace IDs and UUIDs with placeholders
    return path
      .replace(/\/\d+/g, "/:id")
      .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, "/:uuid");
  }

  getSystemMetrics(): SystemMetrics & {
    memoryPercentage: number;
    cpuPercentage: number;
    totalMemory: number;
  } {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage(this.startCpuUsage);

    // Get total system memory (estimate based on heap limit or use a reasonable default)
    const rawTotalMemory = memUsage.heapTotal > 0 ? memUsage.heapTotal * 4 : memUsage.heapUsed || 1;
    const totalMemory = Math.max(rawTotalMemory, 1);
    const memoryPercentage = Math.min((memUsage.heapUsed / totalMemory) * 100, 100);

    // Calculate CPU percentage (rough estimate based on time)
    const totalCpuTime = cpuUsage.user + cpuUsage.system;
    const elapsedTime = (Date.now() - this.startTime.getTime()) * 1000; // Convert to microseconds
    const cpuPercentage = elapsedTime > 0 ? Math.min((totalCpuTime / elapsedTime) * 100, 100) : 0;

    return {
      memoryUsage: memUsage,
      cpuUsage,
      uptime: Date.now() - this.startTime.getTime(),
      timestamp: new Date(),
      memoryPercentage: Math.min(memoryPercentage, 100),
      cpuPercentage,
      totalMemory,
    };
  }

  getStats(): RequestStats {
    return { ...this.stats };
  }

  getDbMetrics(): DatabaseMetrics {
    return { ...this.dbMetrics };
  }

  resetStats() {
    this.stats = this.createEmptyStats();
    this.dbMetrics = this.createEmptyDbMetrics();
    this.startCpuUsage = process.cpuUsage();
  }

  // Pretty print methods
  printDetailedStats() {
    const stats = this.getStats();
    const dbStats = this.getDbMetrics();
    const systemStats = this.getSystemMetrics();

    const avgResponseTime =
      stats.totalRequests > 0 ? (stats.totalResponseTime / stats.totalRequests).toFixed(1) : "0";

    const errorRate =
      stats.totalRequests > 0 ? ((stats.errorCount / stats.totalRequests) * 100).toFixed(1) : "0";

    const slowRequestRate =
      stats.totalRequests > 0 ? ((stats.slowRequests / stats.totalRequests) * 100).toFixed(1) : "0";

    const timeSinceReset = Date.now() - this.stats.lastReset.getTime();
    const minutesSinceReset = Math.floor(timeSinceReset / (1000 * 60));
    const timeRangeText =
      minutesSinceReset < 60
        ? `Last ${minutesSinceReset} minutes`
        : `Last ${Math.floor(minutesSinceReset / 60)}h ${minutesSinceReset % 60}m`;

    console.log(`
${CHALK.cyan.bold("🚀 PITSA API Server Stats")} ${CHALK.gray(`(${new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" })})`)}
${CHALK.gray(`📊 Showing data from: ${timeRangeText}`)}
${CHALK.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}

${CHALK.yellow.bold("📊 REQUEST METRICS")}
├─ Total Requests: ${CHALK.white.bold(stats.totalRequests.toLocaleString())}
├─ Error Rate: ${stats.errorCount > 0 ? CHALK.red.bold(`${errorRate}%`) : CHALK.green.bold(`${errorRate}%`)} ${CHALK.gray(`(${stats.errorCount} errors)`)}
├─ Avg Response Time: ${avgResponseTime > "500" ? CHALK.red.bold(`${avgResponseTime}ms`) : CHALK.green.bold(`${avgResponseTime}ms`)}
├─ Slow Requests (>1s): ${slowRequestRate > "10" ? CHALK.red.bold(`${slowRequestRate}%`) : CHALK.yellow.bold(`${slowRequestRate}%`)} ${CHALK.gray(`(${stats.slowRequests} requests)`)}
├─ Auth vs Public: ${CHALK.blue.bold(stats.authRequests)} auth, ${CHALK.cyan.bold(stats.publicRequests)} public
└─ Active Users: ${CHALK.green.bold(stats.activeUsers.size)}

${CHALK.yellow.bold("🔗 TOP REQUEST METHODS")}
${this.formatTopEntries(stats.requestsByMethod)}

${CHALK.yellow.bold("🛤️  TOP ENDPOINTS")}
${this.formatTopEntries(stats.requestsByPath)}

${CHALK.yellow.bold("📱 REQUEST SOURCES")}
${this.formatTopEntries(stats.requestsBySource)}

${CHALK.yellow.bold("🌍 TOP COUNTRIES")}
${this.formatTopEntries(stats.requestsByCountry)}

${CHALK.yellow.bold("💾 DATABASE METRICS")}
├─ Total Queries: ${CHALK.white.bold(dbStats.queryCount.toLocaleString())}
├─ Avg Query Time: ${dbStats.avgQueryTime > 50 ? CHALK.red.bold(`${dbStats.avgQueryTime.toFixed(1)}ms`) : CHALK.green.bold(`${dbStats.avgQueryTime.toFixed(1)}ms`)}
├─ Slow Queries (>100ms): ${dbStats.slowQueryCount > 0 ? CHALK.red.bold(dbStats.slowQueryCount) : CHALK.green.bold(dbStats.slowQueryCount)}
└─ QPS: ${CHALK.cyan.bold((dbStats.queryCount / ((Date.now() - dbStats.lastReset.getTime()) / 1000)).toFixed(1))}

  ${CHALK.yellow.bold("💻 SYSTEM METRICS")}
  ├─ Memory Usage: ${CHALK.white.bold((systemStats.memoryUsage.heapUsed / 1024 / 1024).toFixed(1))}MB / ${CHALK.gray((systemStats.totalMemory / 1024 / 1024).toFixed(1))}MB ${systemStats.memoryPercentage > 80 ? CHALK.red.bold(`(${systemStats.memoryPercentage.toFixed(1)}%)`) : CHALK.green.bold(`(${systemStats.memoryPercentage.toFixed(1)}%)`)}
  ├─ CPU Usage: ${systemStats.cpuPercentage > 80 ? CHALK.red.bold(`${systemStats.cpuPercentage.toFixed(1)}%`) : CHALK.green.bold(`${systemStats.cpuPercentage.toFixed(1)}%`)} ${CHALK.gray(`- ${(systemStats.cpuUsage.user / 1000).toFixed(1)}ms user, ${(systemStats.cpuUsage.system / 1000).toFixed(1)}ms system`)}
  └─ Uptime: ${CHALK.green.bold(this.formatUptime(systemStats.uptime))}

${CHALK.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}
`);
  }

  private formatTopEntries(map: Map<string, number>, limit: number = 5): string {
    const sorted = Array.from(map.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit);

    if (sorted.length === 0) {
      return `├─ ${CHALK.gray("No data yet")}`;
    }

    return sorted
      .map(([key, count], index) => {
        const isLast = index === sorted.length - 1;
        const prefix = isLast ? "└─" : "├─";
        const percentage = ((count / Array.from(map.values()).reduce((a, b) => a + b, 0)) * 100).toFixed(1);

        // Add flag emoji for country codes (2-letter codes)
        let displayKey = key;
        if (key.length === 2 && /^[A-Z]{2}$/.test(key)) {
          const flagEmoji = key
            .toUpperCase()
            .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
          displayKey = `${flagEmoji} ${key}`;
        }

        return `${prefix} ${CHALK.white.bold(displayKey)}: ${CHALK.cyan(count)} ${CHALK.gray(`(${percentage}%)`)}`;
      })
      .join("\n");
  }

  private formatUptime(uptime: number): string {
    const days = Math.floor(uptime / (24 * 60 * 60 * 1000));
    const hours = Math.floor((uptime % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((uptime % (60 * 60 * 1000)) / (60 * 1000));

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
}

// Global singleton instance
export const serverStats = new StatsCollector();
