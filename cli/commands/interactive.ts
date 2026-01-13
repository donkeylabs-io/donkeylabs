/**
 * Interactive CLI Menu
 *
 * Full interactive experience with context-aware menus
 */

import prompts from "prompts";
import pc from "picocolors";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function interactiveCommand() {
  console.clear();
  console.log(pc.magenta(pc.bold("\n  @donkeylabs/server CLI\n")));

  // Detect context - are we in a plugin directory?
  const cwd = process.cwd();
  const pathParts = cwd.split("/");
  const parentDir = pathParts[pathParts.length - 2];
  const currentDir = pathParts[pathParts.length - 1];

  let contextPlugin: string | null = null;
  if (parentDir === "plugins" && currentDir && existsSync(join(cwd, "index.ts"))) {
    contextPlugin = currentDir;
  }

  // Run appropriate menu loop
  if (contextPlugin) {
    await pluginMenuLoop(contextPlugin);
  } else {
    await globalMenuLoop();
  }
}

// ============================================
// Plugin Context Menu (Inside plugins/<name>/)
// ============================================

async function pluginMenuLoop(pluginName: string) {
  while (true) {
    console.log(pc.cyan(`\n  Context: Plugin ${pc.bold(`'${pluginName}'`)}\n`));

    const response = await prompts({
      type: "select",
      name: "action",
      message: "What would you like to do?",
      choices: [
        { title: pc.yellow("1.") + " Generate Schema Types", value: "gen-types" },
        { title: pc.yellow("2.") + " Create Migration", value: "migration" },
        { title: pc.gray("─".repeat(35)), value: "separator", disabled: true },
        { title: pc.blue("←") + "  Back to Global Menu", value: "global" },
        { title: pc.red("×") + "  Exit", value: "exit" },
      ],
    });

    if (!response.action || response.action === "exit") {
      console.log(pc.gray("\nGoodbye!\n"));
      process.exit(0);
    }

    if (response.action === "global") {
      console.clear();
      console.log(pc.magenta(pc.bold("\n  @donkeylabs/server CLI\n")));
      await globalMenuLoop();
      return;
    }

    console.log(""); // spacing

    switch (response.action) {
      case "gen-types":
        await runCommand(`bun scripts/generate-types.ts ${pluginName}`);
        break;
      case "migration":
        await createMigration(pluginName);
        break;
    }

    await pressEnterToContinue();
  }
}

// ============================================
// Global Root Menu
// ============================================

async function globalMenuLoop() {
  while (true) {
    console.log(pc.cyan("\n  Context: Project Root\n"));

    const choices = [
      { title: pc.yellow("1.") + " Create New Plugin", value: "new-plugin" },
      { title: pc.yellow("2.") + " Initialize New Project", value: "init" },
      { title: pc.gray("─".repeat(35)), value: "separator1", disabled: true },
      { title: pc.yellow("3.") + " Generate Types", value: "generate" },
      { title: pc.yellow("4.") + " Generate Registry", value: "gen-registry" },
      { title: pc.yellow("5.") + " Generate Server Context", value: "gen-server" },
      { title: pc.gray("─".repeat(35)), value: "separator2", disabled: true },
      { title: pc.red("×") + "  Exit", value: "exit" },
    ];

    const response = await prompts({
      type: "select",
      name: "action",
      message: "Select a command:",
      choices,
    });

    if (!response.action || response.action === "exit") {
      console.log(pc.gray("\nGoodbye!\n"));
      process.exit(0);
    }

    console.log(""); // spacing

    switch (response.action) {
      case "new-plugin":
        const { pluginCommand } = await import("./plugin");
        await pluginCommand(["create"]);
        break;
      case "init":
        const { initCommand } = await import("./init");
        await initCommand([]);
        break;
      case "generate":
        const { generateCommand } = await import("./generate");
        await generateCommand([]);
        break;
      case "gen-registry":
        await runCommand("bun scripts/generate-registry.ts");
        break;
      case "gen-server":
        await runCommand("bun scripts/generate-server.ts");
        break;
    }

    await pressEnterToContinue();
  }
}

// ============================================
// Commands
// ============================================

async function createMigration(pluginName: string) {
  const nameRes = await prompts({
    type: "text",
    name: "migName",
    message: "Migration name (e.g. add_comments):",
    validate: (v) =>
      /^[a-z0-9_]+$/.test(v) ? true : "Use lowercase letters, numbers, and underscores",
  });

  if (!nameRes.migName) return;

  // Determine migrations directory
  const cwd = process.cwd();
  const isPluginDir = basename(join(cwd, "..")) === "plugins";
  const migrationsDir = isPluginDir
    ? join(cwd, "migrations")
    : join(process.cwd(), "src/plugins", pluginName, "migrations");

  // Generate sequential number
  let nextNum = 1;
  try {
    const files = await readdir(migrationsDir);
    const nums = files
      .map((f) => parseInt(f.split("_")[0] || "", 10))
      .filter((n) => !isNaN(n));
    if (nums.length > 0) {
      nextNum = Math.max(...nums) + 1;
    }
  } catch {}

  const filename = `${String(nextNum).padStart(3, "0")}_${nameRes.migName}.ts`;
  const content = `import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // await db.schema.createTable("...").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // await db.schema.dropTable("...").execute();
}
`;

  if (!existsSync(migrationsDir)) {
    await mkdir(migrationsDir, { recursive: true });
  }

  await writeFile(join(migrationsDir, filename), content);
  console.log(pc.green(`Created migration: ${filename}`));
}

// ============================================
// Helpers
// ============================================

async function runCommand(cmd: string) {
  console.log(pc.gray(`> ${cmd}\n`));
  try {
    const { stdout, stderr } = await execAsync(cmd);
    if (stdout) console.log(stdout);
    if (stderr) console.error(pc.yellow(stderr));
  } catch (e: any) {
    console.error(pc.red("Command failed:"), e.message);
  }
}

async function pressEnterToContinue() {
  await prompts({
    type: "invisible",
    name: "continue",
    message: pc.gray("Press Enter to continue..."),
  });
  console.clear();
  console.log(pc.magenta(pc.bold("\n  @donkeylabs/server CLI\n")));
}
