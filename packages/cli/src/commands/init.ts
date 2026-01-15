/**
 * Init Command
 *
 * Initialize a new @donkeylabs/server project by copying from templates
 */

import { mkdir, writeFile, readFile, readdir, copyFile, stat } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  let projectDir = ".";
  let typeArg: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && args[i + 1]) {
      typeArg = args[i + 1];
      i++; // skip next arg
    } else if (!args[i].startsWith("-")) {
      projectDir = args[i];
    }
  }

  const targetDir = resolve(process.cwd(), projectDir);

  console.log(pc.bold("\nInitializing @donkeylabs/server project...\n"));

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

  // Print success message
  if (projectType === "server") {
    console.log(`
${pc.bold(pc.green("Success!"))} Server project initialized.

${pc.bold("Next steps:")}
  1. Install dependencies:
     ${pc.cyan("bun install")}

  2. Start development:
     ${pc.cyan("bun run dev")}

  3. Generate types after adding plugins:
     ${pc.cyan("bun run gen:types")}
`);
  } else {
    console.log(`
${pc.bold(pc.green("Success!"))} SvelteKit project initialized.

${pc.bold("Next steps:")}
  1. Install dependencies:
     ${pc.cyan("bun install")}

  2. Start development:
     ${pc.cyan("bun run dev")}

  3. Build for production:
     ${pc.cyan("bun run build")}

  4. Preview production build:
     ${pc.cyan("bun run preview")}

${pc.bold("Project structure:")}
  src/server/index.ts    - Your @donkeylabs/server API
  src/lib/api.ts         - Typed API client
  src/routes/            - SvelteKit pages
  src/hooks.server.ts    - Server hooks for SSR
`);
  }
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
