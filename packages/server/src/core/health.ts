// Core Health Check Service
// Provides liveness and readiness probes for production deployments

import type { Kysely } from "kysely";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  status: HealthStatus;
  message?: string;
  latencyMs?: number;
}

export interface HealthCheck {
  name: string;
  check: () => Promise<HealthCheckResult> | HealthCheckResult;
  /** Whether failure of this check marks the service as unhealthy (default: true) */
  critical?: boolean;
}

export interface HealthResponse {
  status: HealthStatus;
  uptime: number;
  timestamp: string;
  checks: Record<string, HealthCheckResult>;
}

export interface HealthConfig {
  checks?: HealthCheck[];
  /** Path for liveness probe (default: "/_health") */
  livenessPath?: string;
  /** Path for readiness probe (default: "/_ready") */
  readinessPath?: string;
  /** Timeout per check in ms (default: 5000) */
  checkTimeout?: number;
  /** Whether to register a built-in database check (default: true) */
  dbCheck?: boolean;
}

export interface Health {
  /** Register a health check */
  register(check: HealthCheck): void;
  /** Run all readiness checks */
  check(): Promise<HealthResponse>;
  /** Fast liveness probe (no external checks) */
  liveness(isShuttingDown: boolean): HealthResponse;
}

class HealthImpl implements Health {
  private checks: HealthCheck[] = [];
  private startTime = Date.now();
  private checkTimeout: number;

  constructor(config: HealthConfig = {}) {
    this.checkTimeout = config.checkTimeout ?? 5000;

    if (config.checks) {
      for (const check of config.checks) {
        this.checks.push(check);
      }
    }
  }

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  async check(): Promise<HealthResponse> {
    const results: Record<string, HealthCheckResult> = {};
    let overallStatus: HealthStatus = "healthy";

    await Promise.all(
      this.checks.map(async (check) => {
        const start = Date.now();
        try {
          const result = await Promise.race([
            Promise.resolve(check.check()),
            new Promise<HealthCheckResult>((_, reject) =>
              setTimeout(() => reject(new Error("Health check timed out")), this.checkTimeout)
            ),
          ]);
          results[check.name] = {
            ...result,
            latencyMs: result.latencyMs ?? Date.now() - start,
          };

          const isCritical = check.critical !== false;
          if (result.status === "unhealthy" && isCritical) {
            overallStatus = "unhealthy";
          } else if (result.status === "degraded" && overallStatus !== "unhealthy") {
            overallStatus = "degraded";
          } else if (result.status === "unhealthy" && !isCritical && overallStatus !== "unhealthy") {
            overallStatus = "degraded";
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results[check.name] = {
            status: "unhealthy",
            message,
            latencyMs: Date.now() - start,
          };
          const isCritical = check.critical !== false;
          if (isCritical) {
            overallStatus = "unhealthy";
          } else if (overallStatus !== "unhealthy") {
            overallStatus = "degraded";
          }
        }
      })
    );

    return {
      status: overallStatus,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
      checks: results,
    };
  }

  liveness(isShuttingDown: boolean): HealthResponse {
    return {
      status: isShuttingDown ? "unhealthy" : "healthy",
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
      checks: {},
    };
  }
}

/**
 * Create a built-in database health check.
 */
export function createDbHealthCheck(db: Kysely<any>): HealthCheck {
  return {
    name: "database",
    critical: true,
    check: async () => {
      const start = Date.now();
      try {
        await db.selectFrom(db.dynamic.ref("sqlite_master") as any)
          .select(db.dynamic.ref("1") as any)
          .execute()
          .catch(async () => {
            // Fallback for non-SQLite databases
            const { sql } = await import("kysely");
            await sql`SELECT 1`.execute(db);
          });
        return {
          status: "healthy" as const,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        return {
          status: "unhealthy" as const,
          message: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - start,
        };
      }
    },
  };
}

export function createHealth(config?: HealthConfig): Health {
  return new HealthImpl(config);
}
