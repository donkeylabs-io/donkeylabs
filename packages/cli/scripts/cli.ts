import prompts from "prompts";
import pc from "picocolors";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ============================================
// CLI Entry Point
// ============================================

async function main() {
    console.clear();
    console.log(pc.magenta(pc.bold("\n  Plugin CLI\n")));

    // Detect context
    const cwd = process.env.INIT_CWD || process.cwd();
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
                { title: pc.yellow("1.") + " Live Watch", value: "watch" },
                { title: pc.yellow("2.") + " Generate Schema Types", value: "gen-types" },
                { title: pc.yellow("3.") + " Create Migration", value: "migration" },
                { title: pc.yellow("4.") + " Publish New Version", value: "publish" },
                { title: pc.gray("─".repeat(35)), value: "separator", disabled: true },
                { title: pc.blue("←") + "  Back to Global Menu", value: "global" },
                { title: pc.red("×") + "  Exit", value: "exit" }
            ]
        });

        if (!response.action || response.action === "exit") {
            console.log(pc.gray("\nGoodbye!\n"));
            process.exit(0);
        }

        if (response.action === "global") {
            console.clear();
            console.log(pc.magenta(pc.bold("\n  Plugin CLI\n")));
            await globalMenuLoop();
            return;
        }

        console.log(""); // spacing

        switch (response.action) {
            case "watch":
                await spawnWatcher(pluginName);
                break;
            case "gen-types":
                await runCommand(`bun scripts/generate-types.ts ${pluginName}`);
                break;
            case "migration":
                await createMigration(pluginName);
                break;
            case "publish":
                await publishPlugin(pluginName);
                break;
        }

        // After command, show a prompt to continue
        await pressEnterToContinue();
    }
}

// ============================================
// Global Root Menu
// ============================================

async function globalMenuLoop() {
    while (true) {
        console.log(pc.cyan("\n  Context: Project Root\n"));

        // Check for updates
        const { GlobalRegistry } = await import("./global-registry.ts");
        const reg = new GlobalRegistry();
        const updates = await reg.checkForUpdates(join(process.cwd(), "plugins"));

        if (updates.length > 0) {
            console.log(pc.yellow(pc.bold("  Updates Available:")));
            for (const u of updates) {
                console.log(`    ${pc.white(u.name)}: ${pc.red(u.current)} → ${pc.green(u.latest)}`);
            }
            console.log("");
        }

        const choices = [
            { title: pc.yellow("1.") + " Create New Plugin", value: "new" },
            { title: pc.yellow("2.") + " Create New Server", value: "server" },
            { title: pc.gray("─".repeat(35)), value: "separator1", disabled: true },
            { title: pc.yellow("3.") + " Publish Plugin Version", value: "publish" },
            { title: pc.yellow("4.") + " Install Plugin from Global", value: "install" },
            { title: pc.gray("─".repeat(35)), value: "separator2", disabled: true },
            { title: pc.yellow("5.") + " Generate Registry", value: "gen-registry" },
            { title: pc.yellow("6.") + " Watch Plugin", value: "watch-select" },
        ];

        if (updates.length > 0) {
            choices.push({ title: pc.green("↑") + "  Update All Plugins", value: "update-all" });
        }

        choices.push(
            { title: pc.gray("─".repeat(35)), value: "separator3", disabled: true },
            { title: pc.red("×") + "  Exit", value: "exit" }
        );

        const response = await prompts({
            type: "select",
            name: "action",
            message: "Select a command:",
            choices
        });

        if (!response.action || response.action === "exit") {
            console.log(pc.gray("\nGoodbye!\n"));
            process.exit(0);
        }

        console.log(""); // spacing

        let skipContinuePrompt = false;

        switch (response.action) {
            case "new":
                skipContinuePrompt = await createNewPlugin();
                break;
            case "server":
                await createNewServer();
                break;
            case "publish":
                await publishPluginFromRoot();
                break;
            case "install":
                await installPlugin();
                break;
            case "gen-registry":
                await runCommand("bun scripts/generate-registry.ts");
                break;
            case "watch-select":
                await watchPluginSelector();
                skipContinuePrompt = true; // Watcher keeps running
                break;
            case "update-all":
                await updateAllPlugins(updates, reg);
                break;
        }

        // After command, show a prompt to continue (unless watcher is running)
        if (!skipContinuePrompt) {
            await pressEnterToContinue();
        }
    }
}

// ============================================
// Commands
// ============================================

async function createNewPlugin(): Promise<boolean> {
    // Import and run the create-plugin script inline
    const { createPluginInteractive } = await import("./create-plugin.ts");
    const result = await createPluginInteractive();

    // If user wants to watch the new plugin, start watcher
    if (result?.name) {
        await spawnWatcher(result.name);
        return true; // Don't show "press enter to continue"
    }
    return false;
}

