/**
 * Init Command
 *
 * Initialize a new @donkeylabs/server project by copying from templates
 */

import { mkdir, writeFile, readFile, readdir, copyFile, stat } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pc from "picocolors";
import prompts from "prompts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ProjectType = "server" | "sveltekit";

// Files/directories to skip when copying templates
const SKIP_PATTERNS = [
  "node_modules",
  ".git",
  ".svelte-kit",
  "build",
  "dist",
  ".DS_Store",
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

// Files that need to be renamed (template name -> actual name)
const RENAME_MAP: Record<string, string> = {
  ".gitignore.template": ".gitignore",
  ".env.example": ".env",
};

export async function initCommand(args: string[]) {
  // Parse --type flag if provided
  let projectDir: string | null = null;
  let typeArg: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && args[i + 1]) {
      typeArg = args[i + 1];
      i++; // skip next arg
    } else if (!args[i]?.startsWith("-")) {
      projectDir = args[i] ?? null;
    }
  }

  console.log(pc.bold("\n🚀 Create a new @donkeylabs/server project\n"));

  // If no project directory provided, prompt for it
  if (!projectDir) {
    const { name } = await prompts({
      type: "text",
      name: "name",
      message: "Project name:",
      initial: "my-donkeylabs-app",
      validate: (value) => {
        if (!value) return "Project name is required";
        if (!/^[a-zA-Z0-9-_]+$/.test(value)) {
          return "Project name can only contain letters, numbers, dashes, and underscores";
        }
        return true;
      },
    });

    if (!name) {
      console.log(pc.yellow("Cancelled."));
      return;
    }

    projectDir = name;
  }

  const targetDir = resolve(process.cwd(), projectDir!);

  let projectType: ProjectType;

  if (typeArg === "server" || typeArg === "sveltekit") {
    projectType = typeArg;
    console.log(pc.cyan(`Project type: ${projectType === "server" ? "Server Only" : "SvelteKit + Adapter"}\n`));
  } else {
    // Prompt for project type
    const response = await prompts({
      type: "select",
      name: "projectType",
      message: "Select project type:",
      choices: [
        {
          title: "Server Only",
          description: "Standalone API server with @donkeylabs/server",
          value: "server",
        },
        {
          title: "SvelteKit + Adapter",
          description: "Full-stack app with SvelteKit and @donkeylabs/adapter-sveltekit",
          value: "sveltekit",
        },
      ],
    });

    if (!response.projectType) {
      console.log(pc.yellow("Cancelled."));
      return;
    }
    projectType = response.projectType;
  }

  // Check if directory exists and has files
  if (existsSync(targetDir)) {
    const files = await readdir(targetDir);
    const hasConflicts = files.some(
      (f) => f === "src" || f === "donkeylabs.config.ts" || f === "svelte.config.js" || f === "package.json"
    );

    if (hasConflicts) {
      const { overwrite } = await prompts({
        type: "confirm",
        name: "overwrite",
        message: "Directory contains existing files. Overwrite?",
        initial: false,
      });

      if (!overwrite) {
        console.log(pc.yellow("Cancelled."));
        return;
      }
    }
  }

  // Determine template directory
  const templateName = projectType === "server" ? "starter" : "sveltekit-app";
  const templateDir = resolve(__dirname, "../../templates", templateName);

  if (!existsSync(templateDir)) {
    console.error(pc.red(`Template not found: ${templateDir}`));
    console.error(pc.dim("Make sure @donkeylabs/cli is installed correctly."));
    process.exit(1);
  }

  // Copy template to target directory
  await copyDirectory(templateDir, targetDir);

  // Update package.json with project name
  const pkgPath = join(targetDir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    const projectName = basename(targetDir) || "my-app";
    pkg.name = projectName;
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  console.log(pc.green("\n✓ Project files created\n"));

  // Auto-install dependencies
  console.log(pc.cyan("Installing dependencies...\n"));
  const installSuccess = await runCommand("bun", ["install"], targetDir);

  if (!installSuccess) {
    console.log(pc.yellow("\n⚠ Dependency installation failed."));
    console.log(pc.dim("  Run 'bun install' manually to install dependencies.\n"));
  } else {
    console.log(pc.green("\n✓ Dependencies installed\n"));

    // Copy agents.md and docs/ from @donkeylabs/server to project root
    await copyDocsFromServer(targetDir);
  }

  // Ask about MCP setup
  const { setupMcp } = await prompts({
    type: "confirm",
    name: "setupMcp",
    message: `Setup MCP for AI-assisted development? ${pc.dim("(Highly recommended)")}`,
    initial: true,
  });

  if (setupMcp) {
    // Ask which IDE
    const { ide } = await prompts({
      type: "select",
      name: "ide",
      message: "Which AI IDE are you using?",
      choices: [
        { title: "Claude Code", value: "claude", description: "Anthropic's Claude Code CLI" },
        { title: "Cursor", value: "cursor", description: "Cursor AI IDE" },
        { title: "Windsurf", value: "windsurf", description: "Codeium Windsurf" },
        { title: "Other / Skip instructions", value: "skip" },
      ],
    });

    // Install @donkeylabs/mcp
    console.log(pc.cyan("\nInstalling @donkeylabs/mcp...\n"));
    const mcpInstallSuccess = await runCommand("bun", ["add", "-d", "@donkeylabs/mcp"], targetDir);

    if (mcpInstallSuccess) {
      console.log(pc.green("✓ Installed @donkeylabs/mcp\n"));
    }

    // Create .mcp.json
    const mcpConfig = {
      mcpServers: {
        donkeylabs: {
          command: "bunx",
          args: ["@donkeylabs/mcp"],
          cwd: "${workspaceFolder}",
        },
      },
    };

    await writeFile(join(targetDir, ".mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log(pc.green("✓ Created .mcp.json\n"));

    // Show IDE-specific instructions
    if (ide === "claude") {
      console.log(pc.cyan("Claude Code Setup:"));
      console.log(pc.dim("─".repeat(40)));
      console.log(`
The .mcp.json file has been created in your project.
Claude Code will automatically detect and use this configuration.

${pc.bold("To verify:")}
  1. Open Claude Code in this project directory
  2. The MCP tools should be available automatically
  3. Try asking Claude to "list plugins" or "get project info"
`);
    } else if (ide === "cursor") {
      console.log(pc.cyan("Cursor Setup:"));
      console.log(pc.dim("─".repeat(40)));
      console.log(`
${pc.bold("To configure Cursor:")}
  1. Open Cursor Settings (Cmd/Ctrl + ,)
  2. Search for "MCP" or "Model Context Protocol"
  3. Add the donkeylabs server from .mcp.json
  4. Restart Cursor to apply changes
`);
    } else if (ide === "windsurf") {
      console.log(pc.cyan("Windsurf Setup:"));
      console.log(pc.dim("─".repeat(40)));
      console.log(`
${pc.bold("To configure Windsurf:")}
  1. Open Windsurf settings
  2. Navigate to AI / MCP configuration
  3. Add the donkeylabs server from .mcp.json
`);
    }
  }

  // Print final success message
  console.log(pc.bold(pc.green("\n🎉 Project ready!\n")));

  if (projectType === "server") {
    console.log(`${pc.bold("Start development:")}
  ${pc.cyan("cd " + (projectDir !== "." ? projectDir : ""))}
  ${pc.cyan("bun run dev")}
`);
  } else {
    console.log(`${pc.bold("Start development:")}
  ${projectDir !== "." ? pc.cyan("cd " + projectDir) + "\n  " : ""}${pc.cyan("bun run dev")}

${pc.bold("Project structure:")}
  src/server/          - @donkeylabs/server API
  src/lib/api.ts       - Typed API client
  src/routes/          - SvelteKit pages
`);
  }

  if (setupMcp) {
    console.log(pc.dim("MCP is configured. Your AI assistant can now help you build!"));
  }
}

/**
 * Run a command and return success status
 */
async function runCommand(cmd: string, args: string[], cwd: string): Promise<boolean> {
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

    // Handle renames
    const destName = RENAME_MAP[entry.name] || entry.name;
    const destPath = join(dest, destName);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
      console.log(pc.green("  Created:"), destName);
    }
  }
}

/**
 * Copy agents.md and docs/ from @donkeylabs/server to project root
 * for AI-assisted development
 */
async function copyDocsFromServer(targetDir: string): Promise<void> {
  const serverPkgPath = join(targetDir, "node_modules", "@donkeylabs", "server");

  if (!existsSync(serverPkgPath)) {
    return; // Server package not installed
  }

  // Copy agents.md
  const agentsMdSrc = join(serverPkgPath, "agents.md");
  if (existsSync(agentsMdSrc)) {
    const agentsMdDest = join(targetDir, "agents.md");
    await copyFile(agentsMdSrc, agentsMdDest);
    console.log(pc.green("  Created:"), "agents.md (AI instructions)");
  }

  // Copy docs/ directory
  const docsSrc = join(serverPkgPath, "docs");
  if (existsSync(docsSrc)) {
    const docsDest = join(targetDir, "docs", "donkeylabs");
    await copyDirectory(docsSrc, docsDest);
    console.log(pc.green("  Created:"), "docs/donkeylabs/ (detailed documentation)");
  }
}
