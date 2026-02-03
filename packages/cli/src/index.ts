#!/usr/bin/env bun
/**
 * @donkeylabs/cli
 *
 * Commands:
 *   init        Initialize a new project
 *   generate    Generate types (registry, context, client)
 *   plugin      Plugin management (create, list)
 */

import { parseArgs } from "node:util";
import pc from "picocolors";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    type: { type: "string", short: "t" },
    local: { type: "boolean", short: "l" },
  },
  allowPositionals: true,
});

const command = positionals[0];

function printHelp() {
  console.log(`
${pc.bold("@donkeylabs/cli")} - CLI for @donkeylabs/server

${pc.bold("Usage:")}
  donkeylabs                    Interactive menu
  donkeylabs <command> [options]

${pc.bold("Commands:")}
  ${pc.cyan("init")}              Initialize a new project
  ${pc.cyan("add")}               Add optional plugins (images, auth, etc.)
  ${pc.cyan("generate")}          Generate types (registry, context, client)
  ${pc.cyan("plugin")}            Plugin management
  ${pc.cyan("deploy")} <platform> Deploy (vercel, cloudflare, aws, vps)
  ${pc.cyan("deploy history")}     Show deployment history
  ${pc.cyan("deploy rollback")}    Rollback to version
  ${pc.cyan("deploy stats")}       Show deployment statistics
  ${pc.cyan("config")}            Configure plugins, deployment, database
  ${pc.cyan("mcp")}               Setup MCP server for AI-assisted development

${pc.bold("Options:")}
  -h, --help              Show this help message
  -v, --version           Show version number
  -t, --type <type>       Project type for init (server, sveltekit)
  -l, --local             Use local workspace packages (for monorepo dev)

  ${pc.bold("Examples:")}
   donkeylabs                       # Interactive menu
   donkeylabs init                  # Interactive project setup
   donkeylabs init --type server    # Server-only project
   donkeylabs init --type sveltekit # SvelteKit + adapter project
   donkeylabs generate
   donkeylabs plugin create myPlugin
   donkeylabs deploy vercel         # Deploy to Vercel
   donkeylabs config                # Interactive configuration
   donkeylabs config set DATABASE_URL postgresql://...
`);
}

function printVersion() {
  // Read from package.json
  console.log("0.1.0");
}

async function main() {
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.version) {
    printVersion();
    process.exit(0);
  }

  // No command provided - launch interactive mode
  if (!command) {
    const { interactiveCommand } = await import("./commands/interactive");
    await interactiveCommand();
    return;
  }

  switch (command) {
    case "init":
      const { initEnhancedCommand } = await import("./commands/init-enhanced");
      await initEnhancedCommand(positionals.slice(1), { useLocalPackages: values.local });
      break;

    case "add":
      const { addCommand } = await import("./commands/add");
      await addCommand(positionals.slice(1));
      break;

    case "generate":
    case "gen":
      const { generateCommand } = await import("./commands/generate");
      await generateCommand(positionals.slice(1));
      break;

    case "plugin":
      const { pluginCommand } = await import("./commands/plugin");
      await pluginCommand(positionals.slice(1));
      break;

    case "mcp":
      const { mcpCommand } = await import("./commands/mcp");
      await mcpCommand(positionals.slice(1));
      break;

    case "deploy":
      const subcommand = positionals[1];
      if (subcommand === "history") {
        const { deployHistoryCommand } = await import("./commands/deploy-enhanced");
        await deployHistoryCommand(positionals.slice(2));
      } else if (subcommand === "rollback") {
        const { deployRollbackCommand } = await import("./commands/deploy-enhanced");
        await deployRollbackCommand(positionals.slice(2));
      } else if (subcommand === "stats") {
        const { deployStatsCommand } = await import("./commands/deploy-enhanced");
        await deployStatsCommand();
      } else {
        const { deployEnhancedCommand } = await import("./commands/deploy-enhanced");
        await deployEnhancedCommand(positionals.slice(1));
      }
      break;

    case "config":
      const { configCommand } = await import("./commands/config");
      await configCommand(positionals.slice(1));
      break;

    default:
      console.error(pc.red(`Unknown command: ${command}`));
      console.log(`Run ${pc.cyan("donkeylabs --help")} for available commands.`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(pc.red("Error:"), error.message);
  process.exit(1);
});
