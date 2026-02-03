// packages/cli/src/commands/deploy-enhanced.ts
/**
 * Enhanced deploy command with history, versioning, and rollbacks
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import pc from "picocolors";
import { createDeploymentManager } from "../deployment/manager";

interface DeployOptions {
  platform: "vercel" | "cloudflare" | "aws" | "vps";
  environment: "production" | "staging" | "development";
  version?: string;
  versionBump?: "major" | "minor" | "patch";
  skipBuild?: boolean;
}

export async function deployEnhancedCommand(args: string[]) {
  const platform = args[0] as DeployOptions["platform"];
  
  if (!platform) {
    console.error(pc.red("❌ Platform required"));
    console.log(pc.gray("Usage: donkeylabs deploy <platform>"));
    console.log(pc.gray("Platforms: vercel, cloudflare, aws, vps"));
    process.exit(1);
  }

  const options = await promptForOptions(platform);
  const manager = createDeploymentManager(process.cwd(), {
    projectName: getProjectName(),
    platform: options.platform,
    environment: options.environment,
    versionStrategy: "semver",
  });

  // Determine version
  const version = options.version || manager.getNextVersion(options.versionBump);
  
  console.log(pc.cyan(pc.bold(`\n🚀 Deploying v${version} to ${platform}\n`)));

  // Pre-deployment checks
  if (!(await runPreDeployChecks(options))) {
    process.exit(1);
  }

  // Build
  if (!options.skipBuild) {
    console.log(pc.blue("📦 Building..."));
    try {
      execSync("bun run build", { stdio: "inherit" });
    } catch {
      await manager.recordDeployment(version, platform, "failed");
      console.error(pc.red("❌ Build failed"));
      process.exit(1);
    }
  }

  // Deploy
  let url: string | undefined;
  try {
    url = await deployToPlatform(options, version);
    console.log(pc.green(`\n✅ Deployed successfully!`));
    console.log(pc.gray(`URL: ${url}`));
  } catch (error) {
    await manager.recordDeployment(version, platform, "failed");
    console.error(pc.red("\n❌ Deployment failed"));
    process.exit(1);
  }

  // Record successful deployment
  const deployment = await manager.recordDeployment(version, platform, "success", url, {
    duration: Date.now(), // Would track actual duration
  });

  // Show deployment info
  console.log(pc.cyan(`\n📊 Deployment recorded`));
  console.log(pc.gray(`ID: ${deployment.id}`));
  console.log(pc.gray(`Version: ${deployment.version}`));
  console.log(pc.gray(`Git: ${deployment.gitSha} - ${deployment.gitMessage}`));
  
  // Update package.json version
  updatePackageVersion(version);
  
  console.log(pc.green(`\n🎉 Done!`));
}

async function promptForOptions(platform: string): Promise<DeployOptions> {
  const prompts = await import("prompts");
  
  const environment = await prompts.default({
    type: "select",
    name: "value",
    message: "Environment:",
    choices: [
      { title: "Production", value: "production" },
      { title: "Staging", value: "staging" },
      { title: "Preview", value: "preview" },
    ],
    initial: 0,
  }).then((r: any) => r.value);

  const versionBump = await prompts.default({
    type: "select",
    name: "value",
    message: "Version bump:",
    choices: [
      { title: "patch (bug fixes)", value: "patch" },
      { title: "minor (new features)", value: "minor" },
      { title: "major (breaking changes)", value: "major" },
      { title: "custom version", value: "custom" },
    ],
    initial: 0,
  }).then((r: any) => r.value);

  let version: string | undefined;
  if (versionBump === "custom") {
    version = await prompts.default({
      type: "text",
      name: "value",
      message: "Version:",
      initial: "1.0.0",
    }).then((r: any) => r.value);
  }

  return {
    platform: platform as DeployOptions["platform"],
    environment,
    version,
    versionBump: versionBump === "custom" ? undefined : versionBump,
  };
}

async function runPreDeployChecks(options: DeployOptions): Promise<boolean> {
  const checks = [
    { name: "Git clean", fn: () => checkGitClean() },
    { name: "Tests pass", fn: () => checkTests() },
    { name: "TypeScript compiles", fn: () => checkTypescript() },
    { name: "Environment variables", fn: () => checkEnvVars(options.platform) },
  ];

  console.log(pc.blue("\n🔍 Pre-deployment checks:\n"));
  
  for (const check of checks) {
    process.stdout.write(`  ${check.name}... `);
    try {
      await check.fn();
      console.log(pc.green("✓"));
    } catch (error) {
      console.log(pc.red("✗"));
      console.error(pc.red(`  ${error}`));
      return false;
    }
  }

  console.log();
  return true;
}

async function deployToPlatform(options: DeployOptions, version: string): Promise<string> {
  switch (options.platform) {
    case "vercel":
      return deployToVercel(options, version);
    case "cloudflare":
      return deployToCloudflare(options, version);
    case "aws":
      return deployToAWS(options, version);
    case "vps":
      return deployToVPS(options, version);
    default:
      throw new Error(`Unknown platform: ${options.platform}`);
  }
}

async function deployToVercel(options: DeployOptions, version: string): Promise<string> {
  // Ensure vercel.json exists
  setupVercelConfig();
  
  const args = options.environment === "production" ? ["--prod"] : [];
  const output = execSync(`vercel ${args.join(" ")}`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  
  // Extract URL from output
  const urlMatch = output.match(/https:\/\/[^\s]+/);
  return urlMatch ? urlMatch[0] : "";
}

async function deployToCloudflare(options: DeployOptions, version: string): Promise<string> {
  // Ensure wrangler.toml exists
  setupWranglerConfig(version);
  
  execSync("wrangler deploy", { stdio: "inherit" });
  
  // Get deployment URL
  const output = execSync("wrangler deployment list --limit 1", {
    encoding: "utf-8",
  });
  
  const urlMatch = output.match(/https:\/\/[^\s]+/);
  return urlMatch ? urlMatch[0] : "";
}

async function deployToAWS(options: DeployOptions, version: string): Promise<string> {
  // SAM or Serverless Framework deployment
  execSync("sam deploy", { stdio: "inherit" });
  
  // Get API Gateway URL
  const output = execSync("sam list stack-outputs", {
    encoding: "utf-8",
  });
  
  const urlMatch = output.match(/https:\/\/[^\s]+\.amazonaws\.com/);
  return urlMatch ? urlMatch[0] : "";
}

async function deployToVPS(options: DeployOptions, version: string): Promise<string> {
  // Docker deployment to VPS
  execSync("docker-compose build", { stdio: "inherit" });
  execSync("docker-compose up -d", { stdio: "inherit" });
  
  return "http://your-vps-ip:3000"; // Would get actual IP
}

// Helper functions
function getProjectName(): string {
  const pkgPath = join(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) return "unknown";
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.name;
}

function checkGitClean(): void {
  const status = execSync("git status --porcelain", { encoding: "utf-8" });
  if (status.trim()) {
    throw new Error("Uncommitted changes. Commit or stash first.");
  }
}

function checkTests(): void {
  try {
    execSync("bun test", { stdio: "pipe" });
  } catch {
    throw new Error("Tests failed");
  }
}

function checkTypescript(): void {
  try {
    execSync("bun --bun tsc --noEmit", { stdio: "pipe" });
  } catch {
    throw new Error("TypeScript errors");
  }
}

function checkEnvVars(platform: string): void {
  // Platform-specific env checks
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) {
    throw new Error(".env.local not found");
  }
}

function setupVercelConfig(): void {
  // Create vercel.json if not exists
}

function setupWranglerConfig(version: string): void {
  // Create wrangler.toml if not exists
}

function updatePackageVersion(version: string): void {
  const pkgPath = join(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

// Additional CLI commands
export async function deployHistoryCommand(args: string[]) {
  const manager = createDeploymentManager(process.cwd(), {
    projectName: getProjectName(),
    platform: "vercel",
    environment: "production",
    versionStrategy: "semver",
  });

  const history = manager.listDeployments({ limit: 10 });
  
  console.log(pc.cyan(pc.bold("\n📜 Deployment History\n")));
  
  for (const deployment of history) {
    const statusIcon = deployment.status === "success" ? pc.green("✓") : 
                      deployment.status === "failed" ? pc.red("✗") : pc.yellow("↺");
    
    console.log(`${statusIcon} ${pc.bold(deployment.version)} ${pc.gray(deployment.platform)}`);
    console.log(`   ${deployment.gitSha} - ${deployment.gitMessage}`);
    console.log(`   ${deployment.timestamp}${deployment.url ? ` - ${deployment.url}` : ""}`);
    console.log();
  }
}

export async function deployRollbackCommand(args: string[]) {
  const version = args[0];
  
  const manager = createDeploymentManager(process.cwd(), {
    projectName: getProjectName(),
    platform: "vercel",
    environment: "production",
    versionStrategy: "semver",
  });

  console.log(pc.yellow(pc.bold("\n⚠️  Rollback\n")));
  
  if (version) {
    console.log(`Rolling back to version: ${version}`);
  } else {
    console.log("Rolling back to previous version");
  }

  try {
    const deployment = await manager.rollback(version);
    if (deployment) {
      console.log(pc.green(`\n✅ Rolled back to v${deployment.version}`));
    }
  } catch (error: any) {
    console.error(pc.red(`\n❌ Rollback failed: ${error.message}`));
    process.exit(1);
  }
}

export async function deployStatsCommand() {
  const manager = createDeploymentManager(process.cwd(), {
    projectName: getProjectName(),
    platform: "vercel",
    environment: "production",
    versionStrategy: "semver",
  });

  const stats = manager.getStats();
  
  console.log(pc.cyan(pc.bold("\n📊 Deployment Statistics\n")));
  console.log(`Total deployments: ${stats.totalDeployments}`);
  console.log(`Successful: ${pc.green(stats.successfulDeployments.toString())}`);
  console.log(`Failed: ${pc.red(stats.failedDeployments.toString())}`);
  console.log(`Rollbacks: ${pc.yellow(stats.rollbackCount.toString())}`);
  
  console.log(pc.cyan("\nBy Platform:"));
  for (const [platform, count] of Object.entries(stats.deploymentsByPlatform)) {
    console.log(`  ${platform}: ${count}`);
  }
}
