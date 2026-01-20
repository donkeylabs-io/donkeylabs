/**
 * Add Command
 *
 * Add optional plugins to a @donkeylabs/server project
 */

import { mkdir, writeFile, readFile, readdir, copyFile, stat } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pc from "picocolors";
import prompts from "prompts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  dependencies?: Record<string, string>;
  copy: Array<{ from: string; to: string }>;
  register: {
    plugin: string;
    importPath: string;
    configRequired?: boolean;
  };
  envVars?: string[];
  instructions?: string[];
}

// Files/directories to skip when copying
const SKIP_PATTERNS = [
  "node_modules",
  ".git",
  ".DS_Store",
  "manifest.json",
];

export async function addCommand(args: string[]) {
  const pluginName = args[0];

  if (!pluginName) {
    // List available plugins
    const pluginsDir = resolve(__dirname, "../../plugins");

    if (!existsSync(pluginsDir)) {
      console.log(pc.yellow("No optional plugins available."));
      return;
    }

    const plugins = await readdir(pluginsDir);
    const availablePlugins: { name: string; description: string }[] = [];

    for (const plugin of plugins) {
      const manifestPath = join(pluginsDir, plugin, "manifest.json");
      if (existsSync(manifestPath)) {
        try {
          const manifest: PluginManifest = JSON.parse(
            await readFile(manifestPath, "utf-8")
          );
          availablePlugins.push({
            name: manifest.name,
            description: manifest.description,
          });
        } catch {
          // Skip invalid manifests
        }
      }
    }

    if (availablePlugins.length === 0) {
      console.log(pc.yellow("No optional plugins available."));
      return;
    }

    console.log(`
${pc.bold("Available Plugins")}

${availablePlugins
  .map((p) => `  ${pc.cyan(p.name.padEnd(15))} ${p.description}`)
  .join("\n")}

${pc.bold("Usage:")}
  donkeylabs add <plugin-name>

${pc.bold("Example:")}
  donkeylabs add images
`);
    return;
  }

  // Find the plugin
  const pluginsDir = resolve(__dirname, "../../plugins");
  const pluginDir = join(pluginsDir, pluginName);

  if (!existsSync(pluginDir)) {
    console.error(pc.red(`Plugin not found: ${pluginName}`));
    console.log(`Run ${pc.cyan("donkeylabs add")} to see available plugins.`);
    process.exit(1);
  }

  // Read manifest
  const manifestPath = join(pluginDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(pc.red(`Invalid plugin: missing manifest.json`));
    process.exit(1);
  }

  const manifest: PluginManifest = JSON.parse(
    await readFile(manifestPath, "utf-8")
  );

  console.log(`
${pc.green("✓")} Found plugin: ${pc.bold(manifest.name)} ${pc.dim(`(${manifest.description})`)}
`);

  // Check if project has donkeylabs config
  const projectRoot = process.cwd();
  const configExists =
    existsSync(join(projectRoot, "donkeylabs.config.ts")) ||
    existsSync(join(projectRoot, "donkeylabs.config.js"));

  if (!configExists) {
    console.error(pc.red("Not a @donkeylabs/server project."));
    console.log(
      `Run ${pc.cyan("donkeylabs init")} first to create a new project.`
    );
    process.exit(1);
  }

  // Show what will be added
  console.log(pc.bold("Adding to your project:"));
  for (const copy of manifest.copy) {
    console.log(`  ${pc.cyan("•")} ${copy.to}`);
  }

  // Confirm
  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: "Proceed?",
    initial: true,
  });

  if (!confirm) {
    console.log(pc.yellow("Cancelled."));
    return;
  }

  console.log();

  // Copy files
  for (const copy of manifest.copy) {
    const srcPath = join(pluginDir, copy.from);
    const destPath = join(projectRoot, copy.to);

    if (!existsSync(srcPath)) {
      console.log(pc.yellow(`  Skipping ${copy.from} (not found)`));
      continue;
    }

    const srcStat = await stat(srcPath);

    if (srcStat.isDirectory()) {
      await copyDirectory(srcPath, destPath);
      console.log(pc.green("  Created:"), copy.to + "/");
    } else {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      console.log(pc.green("  Created:"), copy.to);
    }
  }

  // Install dependencies
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    console.log(`
${pc.bold("Installing dependencies:")}`);

    const deps = Object.entries(manifest.dependencies)
      .map(([name, version]) => `${name}@${version}`)
      .join(" ");

    console.log(`  ${pc.cyan("•")} ${deps}`);

    const success = await runCommand("bun", ["add", ...deps.split(" ")], projectRoot);

    if (success) {
      console.log(pc.green("\n✓ Dependencies installed"));
    } else {
      console.log(pc.yellow("\n⚠ Failed to install dependencies. Run manually:"));
      console.log(`  bun add ${deps}`);
    }
  }

  // Show env vars needed
  if (manifest.envVars && manifest.envVars.length > 0) {
    console.log(`
${pc.bold("Environment variables needed:")}`);
    for (const envVar of manifest.envVars) {
      console.log(`  ${envVar}=`);
    }
  }

  // Show registration instructions
  if (manifest.instructions && manifest.instructions.length > 0) {
    console.log(`
${pc.bold("Setup instructions:")}
${pc.dim("─".repeat(50))}`);
    for (const line of manifest.instructions) {
      console.log(line ? `  ${line}` : "");
    }
    console.log(pc.dim("─".repeat(50)));
  }

  console.log(`
${pc.green("✓")} Plugin added! Run ${pc.cyan("donkeylabs generate")} to update types.
`);
}

/**
 * Recursively copy a directory
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });

  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);

    // Skip certain files/directories
    if (SKIP_PATTERNS.includes(entry.name)) {
      continue;
    }

    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

/**
 * Run a command and return success status
 */
async function runCommand(
  cmd: string,
  args: string[],
  cwd: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      cwd,
    });

    child.on("close", (code) => {
      resolve(code === 0);
    });

    child.on("error", () => {
      resolve(false);
    });
  });
}
