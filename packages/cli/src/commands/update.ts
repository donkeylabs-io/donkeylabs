/**
 * Update Command
 *
 * Check for and install updates to @donkeylabs packages.
 *
 * Usage:
 *   donkeylabs update           # Interactive update selection
 *   donkeylabs update --all     # Update all packages
 *   donkeylabs update --check   # Check for updates only (no install)
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import pc from "picocolors";

const DONKEYLABS_PACKAGES = [
  "@donkeylabs/server",
  "@donkeylabs/adapter-sveltekit",
  "@donkeylabs/cli",
  "@donkeylabs/mcp",
  "@donkeylabs/adapter-serverless",
];

interface PackageInfo {
  name: string;
  currentVersion: string | null;
  latestVersion: string | null;
  hasUpdate: boolean;
  isDev: boolean;
}

interface UpdateOptions {
  all?: boolean;
  check?: boolean;
  skipDocs?: boolean;
}

/**
 * Get installed version from package.json
 */
function getInstalledPackages(packageJsonPath: string): Map<string, { version: string; isDev: boolean }> {
  const installed = new Map<string, { version: string; isDev: boolean }>();

  if (!existsSync(packageJsonPath)) {
    return installed;
  }

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

  // Check dependencies
  if (pkg.dependencies) {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (DONKEYLABS_PACKAGES.includes(name)) {
        installed.set(name, { version: String(version), isDev: false });
      }
    }
  }

  // Check devDependencies
  if (pkg.devDependencies) {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      if (DONKEYLABS_PACKAGES.includes(name)) {
        installed.set(name, { version: String(version), isDev: true });
      }
    }
  }

  return installed;
}

/**
 * Get latest version from npm registry
 */
async function getLatestVersion(packageName: string): Promise<string | null> {
  try {
    const result = execSync(`npm view ${packageName} version 2>/dev/null`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Parse version string (handles workspace:*, ^, ~, etc.)
 */
function parseVersion(version: string): string {
  if (version.startsWith("workspace:")) {
    return "workspace";
  }
  // Remove ^, ~, >=, etc.
  return version.replace(/^[\^~>=<]+/, "");
}

/**
 * Compare versions (simple semver comparison)
 */
function isNewerVersion(current: string, latest: string): boolean {
  if (current === "workspace") return false;

  const currentParts = current.split(".").map(Number);
  const latestParts = latest.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const c = currentParts[i] || 0;
    const l = latestParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }

  return false;
}

/**
 * Check for updates
 */
async function checkForUpdates(packageJsonPath: string): Promise<PackageInfo[]> {
  const installed = getInstalledPackages(packageJsonPath);
  const packages: PackageInfo[] = [];

  console.log(pc.dim("\nChecking for updates...\n"));

  for (const name of DONKEYLABS_PACKAGES) {
    const info = installed.get(name);

    if (!info) {
      continue; // Not installed
    }

    const currentVersion = parseVersion(info.version);
    const latestVersion = await getLatestVersion(name);

    const hasUpdate = latestVersion
      ? isNewerVersion(currentVersion, latestVersion)
      : false;

    packages.push({
      name,
      currentVersion,
      latestVersion,
      hasUpdate,
      isDev: info.isDev,
    });
  }

  return packages;
}

/**
 * Display update status
 */
function displayUpdateStatus(packages: PackageInfo[]): void {
  const hasUpdates = packages.some((p) => p.hasUpdate);

  console.log(pc.bold("Package Status\n"));

  for (const pkg of packages) {
    const statusIcon = pkg.hasUpdate
      ? pc.yellow("⬆")
      : pc.green("✓");

    const versionInfo = pkg.hasUpdate
      ? `${pc.dim(pkg.currentVersion)} → ${pc.green(pkg.latestVersion)}`
      : pc.dim(pkg.currentVersion || "unknown");

    const devBadge = pkg.isDev ? pc.dim(" (dev)") : "";

    console.log(`  ${statusIcon} ${pkg.name}${devBadge}`);
    console.log(`    ${versionInfo}\n`);
  }

  if (!hasUpdates) {
    console.log(pc.green("All packages are up to date!"));
  }
}

/**
 * Interactive package selection using simple prompt
 */
async function selectPackagesToUpdate(packages: PackageInfo[]): Promise<PackageInfo[]> {
  const updatable = packages.filter((p) => p.hasUpdate);

  if (updatable.length === 0) {
    return [];
  }

  console.log(pc.bold("\nSelect packages to update:\n"));

  // Display options
  console.log(`  ${pc.cyan("0)")} Update all packages`);
  updatable.forEach((pkg, i) => {
    console.log(
      `  ${pc.cyan(`${i + 1})`)} ${pkg.name} ${pc.dim(`${pkg.currentVersion} → ${pkg.latestVersion}`)}`
    );
  });
  console.log(`  ${pc.cyan("s)")} Skip update\n`);

  // Read input
  process.stdout.write(pc.bold("Enter selection (0-" + updatable.length + ", or s): "));

  const input = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      data = chunk.toString().trim();
      resolve(data);
    });
    process.stdin.resume();
  });

  process.stdin.pause();

  if (input.toLowerCase() === "s") {
    return [];
  }

  if (input === "0") {
    return updatable;
  }

  const index = parseInt(input, 10);
  if (index >= 1 && index <= updatable.length) {
    return [updatable[index - 1]];
  }

  console.log(pc.yellow("\nInvalid selection, skipping update."));
  return [];
}

