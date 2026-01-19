/**
 * MCP (Model Context Protocol) setup command
 *
 * Sets up the @donkeylabs/mcp server for AI-assisted development
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import pc from "picocolors";
import prompts from "prompts";

interface McpConfig {
  mcpServers?: Record<string, {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  }>;
}

async function detectPackageManager(): Promise<"bun" | "npm" | "pnpm" | "yarn"> {
  if (existsSync("bun.lockb") || existsSync("bun.lock")) return "bun";
  if (existsSync("pnpm-lock.yaml")) return "pnpm";
  if (existsSync("yarn.lock")) return "yarn";
  return "npm";
}

async function installPackage(pkg: string, dev: boolean = true): Promise<boolean> {
  const pm = await detectPackageManager();

  const args: string[] = [];
  switch (pm) {
    case "bun":
      args.push("add", dev ? "-d" : "", pkg);
      break;
    case "pnpm":
      args.push("add", dev ? "-D" : "", pkg);
      break;
    case "yarn":
      args.push("add", dev ? "-D" : "", pkg);
      break;
    default:
      args.push("install", dev ? "--save-dev" : "--save", pkg);
  }

  console.log(pc.dim(`$ ${pm} ${args.filter(Boolean).join(" ")}`));

  return new Promise((resolve) => {
    const child = spawn(pm, args.filter(Boolean), {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    child.on("close", (code) => {
      resolve(code === 0);
    });

    child.on("error", () => {
      resolve(false);
    });
  });
}

async function readMcpConfig(): Promise<McpConfig> {
  const configPath = join(process.cwd(), ".mcp.json");

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = await readFile(configPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeMcpConfig(config: McpConfig): Promise<void> {
  const configPath = join(process.cwd(), ".mcp.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

async function setupClaudeCode(): Promise<void> {
  console.log(pc.cyan("\nClaude Code Setup:"));
  console.log(pc.dim("─".repeat(40)));
  console.log(`
The .mcp.json file has been created in your project root.
Claude Code will automatically detect and use this configuration.

${pc.bold("To verify:")}
  1. Open Claude Code in this project
  2. The MCP tools should be available automatically
  3. Try asking Claude to "list plugins" or "get project info"

${pc.bold("Manual setup (if needed):")}
  Add to your Claude Code settings:
  ${pc.dim(JSON.stringify({
    "mcpServers": {
      "donkeylabs": {
        "command": "bunx",
        "args": ["@donkeylabs/mcp"],
        "cwd": "${workspaceFolder}"
      }
    }
  }, null, 2))}
`);
}

async function setupCursor(): Promise<void> {
  console.log(pc.cyan("\nCursor Setup:"));
  console.log(pc.dim("─".repeat(40)));
  console.log(`
${pc.bold("To configure Cursor:")}
  1. Open Cursor Settings (Cmd/Ctrl + ,)
  2. Search for "MCP" or "Model Context Protocol"
  3. Add the donkeylabs server configuration:

${pc.dim(JSON.stringify({
    "donkeylabs": {
      "command": "bunx",
      "args": ["@donkeylabs/mcp"],
      "cwd": "${workspaceFolder}"
    }
  }, null, 2))}

  4. Restart Cursor to apply changes
`);
}

async function setupWindsurf(): Promise<void> {
  console.log(pc.cyan("\nWindsurf Setup:"));
  console.log(pc.dim("─".repeat(40)));
  console.log(`
${pc.bold("To configure Windsurf:")}
  1. Open Windsurf settings
  2. Navigate to AI / MCP configuration
  3. Add the donkeylabs server:

${pc.dim(JSON.stringify({
    "donkeylabs": {
      "command": "bunx",
      "args": ["@donkeylabs/mcp"],
      "cwd": "${workspaceFolder}"
    }
  }, null, 2))}
`);
}

export async function mcpCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "setup") {
    await setupMcp(args.slice(1));
  } else if (subcommand === "help" || subcommand === "--help") {
    printMcpHelp();
  } else {
    console.error(pc.red(`Unknown mcp subcommand: ${subcommand}`));
    printMcpHelp();
    process.exit(1);
  }
}

function printMcpHelp(): void {
  console.log(`
${pc.bold("donkeylabs mcp")} - Setup MCP server for AI-assisted development

${pc.bold("Usage:")}
  donkeylabs mcp                  Interactive MCP setup
  donkeylabs mcp setup            Setup MCP (interactive)
  donkeylabs mcp setup --claude   Setup for Claude Code
  donkeylabs mcp setup --cursor   Setup for Cursor
  donkeylabs mcp setup --all      Setup for all IDEs

${pc.bold("Options:")}
  --claude      Configure for Claude Code
  --cursor      Configure for Cursor
  --windsurf    Configure for Windsurf
  --all         Show setup for all IDEs
  --skip-install  Skip installing @donkeylabs/mcp package

${pc.bold("What this does:")}
  1. Installs @donkeylabs/mcp as a dev dependency
  2. Creates/updates .mcp.json in your project
  3. Provides IDE-specific setup instructions

${pc.bold("MCP Tools Available:")}
  - get_project_info    - View project structure and routes
  - create_plugin       - Create new plugins
  - add_service_method  - Add methods to plugin services
  - add_migration       - Create database migrations
  - create_router       - Create new routers
  - add_route           - Add routes to routers
  - add_cron            - Schedule cron jobs
  - add_event           - Register events
  - add_async_job       - Register background jobs
  - generate_types      - Regenerate types
  - generate_client     - Generate API client
`);
}

async function setupMcp(args: string[]): Promise<void> {
  console.log(pc.bold("\n🔧 Setting up @donkeylabs/mcp\n"));

  // Check if we're in a donkeylabs project
  const configPath = join(process.cwd(), "donkeylabs.config.ts");
  const hasConfig = existsSync(configPath);

  if (!hasConfig) {
    console.log(pc.yellow("⚠ No donkeylabs.config.ts found in current directory."));
    console.log(pc.dim("  The MCP server works best in a @donkeylabs/server project."));
    console.log(pc.dim("  Run 'donkeylabs init' to create a new project first.\n"));

    const { proceed } = await prompts({
      type: "confirm",
      name: "proceed",
      message: "Continue anyway?",
      initial: false,
    });

    if (!proceed) {
      console.log(pc.dim("Aborted."));
      return;
    }
  }

  // Parse args for flags
  const skipInstall = args.includes("--skip-install");
  const forClaude = args.includes("--claude");
  const forCursor = args.includes("--cursor");
  const forWindsurf = args.includes("--windsurf");
  const forAll = args.includes("--all");

  // Install @donkeylabs/mcp if not skipped
  if (!skipInstall) {
    console.log(pc.cyan("Installing @donkeylabs/mcp..."));
    const success = await installPackage("@donkeylabs/mcp");

    if (!success) {
      console.log(pc.yellow("\n⚠ Package installation failed, but continuing with config setup."));
      console.log(pc.dim("  You can manually install with: bun add -d @donkeylabs/mcp\n"));
    } else {
      console.log(pc.green("✓ Installed @donkeylabs/mcp\n"));
    }
  }

  // Create/update .mcp.json
  console.log(pc.cyan("Configuring .mcp.json..."));

  const config = await readMcpConfig();
  config.mcpServers = config.mcpServers || {};

  config.mcpServers.donkeylabs = {
    command: "bunx",
    args: ["@donkeylabs/mcp"],
    cwd: "${workspaceFolder}",
  };

  await writeMcpConfig(config);
  console.log(pc.green("✓ Created .mcp.json\n"));

  // Show IDE-specific instructions
  if (forAll || (!forClaude && !forCursor && !forWindsurf)) {
    // Interactive mode or --all
    if (!forClaude && !forCursor && !forWindsurf && !forAll) {
      const { ide } = await prompts({
        type: "select",
        name: "ide",
        message: "Which IDE are you using?",
        choices: [
          { title: "Claude Code", value: "claude" },
          { title: "Cursor", value: "cursor" },
          { title: "Windsurf", value: "windsurf" },
          { title: "Show all", value: "all" },
        ],
      });

      if (ide === "claude") await setupClaudeCode();
      else if (ide === "cursor") await setupCursor();
      else if (ide === "windsurf") await setupWindsurf();
      else {
        await setupClaudeCode();
        await setupCursor();
        await setupWindsurf();
      }
    } else {
      await setupClaudeCode();
      await setupCursor();
      await setupWindsurf();
    }
  } else {
    if (forClaude) await setupClaudeCode();
    if (forCursor) await setupCursor();
    if (forWindsurf) await setupWindsurf();
  }

  console.log(pc.green("\n✓ MCP setup complete!\n"));
  console.log(pc.dim("The AI assistant can now help you with:"));
  console.log(pc.dim("  - Creating plugins, routes, and handlers"));
  console.log(pc.dim("  - Adding migrations and service methods"));
  console.log(pc.dim("  - Setting up cron jobs and background tasks"));
  console.log(pc.dim("  - Generating types and API clients\n"));
}
