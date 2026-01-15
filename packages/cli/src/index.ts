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
  ${pc.cyan("init")}         Initialize a new project
  ${pc.cyan("generate")}     Generate types (registry, context, client)
  ${pc.cyan("plugin")}       Plugin management

${pc.bold("Options:")}
  -h, --help              Show this help message
  -v, --version           Show version number
  -t, --type <type>       Project type for init (server, sveltekit)

${pc.bold("Examples:")}
  donkeylabs                       # Interactive menu
  donkeylabs init                  # Interactive project setup
  donkeylabs init --type server    # Server-only project
  donkeylabs init --type sveltekit # SvelteKit + adapter project
  donkeylabs generate
  donkeylabs plugin create myPlugin
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
      const { initCommand } = await import("./commands/init");
      const initArgs = [...positionals.slice(1)];
      if (values.type) {
        initArgs.push("--type", values.type);
      }
      await initCommand(initArgs);
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