/**
 * Update package.json with new versions
 */
function updatePackageJson(
  packageJsonPath: string,
  packagesToUpdate: PackageInfo[]
): void {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

  for (const pkgInfo of packagesToUpdate) {
    const versionString = `^${pkgInfo.latestVersion}`;

    if (pkgInfo.isDev && pkg.devDependencies?.[pkgInfo.name]) {
      pkg.devDependencies[pkgInfo.name] = versionString;
    } else if (pkg.dependencies?.[pkgInfo.name]) {
      pkg.dependencies[pkgInfo.name] = versionString;
    }
  }

  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");
}

/**
 * Run bun install
 */
function runInstall(): void {
  console.log(pc.dim("\nRemoving node_modules..."));
  const nodeModulesPath = join(process.cwd(), "node_modules");
  if (existsSync(nodeModulesPath)) {
    rmSync(nodeModulesPath, { recursive: true, force: true });
  }

  // Also remove bun.lock for clean install
  const bunLockPath = join(process.cwd(), "bun.lock");
  if (existsSync(bunLockPath)) {
    rmSync(bunLockPath);
  }

  console.log(pc.dim("Running bun install...\n"));
  execSync("bun install", { stdio: "inherit" });
}

/**
 * Sync documentation
 */
async function syncDocs(): Promise<void> {
  console.log(pc.dim("\nSyncing documentation..."));

  try {
    const { docsCommand } = await import("./docs");
    await docsCommand([], {});
  } catch (error) {
    console.log(pc.yellow("Could not sync docs (this is optional)"));
  }
}

export async function updateCommand(
  args: string[],
  options: UpdateOptions = {}
): Promise<void> {
  const packageJsonPath = join(process.cwd(), "package.json");

  if (!existsSync(packageJsonPath)) {
    console.error(pc.red("Error: No package.json found in current directory."));
    process.exit(1);
  }

  // Check for updates
  const packages = await checkForUpdates(packageJsonPath);

  if (packages.length === 0) {
    console.log(pc.yellow("No @donkeylabs packages found in this project."));
    console.log(pc.dim("\nInstall with: bun add @donkeylabs/server"));
    return;
  }

  // Display status
  displayUpdateStatus(packages);

  // Check-only mode
  if (options.check || args.includes("--check") || args.includes("-c")) {
    return;
  }

  const updatable = packages.filter((p) => p.hasUpdate);

  if (updatable.length === 0) {
    return;
  }

  // Select packages to update
  let packagesToUpdate: PackageInfo[];

  if (options.all || args.includes("--all") || args.includes("-a")) {
    packagesToUpdate = updatable;
  } else {
    packagesToUpdate = await selectPackagesToUpdate(packages);
  }

  if (packagesToUpdate.length === 0) {
    console.log(pc.dim("\nNo packages selected for update."));
    return;
  }

  // Confirm
  console.log(pc.bold("\nUpdating packages:"));
  for (const pkg of packagesToUpdate) {
    console.log(`  • ${pkg.name} → ${pc.green(pkg.latestVersion)}`);
  }

  // Update package.json
  console.log(pc.dim("\nUpdating package.json..."));
  updatePackageJson(packageJsonPath, packagesToUpdate);

  // Run install
  runInstall();

  // Sync docs
  if (!options.skipDocs && !args.includes("--skip-docs")) {
    await syncDocs();
  }

  console.log(pc.green("\n✓ Update complete!"));
  console.log(pc.dim("\nUpdated packages:"));
  for (const pkg of packagesToUpdate) {
    console.log(`  ${pc.green("•")} ${pkg.name}@${pkg.latestVersion}`);
  }
}
