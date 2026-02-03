// packages/cli/src/commands/deploy.ts
/**
 * Deploy command for serverless platforms
 * Currently supports Vercel
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import pc from "picocolors";

export async function deployCommand(args: string[]) {
  const platform = args[0] || "vercel";

  console.log(pc.cyan(pc.bold(`\n🚀 Deploy to ${platform}\n`)));

  switch (platform) {
    case "vercel":
      await deployToVercel();
      break;
    case "help":
      showHelp();
      break;
    default:
      console.error(pc.red(`❌ Unknown platform: ${platform}`));
      console.log(pc.yellow("Supported platforms: vercel"));
      process.exit(1);
  }
}

async function deployToVercel() {
  // Check if vercel CLI is installed
  try {
    execSync("which vercel", { stdio: "pipe" });
  } catch {
    console.log(pc.yellow("⚠️  Vercel CLI not found. Installing..."));
    try {
      execSync("npm install -g vercel", { stdio: "inherit" });
    } catch {
      console.error(pc.red("❌ Failed to install Vercel CLI"));
      console.log(pc.gray("Install manually: npm install -g vercel"));
      process.exit(1);
    }
  }

  // Check project structure
  const projectDir = process.cwd();

  if (!existsSync(join(projectDir, "vercel.json"))) {
    console.log(pc.yellow("⚠️  No vercel.json found. Creating serverless configuration..."));
    await setupVercelProject(projectDir);
  }

  // Check for required environment variables
  const envFile = join(projectDir, ".env.local");
  if (existsSync(envFile)) {
    const envContent = readFileSync(envFile, "utf-8");
    if (!envContent.includes("DATABASE_URL")) {
      console.error(pc.red("❌ DATABASE_URL not found in .env.local"));
      console.log(pc.yellow("Serverless requires PostgreSQL. SQLite won't work."));
      console.log(pc.gray("Set up a PostgreSQL database and add DATABASE_URL to .env.local"));
      process.exit(1);
    }
  }

  // Build the project
  console.log(pc.blue("📦 Building project..."));
  try {
    execSync("bun run build", { stdio: "inherit" });
  } catch {
    console.error(pc.red("❌ Build failed"));
    process.exit(1);
  }

  // Deploy
  console.log(pc.blue("\n🚀 Deploying to Vercel...\n"));
  try {
    execSync("vercel --prod", { stdio: "inherit" });
  } catch {
    console.error(pc.red("❌ Deployment failed"));
    process.exit(1);
  }

  console.log(pc.green("\n✅ Deployment complete!"));
  console.log(pc.gray("\nYour API is live at the URL shown above."));
  console.log(pc.gray("Test it: curl https://your-app.vercel.app/api.health"));
}

async function setupVercelProject(projectDir: string) {
  // Create vercel.json
  const vercelConfig = {
    version: 2,
    builds: [
      {
        src: "api/index.ts",
        use: "@vercel/node",
        config: {
          includeFiles: "dist/**",
        },
      },
    ],
    routes: [
      {
        src: "/api/(.*)",
        dest: "/api/index.ts",
      },
      {
        src: "/(.*)",
        dest: "/api/index.ts",
      },
    ],
    env: {
      NODE_ENV: "production",
    },
  };

  writeFileSync(
    join(projectDir, "vercel.json"),
    JSON.stringify(vercelConfig, null, 2)
  );

  // Create api/index.ts if it doesn't exist
  const apiDir = join(projectDir, "api");
  if (!existsSync(apiDir)) {
    require("fs").mkdirSync(apiDir, { recursive: true });
  }

  if (!existsSync(join(apiDir, "index.ts"))) {
    const handlerContent = `import { createVercelHandler } from "@donkeylabs/adapter-serverless";
import { createServer } from "../src/server";

// Create server instance
const server = createServer();

// Export handler for Vercel
export default createVercelHandler(() => server);
`;
    writeFileSync(join(apiDir, "index.ts"), handlerContent);
  }

  // Create src/server/index.ts that exports createServer
  const serverDir = join(projectDir, "src", "server");
  if (!existsSync(join(serverDir, "index.ts"))) {
    const serverContent = `import { AppServer } from "@donkeylabs/server";
import { db } from "./db";

export function createServer() {
  return new AppServer({
    db,
    logger: { level: "info" },
  });
}
`;
    writeFileSync(join(serverDir, "index.ts"), serverContent);
  }

  // Update package.json with serverless adapter
  const pkgPath = join(projectDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  if (!pkg.dependencies["@donkeylabs/adapter-serverless"]) {
    pkg.dependencies["@donkeylabs/adapter-serverless"] = "latest";
  }

  if (!pkg.dependencies.pg) {
    pkg.dependencies.pg = "^8.11.0";
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  console.log(pc.green("✅ Vercel configuration created"));
  console.log(pc.gray("Created:"));
  console.log(pc.gray("  - vercel.json"));
  console.log(pc.gray("  - api/index.ts (handler entry)"));
  console.log(pc.gray("  - src/server/index.ts (server factory)"));
}

function showHelp() {
  console.log(`
${pc.bold("Deploy Command")}

Usage:
  donkeylabs deploy [platform]

Platforms:
  vercel    Deploy to Vercel (serverless)

Examples:
  donkeylabs deploy vercel

Prerequisites:
  - Vercel CLI: npm install -g vercel
  - PostgreSQL database (SQLite won't work on serverless)
  - DATABASE_URL in .env.local

First time setup:
  1. Run: vercel login
  2. Run: donkeylabs deploy vercel
  3. Follow prompts to link project

Note: Serverless deployment requires PostgreSQL.
SQLite is file-based and won't persist across serverless invocations.
`);
}
