// packages/cli/src/deployment/manager.ts
/**
 * Deployment Management System
 * Handles deployment history, versioning, rollbacks
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

export interface DeploymentConfig {
  projectName: string;
  platform: "vercel" | "cloudflare" | "aws" | "vps";
  environment: "production" | "staging" | "development";
  versionStrategy: "semver" | "git-sha" | "timestamp";
}

export interface Deployment {
  id: string;
  version: string;
  platform: string;
  environment: string;
  timestamp: string;
  gitSha: string;
  gitMessage: string;
  status: "success" | "failed" | "rolling-back";
  url?: string;
  logs: string[];
  metadata: Record<string, any>;
}

export interface DeploymentHistory {
  deployments: Deployment[];
  currentVersion: string;
  lastDeployedAt: string;
}

export class DeploymentManager {
  private projectDir: string;
  private historyFile: string;
  private config: DeploymentConfig;

  constructor(projectDir: string, config: DeploymentConfig) {
    this.projectDir = projectDir;
    this.config = config;
    this.historyFile = join(projectDir, ".donkeylabs", "deployments.json");
    this.ensureHistoryDir();
  }

  /**
   * Get next version based on strategy
   */
  getNextVersion(bump: "major" | "minor" | "patch" = "patch"): string {
    const { versionStrategy } = this.config;
    
    if (versionStrategy === "git-sha") {
      return this.getGitSha();
    }
    
    if (versionStrategy === "timestamp") {
      return Date.now().toString();
    }
    
    // Semver
    const current = this.getCurrentVersion();
    const [major, minor, patch] = current.split(".").map(Number);
    
    switch (bump) {
      case "major":
        return `${major + 1}.0.0`;
      case "minor":
        return `${major}.${minor + 1}.0`;
      case "patch":
      default:
        return `${major}.${minor}.${patch + 1}`;
    }
  }

  /**
   * Record a new deployment
   */
  async recordDeployment(
    version: string,
    platform: string,
    status: Deployment["status"],
    url?: string,
    metadata?: Record<string, any>
  ): Promise<Deployment> {
    const deployment: Deployment = {
      id: randomUUID(),
      version,
      platform,
      environment: this.config.environment,
      timestamp: new Date().toISOString(),
      gitSha: this.getGitSha(),
      gitMessage: this.getGitMessage(),
      status,
      url,
      logs: [],
      metadata: metadata || {},
    };

    const history = this.getHistory();
    history.deployments.unshift(deployment);
    history.currentVersion = version;
    history.lastDeployedAt = deployment.timestamp;
    
    // Keep only last 50 deployments
    history.deployments = history.deployments.slice(0, 50);
    
    this.saveHistory(history);
    
    return deployment;
  }

  /**
   * Get deployment history
   */
  getHistory(): DeploymentHistory {
    if (!existsSync(this.historyFile)) {
      return {
        deployments: [],
        currentVersion: "0.0.0",
        lastDeployedAt: "",
      };
    }

    return JSON.parse(readFileSync(this.historyFile, "utf-8"));
  }

  /**
   * Get specific deployment
   */
  getDeployment(deploymentId: string): Deployment | null {
    const history = this.getHistory();
    return history.deployments.find((d) => d.id === deploymentId) || null;
  }

  /**
   * Get last successful deployment
   */
  getLastSuccessfulDeployment(): Deployment | null {
    const history = this.getHistory();
    return history.deployments.find((d) => d.status === "success") || null;
  }

  /**
   * Rollback to previous version
   */
  async rollback(toVersion?: string): Promise<Deployment | null> {
    const history = this.getHistory();
    
    // Find target deployment
    let targetDeployment: Deployment | undefined;
    
    if (toVersion) {
      targetDeployment = history.deployments.find((d) => d.version === toVersion);
    } else {
      // Find last successful deployment before current
      const currentIndex = history.deployments.findIndex(
        (d) => d.version === history.currentVersion
      );
      targetDeployment = history.deployments
        .slice(currentIndex + 1)
        .find((d) => d.status === "success");
    }

    if (!targetDeployment) {
      throw new Error("No previous successful deployment found to rollback to");
    }

    // Checkout the git sha
    try {
      execSync(`git checkout ${targetDeployment.gitSha}`, {
        cwd: this.projectDir,
        stdio: "pipe",
      });

      // Mark as rolling back
      targetDeployment.status = "rolling-back";
      this.saveHistory(history);

      // Redeploy
      await this.redeploy(targetDeployment);

      // Record the rollback
      const rollbackDeployment = await this.recordDeployment(
        `${targetDeployment.version}-rollback`,
        targetDeployment.platform,
        "success",
        targetDeployment.url,
        { rollbackFrom: history.currentVersion, originalDeployment: targetDeployment.id }
      );

      return rollbackDeployment;
    } catch (error) {
      // Revert git checkout
      execSync("git checkout -", { cwd: this.projectDir, stdio: "pipe" });
      throw error;
    }
  }

  /**
   * Get deployment statistics
   */
  getStats(): {
    totalDeployments: number;
    successfulDeployments: number;
    failedDeployments: number;
    rollbackCount: number;
    averageDeployTime: number;
    deploymentsByPlatform: Record<string, number>;
  } {
    const history = this.getHistory();
    const deployments = history.deployments;

    const successful = deployments.filter((d) => d.status === "success");
    const failed = deployments.filter((d) => d.status === "failed");
    const rollbacks = deployments.filter((d) => d.metadata?.rollbackFrom);

    const byPlatform: Record<string, number> = {};
    for (const d of deployments) {
      byPlatform[d.platform] = (byPlatform[d.platform] || 0) + 1;
    }

    return {
      totalDeployments: deployments.length,
      successfulDeployments: successful.length,
      failedDeployments: failed.length,
      rollbackCount: rollbacks.length,
      averageDeployTime: 0, // Would need to track start/end times
      deploymentsByPlatform: byPlatform,
    };
  }

  /**
   * List deployments with filtering
   */
  listDeployments(options?: {
    platform?: string;
    status?: Deployment["status"];
    limit?: number;
  }): Deployment[] {
    let deployments = this.getHistory().deployments;

    if (options?.platform) {
      deployments = deployments.filter((d) => d.platform === options.platform);
    }

    if (options?.status) {
      deployments = deployments.filter((d) => d.status === options.status);
    }

    if (options?.limit) {
      deployments = deployments.slice(0, options.limit);
    }

    return deployments;
  }

  /**
   * Compare two deployments
   */
  compareDeployments(deploymentId1: string, deploymentId2: string): {
    deployment1: Deployment;
    deployment2: Deployment;
    gitDiff: string;
  } {
    const d1 = this.getDeployment(deploymentId1);
    const d2 = this.getDeployment(deploymentId2);

    if (!d1 || !d2) {
      throw new Error("One or both deployments not found");
    }

    const diff = execSync(
      `git log --oneline ${d2.gitSha}..${d1.gitSha}`,
      { cwd: this.projectDir, encoding: "utf-8" }
    );

    return {
      deployment1: d1,
      deployment2: d2,
      gitDiff: diff,
    };
  }

  private ensureHistoryDir(): void {
    const dir = join(this.projectDir, ".donkeylabs");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private saveHistory(history: DeploymentHistory): void {
    writeFileSync(this.historyFile, JSON.stringify(history, null, 2));
  }

  private getCurrentVersion(): string {
    const pkgPath = join(this.projectDir, "package.json");
    if (!existsSync(pkgPath)) {
      return "0.0.0";
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  }

  private getGitSha(): string {
    try {
      return execSync("git rev-parse --short HEAD", {
        cwd: this.projectDir,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "unknown";
    }
  }

  private getGitMessage(): string {
    try {
      return execSync("git log -1 --pretty=%B", {
        cwd: this.projectDir,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "unknown";
    }
  }

  private async redeploy(deployment: Deployment): Promise<void> {
    // Platform-specific redeploy logic
    switch (deployment.platform) {
      case "vercel":
        execSync("vercel --prod", {
          cwd: this.projectDir,
          stdio: "inherit",
        });
        break;
      case "cloudflare":
        execSync("wrangler deploy", {
          cwd: this.projectDir,
          stdio: "inherit",
        });
        break;
      // Add other platforms
    }
  }
}

export function createDeploymentManager(
  projectDir: string,
  config: DeploymentConfig
): DeploymentManager {
  return new DeploymentManager(projectDir, config);
}