async function createNewServer() {
    const plugins = await getPlugins();

    console.log(pc.bold("  Create New Server\n"));

    // Get server file name
    const nameRes = await prompts({
        type: "text",
        name: "filename",
        message: "Server filename:",
        initial: "server.ts",
        validate: (v) => v.endsWith(".ts") ? true : "Must end with .ts"
    });

    if (!nameRes.filename) return;

    // Get port
    const portRes = await prompts({
        type: "number",
        name: "port",
        message: "Port number:",
        initial: 3000,
        validate: (v) => v > 0 && v < 65536 ? true : "Invalid port"
    });

    if (!portRes.port) return;

    // Select plugins to include
    let selectedPlugins: string[] = [];
    if (plugins.length > 0) {
        const pluginRes = await prompts({
            type: "multiselect",
            name: "plugins",
            message: "Include plugins " + pc.gray("(space to select)"),
            choices: plugins.map(p => ({ title: p, value: p })),
            instructions: false,
            hint: ""
        });
        selectedPlugins = pluginRes.plugins || [];
    }

    // Generate the server file
    const serverCode = generateServerCode(nameRes.filename, portRes.port, selectedPlugins);

    const { writeFile } = await import("node:fs/promises");
    const filepath = join(process.cwd(), nameRes.filename);

    if (existsSync(filepath)) {
        const overwrite = await prompts({
            type: "confirm",
            name: "value",
            message: `${nameRes.filename} already exists. Overwrite?`,
            initial: false
        });
        if (!overwrite.value) {
            console.log(pc.yellow("Cancelled."));
            return;
        }
    }

    await writeFile(filepath, serverCode);
    console.log(pc.green(`\n✔ Created ${nameRes.filename}`));

    // Show next steps
    console.log(pc.cyan("\nNext steps:"));
    console.log(pc.gray(`  1. Run: ${pc.white(`bun run ${nameRes.filename}`)}`));
    console.log(pc.gray(`  2. Test: ${pc.white(`curl -X POST http://localhost:${portRes.port}/test.hello -d '{}'`)}`));
}

function generateServerCode(filename: string, port: number, plugins: string[]): string {
    const pluginImports = plugins.map(p => `import { ${p}Plugin } from "./plugins/${p}";`).join("\n");
    const pluginRegistrations = plugins.map(p => `manager.register(${p}Plugin);`).join("\n");

    // Determine which plugin to use as router namespace (first one, or "api" if none)
    const routerNamespace = plugins[0] || "api";

    return `/// <reference path="./registry.d.ts" />
import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { PluginManager, type CoreServices } from "./core";
import { AppServer } from "./server";
import { createRouter } from "./router";
import { z } from "zod";
import "./registry";
${pluginImports ? "\n" + pluginImports : ""}

// ==========================================
// Database Setup (Replace with real dialect)
// ==========================================

const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const core: CoreServices = {
  db,
  config: { env: "development" },
};

// ==========================================
// Initialize Plugins
// ==========================================

const manager = new PluginManager(core);
${pluginRegistrations ? "\n" + pluginRegistrations : ""}

await manager.migrate();
await manager.init();

// ==========================================
// Define Routes
// ==========================================

const appRouter = createRouter("${routerNamespace}")
  .route("hello").typed({
    input: z.object({ name: z.string().optional() }),
    output: z.object({ message: z.string() }),
    handle: async (input) => {
      return { message: \`Hello, \${input.name || "World"}!\` };
    },
  })
  .route("status").raw({
    handle: async () => {
      return new Response("OK");
    },
  });

// ==========================================
// Start Server
// ==========================================

const server = new AppServer(${port}, manager);
server.use(appRouter);
await server.start();
`;
}

async function publishPluginFromRoot() {
    const plugins = await getPlugins();

    if (plugins.length === 0) {
        console.log(pc.yellow("No local plugins found."));
        return;
    }

    const sel = await prompts({
        type: "select",
        name: "plugin",
        message: "Select plugin to publish:",
        choices: plugins.map(p => ({ title: p, value: p }))
    });

    if (!sel.plugin) return;

    await publishPlugin(sel.plugin);
}

async function publishPlugin(name: string) {
    const { GlobalRegistry } = await import("./global-registry.ts");
    const reg = new GlobalRegistry();

    // Try to read current version from plugin
    let defaultVersion = "1.0.0";
    try {
        const pluginPath = join(process.cwd(), "plugins", name, "index.ts");
        const cwd = process.env.INIT_CWD || process.cwd();
        const isPluginDir = basename(join(cwd, "..")) === "plugins";
        const actualPath = isPluginDir ? join(cwd, "index.ts") : pluginPath;

        const content = await import("node:fs/promises").then(fs => fs.readFile(actualPath, "utf-8"));
        const versionMatch = content.match(/version:\s*["']([^"']+)["']/);
        if (versionMatch && versionMatch[1]) {
            defaultVersion = versionMatch[1];
        }
    } catch {}

    const verRes = await prompts({
        type: "text",
        name: "version",
        message: "Version to publish:",
        initial: defaultVersion
    });

    if (!verRes.version) return;

    const cwd = process.env.INIT_CWD || process.cwd();
    const isPluginDir = basename(join(cwd, "..")) === "plugins";
    const actualSource = isPluginDir ? cwd : join(process.cwd(), "plugins", name);

    try {
        await reg.publish(name, actualSource, verRes.version);
    } catch (e: any) {
        console.error(pc.red("Error: " + e.message));
    }
}

async function installPlugin() {
    const { GlobalRegistry } = await import("./global-registry.ts");
    const reg = new GlobalRegistry();
    const plugins = await reg.getAvailablePlugins();

    if (plugins.length === 0) {
        console.log(pc.yellow("No plugins in global registry."));
        console.log(pc.gray("Publish a plugin first with 'Publish Plugin to Global'."));
        return;
    }

    const sel = await prompts({
        type: "select",
        name: "plugin",
        message: "Select plugin to install:",
        choices: plugins.map(p => ({
            title: `${p.name} ${pc.gray(`(v${p.latest})`)}`,
            value: p
        }))
    });

    if (!sel.plugin) return;

    const p = sel.plugin;
    const dest = join(process.cwd(), "plugins", p.name);

    try {
        await reg.install(p.name, p.latest, dest);
        await runCommand("bun scripts/generate-registry.ts");
    } catch (e: any) {
        console.error(pc.red("Error: " + e.message));
    }
}

async function watchPluginSelector() {
    const plugins = await getPlugins();

    if (plugins.length === 0) {
        console.log(pc.yellow("No plugins found."));
        return;
    }

    const sel = await prompts({
        type: "select",
        name: "plugin",
        message: "Select plugin to watch:",
        choices: plugins.map(p => ({ title: p, value: p }))
    });

    if (sel.plugin) {
        await spawnWatcher(sel.plugin);
    }
}

async function updateAllPlugins(updates: { name: string; current: string; latest: string }[], reg: any) {
    console.log(pc.magenta("Updating plugins...\n"));

    for (const u of updates) {
        const dest = join(process.cwd(), "plugins", u.name);
        try {
            await reg.install(u.name, u.latest, dest);
        } catch (e: any) {
            console.error(pc.red(`Failed to update ${u.name}: ${e.message}`));
        }
    }

    await runCommand("bun scripts/generate-registry.ts");
}

async function createMigration(pluginName: string) {
    const nameRes = await prompts({
        type: "text",
        name: "migName",
        message: "Migration name (e.g. add_comments):",
        validate: (v) => /^[a-z0-9_]+$/.test(v) ? true : "Use lowercase letters, numbers, and underscores"
    });

    if (!nameRes.migName) return;

    // Generate sequential number
    const cwd = process.env.INIT_CWD || process.cwd();
    const isPluginDir = basename(join(cwd, "..")) === "plugins";
    const migrationsDir = isPluginDir
        ? join(cwd, "migrations")
        : join(process.cwd(), "plugins", pluginName, "migrations");

    let nextNum = 1;
    try {
        const files = await readdir(migrationsDir);
        const nums = files
            .map(f => parseInt(f.split("_")[0] || "", 10))
            .filter(n => !isNaN(n));
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

    const { writeFile, mkdir } = await import("node:fs/promises");

    if (!existsSync(migrationsDir)) {
        await mkdir(migrationsDir, { recursive: true });
    }

    await writeFile(join(migrationsDir, filename), content);
    console.log(pc.green(`✔ Created migration: ${filename}`));
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

async function spawnWatcher(pluginName: string) {
    console.log(pc.cyan(`Starting watcher for '${pluginName}'...`));
    console.log(pc.gray("Press Ctrl+C to stop.\n"));

    const { PluginWatcher } = await import("./watcher.ts");
    const watcher = new PluginWatcher(pluginName);
    await watcher.start();
    await new Promise(() => {}); // Keep alive
}

async function getPlugins(): Promise<string[]> {
    try {
        const files = await readdir(join(process.cwd(), "plugins"));
        return files.filter(f => !f.startsWith("."));
    } catch {
        return [];
    }
}

async function pressEnterToContinue() {
    await prompts({
        type: "invisible",
        name: "continue",
        message: pc.gray("Press Enter to continue...")
    });
    console.clear();
    console.log(pc.magenta(pc.bold("\n  Plugin CLI\n")));
}

// ============================================
// Run
// ============================================

main().catch(console.error);
