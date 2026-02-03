// packages/cli/src/commands/init-enhanced.ts
/**
 * Enhanced project initialization with full configuration options
 * Single template that adapts based on user choices
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from "fs";
import { join, dirname } from "path";
import pc from "picocolors";

export interface InitOptions {
  projectName: string;
  database: "sqlite" | "postgres" | "mysql";
  frontend: "none" | "sveltekit";
  plugins: string[];
  includeDemo: boolean;
  deployment: "docker" | "binary" | "pm2" | "vercel" | "cloudflare" | "aws";
  enableBackup: boolean;
  enableStorage: boolean;
  setupMCP: boolean;
  gitInit: boolean;
  autoInstall: boolean;
  useLocalPackages: boolean;
}

export interface InitCommandFlags {
  useLocalPackages?: boolean;
}

// Available plugins to install (must exist in cli/plugins/)
// Note: cron is a core service (ctx.core.cron), not a plugin
const AVAILABLE_PLUGINS = [
  { name: "users", description: "User management", default: true },
  { name: "auth", description: "JWT authentication", default: true },
  { name: "email", description: "Email sending (SMTP)", default: false },
  { name: "storage", description: "File uploads (S3/Local)", default: false },
  { name: "backup", description: "Database backups", default: false },
  { name: "audit", description: "Audit logging", default: false },
  { name: "images", description: "Image processing", default: false },
  { name: "stripe", description: "Stripe payments", default: false },
];

export async function initEnhancedCommand(args: string[], flags: InitCommandFlags = {}) {
  const prompts = await import("prompts");

  if (flags.useLocalPackages) {
    console.log(pc.yellow("\n📦 Using local workspace packages (--local mode)\n"));
  }

  console.log(pc.cyan(pc.bold("\n🐴 DonkeyLabs Project Init\n")));
  
  // 1. Project name
  const projectName = args[0] || await prompts.default({
    type: "text",
    name: "name",
    message: "Project name:",
    initial: "my-app",
    validate: (value) => value.length > 0 || "Project name is required",
  }).then(r => r.name);
  
  const projectDir = join(process.cwd(), projectName);
  
  if (existsSync(projectDir)) {
    console.error(pc.red(`❌ Directory ${projectName} already exists`));
    process.exit(1);
  }
  
  // 2. Database selection
  const database = await prompts.default({
    type: "select",
    name: "value",
    message: "Choose database:",
    choices: [
      { title: "SQLite (file-based, perfect for VPS)", value: "sqlite" },
      { title: "PostgreSQL (production grade)", value: "postgres" },
      { title: "MySQL (compatible)", value: "mysql" },
    ],
    initial: 0,
  }).then(r => r.value);
  
  // 3. Frontend
  const frontend = await prompts.default({
    type: "select",
    name: "value",
    message: "Choose frontend:",
    choices: [
      { title: "None (API only)", value: "none" },
      { title: "SvelteKit (full-stack)", value: "sveltekit" },
    ],
    initial: 1,
  }).then(r => r.value);
  
  // 4. Plugins selection
  console.log(pc.cyan("\n📦 Select plugins:"));
  const pluginChoices = AVAILABLE_PLUGINS.map(p => ({
    title: `${p.name} - ${p.description}`,
    value: p.name,
    selected: p.default,
  }));
  
  const plugins = await prompts.default({
    type: "multiselect",
    name: "value",
    message: "Choose plugins (space to toggle, enter to confirm):",
    choices: pluginChoices,
    instructions: false,
  }).then(r => r.value);
  
  // 5. Demo content
  const includeDemo = await prompts.default({
    type: "confirm",
    name: "value",
    message: "Include demo content?",
    initial: true,
  }).then(r => r.value);
  
  // 6. Deployment strategy
  const deployment = await prompts.default({
    type: "select",
    name: "value",
    message: "Deployment strategy:",
    choices: [
      { title: "Docker (recommended for VPS)", value: "docker" },
      { title: "Binary (compile & run)", value: "binary" },
      { title: "PM2 (Node process manager)", value: "pm2" },
      { title: "Vercel (serverless, needs PostgreSQL)", value: "vercel" },
      { title: "Cloudflare Workers (edge, needs D1/PG)", value: "cloudflare" },
      { title: "AWS Lambda (serverless, needs PostgreSQL)", value: "aws" },
    ],
    initial: 0,
  }).then(r => r.value);
  
  // Warn if serverless with SQLite
  if (["vercel", "cloudflare", "aws"].includes(deployment) && database === "sqlite") {
    console.log(pc.yellow("\n⚠️  Warning: SQLite won't work on serverless platforms!"));
    console.log(pc.yellow("Consider using PostgreSQL instead.\n"));
    
    const continueAnyway = await prompts.default({
      type: "confirm",
      name: "value",
      message: "Continue with SQLite anyway?",
      initial: false,
    }).then(r => r.value);
    
    if (!continueAnyway) {
      console.log(pc.gray("Cancelled. Please re-run and select PostgreSQL."));
      process.exit(0);
    }
  }
  
  // 7. MCP setup
  const setupMCP = await prompts.default({
    type: "confirm",
    name: "value",
    message: "Setup MCP (AI-assisted development)?",
    initial: true,
  }).then(r => r.value);
  
  // 8. Git init
  const gitInit = await prompts.default({
    type: "confirm",
    name: "value",
    message: "Initialize git repository?",
    initial: true,
  }).then(r => r.value);
  
  // 9. Auto-install
  const autoInstall = await prompts.default({
    type: "confirm",
    name: "value",
    message: "Run bun install automatically?",
    initial: true,
  }).then(r => r.value);
  
  const options: InitOptions = {
    projectName,
    database,
    frontend,
    plugins,
    includeDemo,
    deployment,
    enableBackup: plugins.includes("backup"),
    enableStorage: plugins.includes("storage"),
    setupMCP,
    gitInit,
    autoInstall,
    useLocalPackages: flags.useLocalPackages || false,
  };
  
  // Create project
  console.log(pc.cyan(`\n🚀 Creating project ${projectName}...\n`));

  if (options.useLocalPackages) {
    console.log(pc.yellow("  Using local packages (--local mode):"));
    console.log(pc.gray("  - @donkeylabs/server → file:../relative/path"));
    console.log(pc.gray("  - @donkeylabs/adapter-sveltekit → file:../relative/path\n"));
  }

  await createProject(projectDir, options);
  
  // Setup MCP if requested
  if (options.setupMCP) {
    console.log(pc.blue("\n🤖 Setting up MCP..."));
    createMCPConfig(projectDir, options);
  }
  
  // Auto-install dependencies
  if (options.autoInstall) {
    console.log(pc.blue("\n📦 Installing dependencies..."));
    console.log(pc.gray(`  Running in: ${projectDir}`));
    try {
      const { execSync } = await import("child_process");
      execSync("bun install", {
        cwd: projectDir,
        stdio: "inherit",
        timeout: 120000, // 2 minute timeout
      });
      console.log(pc.green("✅ Dependencies installed!"));
    } catch (error: any) {
      console.log(pc.yellow("\n⚠️  Failed to install dependencies automatically"));
      console.log(pc.red(`  Error: ${error.message}`));
      if (error.stderr) {
        console.log(pc.gray(`  Details: ${error.stderr}`));
      }
      console.log(pc.gray("\n  Please run 'bun install' manually"));
    }
  }
  
  console.log(pc.green(`\n✅ Project created successfully!\n`));
  
  // Show next steps
  console.log(pc.bold("Next steps:\n"));
  console.log(`  cd ${projectName}`);
  
  if (!options.autoInstall) {
    console.log(`  bun install`);
  }
  
  if (frontend === "sveltekit") {
    console.log(`  bun run dev`);
  } else {
    console.log(`  bun run start`);
  }
  
  if (deployment === "docker") {
    console.log(pc.cyan(`\n🐳 To deploy with Docker:\n`));
    console.log(`  docker-compose up -d`);
  }
  
  if (options.setupMCP) {
    console.log(pc.cyan(`\n🤖 MCP is configured!\n`));
    console.log(`  MCP config: .mcp.json`);
    console.log(`  Use donkeylabs MCP tools in your IDE`);
  }
  
  console.log(pc.gray(`\n📖 Documentation: https://donkeylabs.io/docs`));
}

export async function createProject(projectDir: string, options: InitOptions) {
  // Create directory structure
  mkdirSync(projectDir, { recursive: true });
  
  // Base files
  createPackageJson(projectDir, options);
  createReadme(projectDir, options);
  createGitignore(projectDir, options);
  createDonkeylabsConfig(projectDir, options);
  createTsconfig(projectDir, options);
  
  // Server files
  mkdirSync(join(projectDir, "src", "server"), { recursive: true });
  createServerIndex(projectDir, options);
  
  // Database configuration
  createDatabaseConfig(projectDir, options);
  
  // Plugins
  if (options.plugins.length > 0) {
    mkdirSync(join(projectDir, "src", "server", "plugins"), { recursive: true });
    for (const pluginName of options.plugins) {
      await createPlugin(projectDir, pluginName, options);
    }
  }
  
  // Routes
  mkdirSync(join(projectDir, "src", "server", "routes"), { recursive: true });
  createRoutes(projectDir, options);
  
  // Frontend (if selected)
  if (options.frontend === "sveltekit") {
    await createSvelteKitFrontend(projectDir, options);
  }
  
  // Demo content
  if (options.includeDemo) {
    createDemoContent(projectDir, options);
  }
  
  // Deployment files
  createDeploymentFiles(projectDir, options);
  
  // Environment files
  createEnvFiles(projectDir, options);
  
  // Git init
  if (options.gitInit) {
    await initGit(projectDir);
  }
}

function createPackageJson(projectDir: string, options: InitOptions) {
  const isSvelteKit = options.frontend === "sveltekit";

  // Calculate relative paths to monorepo packages when using --local
  // Assumes CLI is at packages/cli and project is created relative to cwd
  const getPackagePath = (pkgName: string) => {
    if (!options.useLocalPackages) return "latest";

    // Find monorepo root by looking for root package.json with workspaces
    const { existsSync, readFileSync } = require("fs");
    const { join, relative, dirname } = require("path");

    let searchDir = process.cwd();
    let monorepoRoot = null;

    // Walk up to find monorepo root
    for (let i = 0; i < 10; i++) {
      const pkgPath = join(searchDir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          if (pkg.workspaces) {
            monorepoRoot = searchDir;
            break;
          }
        } catch {}
      }
      const parent = dirname(searchDir);
      if (parent === searchDir) break;
      searchDir = parent;
    }

    if (!monorepoRoot) {
      console.warn(`Warning: Could not find monorepo root, using "latest" for ${pkgName}`);
      return "latest";
    }

    // Map package names to their paths
    const packagePaths: Record<string, string> = {
      "@donkeylabs/server": "packages/server",
      "@donkeylabs/adapter-sveltekit": "packages/adapter-sveltekit",
      "@donkeylabs/cli": "packages/cli",
      "@donkeylabs/mcp": "packages/mcp",
    };

    const pkgRelPath = packagePaths[pkgName];
    if (!pkgRelPath) return "latest";

    const absolutePkgPath = join(monorepoRoot, pkgRelPath);
    const relativePath = relative(projectDir, absolutePkgPath);

    return `file:${relativePath}`;
  };

  const pkg = {
    name: options.projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: isSvelteKit ? {
      "dev": "bun --bun vite dev",
      "build": "bun run gen:types && vite build",
      "preview": "bun build/server/entry.js",
      "prepare": "bun --bun svelte-kit sync && bun run gen:types || echo ''",
      "check": "bun --bun svelte-kit sync && bun --bun svelte-check --tsconfig ./tsconfig.json",
      "gen:types": "donkeylabs generate",
      "update": "donkeylabs update",
      "cli": "donkeylabs",
      "test": "bun test",
      ...(options.deployment === "docker" && {
        "docker:build": "docker-compose build",
        "docker:up": "docker-compose up -d",
        "docker:down": "docker-compose down",
      }),
    } : {
      "dev": "bun --watch run src/server/index.ts",
      "build": "bun build src/server/index.ts --outdir=dist",
      "start": "bun run dist/index.js",
      "gen:types": "bunx donkeylabs generate",
      "update": "bunx donkeylabs update",
      "test": "bun test",
      "lint": "bun --bun tsc --noEmit",
      ...(options.deployment === "docker" && {
        "docker:build": "docker-compose build",
        "docker:up": "docker-compose up -d",
        "docker:down": "docker-compose down",
      }),
    },
    dependencies: {
      "@donkeylabs/server": getPackagePath("@donkeylabs/server"),
      "zod": "^3.24.0",
      "kysely": "^0.27.6",
      ...(options.database === "sqlite" && { "kysely-bun-sqlite": "^0.3.2" }),
      ...(options.database === "postgres" && { "pg": "^8.11.0" }),
      ...(options.database === "mysql" && { "mysql2": "^3.6.0" }),
      ...(options.enableStorage && { "@aws-sdk/client-s3": "^3.450.0" }),
      ...(isSvelteKit && {
        "@donkeylabs/adapter-sveltekit": getPackagePath("@donkeylabs/adapter-sveltekit"),
        "@donkeylabs/cli": getPackagePath("@donkeylabs/cli"),
        "clsx": "^2.1.1",
        "tailwind-merge": "^3.4.0",
        "tailwind-variants": "^3.2.2",
      }),
    },
    devDependencies: {
      "@types/bun": "latest",
      "typescript": "^5.9.3",
      ...(isSvelteKit && {
        "@sveltejs/kit": "^2.49.1",
        "@sveltejs/vite-plugin-svelte": "^6.2.1",
        "@tailwindcss/vite": "^4.1.18",
        "svelte": "^5.45.6",
        "svelte-check": "^4.3.4",
        "tailwindcss": "^4.1.18",
        "vite": "^7.2.6",
      }),
    },
  };

  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(pkg, null, 2)
  );
}

function createServerIndex(projectDir: string, options: InitOptions) {
  const isSvelteKit = options.frontend === "sveltekit";
  const hasUsers = options.plugins.includes("users");
  const hasAuth = options.plugins.includes("auth");
  const hasBackup = options.plugins.includes("backup");
  
  let content = `import { AppServer, type LogLevel } from "@donkeylabs/server";
import { db } from "./db";

// Global type declaration for hot reload guard
declare global {
  var __donkeylabsServerStarted__: boolean | undefined;
}

const PORT = parseInt(process.env.PORT || "3000");
`;

  // Import plugins
  if (options.plugins.length > 0) {
    content += `
// Plugins
`;
    for (const plugin of options.plugins) {
      content += `import { ${plugin}Plugin } from "./plugins/${plugin}";\n`;
    }
  }

  // Import routes
  content += `
// Routes
import { apiRouter } from "./routes/api";
`;

  content += `
const server = new AppServer({
  port: PORT,
  db,
  
  // Production logging
  logger: {
    level: (process.env.LOG_LEVEL as LogLevel) || "info",
    format: process.env.NODE_ENV === "production" ? "json" : "pretty",
  },
  
  // Enable admin dashboard in development
  admin: process.env.NODE_ENV !== "production" ? { enabled: true } : undefined,
  
  // Cache
  cache: {
    defaultTtlMs: 300000,
    maxSize: 10000,
  },
});

// Register plugins
`;

  // Register plugins with config
  for (const plugin of options.plugins) {
    if (plugin === "backup") {
      content += `server.registerPlugin(${plugin}Plugin({
  adapter: "litestream",
  adapterConfig: {
    url: process.env.BACKUP_S3_URL || "s3://my-backup-bucket/db",
    accessKeyId: process.env.BACKUP_ACCESS_KEY || "",
    secretAccessKey: process.env.BACKUP_SECRET_KEY || "",
    region: process.env.BACKUP_REGION || "us-east-1",
  },
  schedule: "0 2 * * *", // Daily at 2 AM
  retentionCount: 7,
}));\n`;
    } else if (plugin === "storage") {
      content += `server.registerPlugin(${plugin}Plugin({
  adapter: process.env.STORAGE_ADAPTER || "local",
  localConfig: {
    uploadDir: process.env.UPLOAD_DIR || "./uploads",
  },
  s3Config: {
    bucket: process.env.S3_BUCKET || "",
    region: process.env.S3_REGION || "us-east-1",
    accessKeyId: process.env.S3_ACCESS_KEY || "",
    secretAccessKey: process.env.S3_SECRET_KEY || "",
  },
}));\n`;
    } else {
      content += `server.registerPlugin(${plugin}Plugin);\n`;
    }
  }

  content += `
// Register routes
server.use(apiRouter);

// Health check
server.onReady((ctx) => {
  ctx.core.logger.info("Server ready", { 
    port: PORT,
    plugins: [${options.plugins.map(p => `"${p}"`).join(", ")}],
  });
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  await server.shutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await server.shutdown();
  process.exit(0);
});

// Export server for adapter
export { server };

// Guard against re-initialization on hot reload
if (!globalThis.__donkeylabsServerStarted__) {
  globalThis.__donkeylabsServerStarted__ = true;
  await server.start();
  console.log(\`🚀 Server running at http://localhost:\${PORT}\`);
}
`;

  writeFileSync(join(projectDir, "src", "server", "index.ts"), content);
}

function createDatabaseConfig(projectDir: string, options: InitOptions) {
  let content = `import { Kysely } from "kysely";
`;

  if (options.database === "sqlite") {
    content += `import { SqliteDialect } from "kysely";
import { Database as BunDatabase } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

const dbPath = process.env.DATABASE_URL || "./data/app.db";

// Ensure directory exists
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Kysely<any>({
  dialect: new SqliteDialect({
    database: new BunDatabase(dbPath),
  }),
});
`;
  } else if (options.database === "postgres") {
    content += `import { PostgresDialect } from "kysely";
import { Pool } from "pg";

export const db = new Kysely<any>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
    }),
  }),
});
`;
  } else if (options.database === "mysql") {
    content += `import { MysqlDialect } from "kysely";
import { createPool } from "mysql2";

export const db = new Kysely<any>({
  dialect: new MysqlDialect({
    pool: createPool({
      uri: process.env.DATABASE_URL,
      connectionLimit: 20,
    }),
  }),
});
`;
  }

  writeFileSync(join(projectDir, "src", "server", "db.ts"), content);
}

// Copy directory recursively
function copyDirRecursive(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      const content = readFileSync(srcPath);
      writeFileSync(destPath, content);
    }
  }
}

// Create other files...
async function createPlugin(projectDir: string, pluginName: string, options: InitOptions) {
  const cliPluginsDir = "/Users/franciscosainzwilliams/Documents/GitHub/server/packages/cli/plugins";
  const sourcePluginDir = join(cliPluginsDir, pluginName);
  const targetPluginDir = join(projectDir, "src", "server", "plugins", pluginName);
  
  // Check if plugin exists in CLI plugins directory
  if (existsSync(sourcePluginDir)) {
    // Copy entire plugin directory recursively
    copyDirRecursive(sourcePluginDir, targetPluginDir);
    return;
  }
  
  // Fall back to template generation
  const pluginTemplates: Record<string, string> = {
    users: createUsersPluginTemplate(),
    auth: createAuthPluginTemplate(),
    backup: createBackupPluginTemplate(),
    storage: createStoragePluginTemplate(),
    email: createEmailPluginTemplate(),
    audit: createAuditPluginTemplate(),
  };
  
  const content = pluginTemplates[pluginName] || createGenericPluginTemplate(pluginName);
  
  mkdirSync(targetPluginDir, { recursive: true });
  writeFileSync(join(targetPluginDir, "index.ts"), content);
  
  // Create migrations if needed
  if (["users", "auth", "storage", "audit"].includes(pluginName)) {
    mkdirSync(join(targetPluginDir, "migrations"), { recursive: true });
  }
}

function createUsersPluginTemplate(): string {
  return `import { createPlugin } from "@donkeylabs/server";

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export const usersPlugin = createPlugin
  .withSchema<{ users: User }>()
  .define({
    name: "users",
    service: async (ctx) => ({
      async getById(id: string) {
        return ctx.db
          .selectFrom("users")
          .where("id", "=", id)
          .selectAll()
          .executeTakeFirst();
      },
      
      async getByEmail(email: string) {
        return ctx.db
          .selectFrom("users")
          .where("email", "=", email)
          .selectAll()
          .executeTakeFirst();
      },
      
      async create(data: Omit<User, "id" | "createdAt">) {
        const id = crypto.randomUUID();
        return ctx.db
          .insertInto("users")
          .values({
            id,
            email: data.email,
            name: data.name,
            createdAt: new Date().toISOString(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      },
      
      async list() {
        return ctx.db
          .selectFrom("users")
          .selectAll()
          .execute();
      },
      
      async update(id: string, data: Partial<Omit<User, "id" | "createdAt">>) {
        return ctx.db
          .updateTable("users")
          .set(data)
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirstOrThrow();
      },
      
      async delete(id: string) {
        await ctx.db
          .deleteFrom("users")
          .where("id", "=", id)
          .execute();
      },
    }),
  });
`;
}

function createAuthPluginTemplate(): string {
  return `import { createPlugin } from "@donkeylabs/server";
import { sign, verify } from "jsonwebtoken";

export interface AuthConfig {
  jwtSecret: string;
  tokenExpiry?: string;
}

export const authPlugin = createPlugin
  .withConfig<AuthConfig>()
  .define({
    name: "auth",
    dependencies: ["users"] as const,
    service: async (ctx) => {
      const jwtSecret = ctx.config.jwtSecret;
      
      return {
        async createToken(userId: string, email: string) {
          return sign(
            { userId, email },
            jwtSecret,
            { expiresIn: ctx.config.tokenExpiry || "7d" }
          );
        },
        
        async verifyToken(token: string) {
          try {
            return verify(token, jwtSecret) as { userId: string; email: string };
          } catch {
            return null;
          }
        },
        
        async authenticate(email: string, password: string) {
          const user = await ctx.deps.users.getByEmail(email);
          if (!user) return null;
          
          // TODO: Add password hashing comparison
          // For now, this is a placeholder
          if (password === "password") {
            const token = await this.createToken(user.id, user.email);
            return { user, token };
          }
          
          return null;
        },
        
        middleware: (ctx, service) => ({
          authRequired: async (req, reqCtx, next) => {
            const authHeader = req.headers.get("Authorization");
            if (!authHeader?.startsWith("Bearer ")) {
              return Response.json({ error: "Unauthorized" }, { status: 401 });
            }
            
            const token = authHeader.replace("Bearer ", "");
            const payload = await service.verifyToken(token);
            
            if (!payload) {
              return Response.json({ error: "Invalid token" }, { status: 401 });
            }
            
            reqCtx.user = payload;
            return next();
          },
        }),
      };
    },
  });
`;
}

function createBackupPluginTemplate(): string {
  return `import { createPlugin } from "@donkeylabs/server";
import { execSync, spawn } from "child_process";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, stat, readdir, unlink } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";

export interface BackupConfig {
  adapter: "s3" | "local";
  schedule?: string;
  retentionCount?: number;
  s3Config?: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint?: string;
  };
  localConfig?: {
    backupDir: string;
  };
}

export interface BackupInfo {
  id: string;
  timestamp: Date;
  size: number;
  type: "full";
  status: "complete" | "in_progress" | "failed";
  location: string;
}

export const backupPlugin = createPlugin
  .withConfig<BackupConfig>()
  .define({
    name: "backup",
    service: async (ctx) => {
      const config = ctx.config;
      
      // Schedule automatic backups if configured
      if (config.schedule) {
        ctx.core.cron.schedule(config.schedule, async () => {
          ctx.core.logger.info("Running scheduled backup");
          try {
            await service.backup();
            ctx.core.logger.info("Scheduled backup completed");
          } catch (error) {
            ctx.core.logger.error("Scheduled backup failed", { error });
          }
        }, { name: "backup-job" });
      }
      
      const service = {
        /** Perform a manual backup */
        async backup(): Promise<BackupInfo> {
          ctx.core.logger.info("Backup requested");
          
          const timestamp = new Date();
          const backupId = \`backup-\${timestamp.toISOString().replace(/[:.]/g, "-")}\`;
          
          // TODO: Implement backup logic based on config.adapter
          // For now, return placeholder
          
          const info: BackupInfo = {
            id: backupId,
            timestamp,
            size: 0,
            type: "full",
            status: "complete",
            location: config.adapter === "s3" 
              ? \`s3://\${config.s3Config?.bucket}/backups/\${backupId}.sql.gz\`
              : join(config.localConfig?.backupDir || "./backups", \`\${backupId}.db.gz\`),
          };
          
          // Clean up old backups if retention is configured
          if (config.retentionCount) {
            await service.cleanupOldBackups(config.retentionCount);
          }
          
          return info;
        },
        
        /** List available backups */
        async listBackups(): Promise<BackupInfo[]> {
          // TODO: List backups from S3 or local
          return [];
        },
        
        /** Clean up old backups */
        async cleanupOldBackups(retainCount: number): Promise<void> {
          const backups = await service.listBackups();
          const sorted = backups.sort((a, b) => 
            b.timestamp.getTime() - a.timestamp.getTime()
          );
          
          const toDelete = sorted.slice(retainCount);
          for (const backup of toDelete) {
            ctx.core.logger.info(\`Deleting old backup: \${backup.id}\`);
          }
        },
      };
      
      return service;
    },
  });
`;
}

function createStoragePluginTemplate(): string {
  return `import { createPlugin } from "@donkeylabs/server";

export interface StorageConfig {
  adapter: "local" | "s3";
  localConfig?: { uploadDir: string };
  s3Config?: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export const storagePlugin = createPlugin
  .withConfig<StorageConfig>()
  .define({
    name: "storage",
    service: async (ctx) => {
      const config = ctx.config;
      
      return {
        async upload(file: File, key: string) {
          if (config.adapter === "local") {
            const { writeFileSync } = await import("fs");
            const { join } = await import("path");
            const buffer = await file.arrayBuffer();
            const path = join(config.localConfig!.uploadDir, key);
            writeFileSync(path, new Uint8Array(buffer));
            return { key, url: \`/uploads/\${key}\` };
          }
          
          // S3 upload
          // Implementation here...
          return { key, url: \`https://\${config.s3Config!.bucket}.s3.amazonaws.com/\${key}\` };
        },
        
        async getUrl(key: string) {
          if (config.adapter === "local") {
            return \`/uploads/\${key}\`;
          }
          return \`https://\${config.s3Config!.bucket}.s3.amazonaws.com/\${key}\`;
        },
      };
    },
  });
`;
}

function createEmailPluginTemplate(): string {
  return `import { createPlugin } from "@donkeylabs/server";

export interface EmailConfig {
  smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
  };
  from: string;
}

export const emailPlugin = createPlugin
  .withConfig<EmailConfig>()
  .define({
    name: "email",
    service: async (ctx) => ({
      async send(to: string, subject: string, body: string, html?: string) {
        // SMTP implementation
        ctx.core.logger.info("Sending email", { to, subject });
        
        // TODO: Implement actual SMTP sending
        // You can use nodemailer or similar
        
        return { messageId: crypto.randomUUID() };
      },
      
      async sendTemplate(to: string, template: string, data: Record<string, string>) {
        // Template email sending
        return this.send(to, "Subject", "Body");
      },
    }),
  });
`;
}

function createCronPluginTemplate(): string {
  return `import { createPlugin } from "@donkeylabs/server";

export const cronPlugin = createPlugin.define({
  name: "cron",
  service: async (ctx) => {
    // Example: Schedule a daily cleanup job
    ctx.core.cron.schedule("0 0 * * *", async () => {
      ctx.core.logger.info("Running daily cleanup job");
      // Cleanup logic here
    }, { name: "daily-cleanup" });
    
    return {
      async schedule(cronExpression: string, job: () => Promise<void>, options?: { name?: string }) {
        ctx.core.cron.schedule(cronExpression, job, options);
      },
    };
  },
});
`;
}

function createAuditPluginTemplate(): string {
  return `import { createPlugin } from "@donkeylabs/server";

export interface AuditEvent {
  id: string;
  action: string;
  userId?: string;
  resource: string;
  resourceId: string;
  changes?: Record<string, any>;
  timestamp: string;
}

export const auditPlugin = createPlugin
  .withSchema<{ audit_log: AuditEvent }>()
  .define({
    name: "audit",
    service: async (ctx) => ({
      async log(action: string, resource: string, resourceId: string, userId?: string, changes?: Record<string, any>) {
        await ctx.db
          .insertInto("audit_log")
          .values({
            id: crypto.randomUUID(),
            action,
            userId,
            resource,
            resourceId,
            changes: changes ? JSON.stringify(changes) : null,
            timestamp: new Date().toISOString(),
          })
          .execute();
      },
      
      async getHistory(resource: string, resourceId: string) {
        return ctx.db
          .selectFrom("audit_log")
          .where("resource", "=", resource)
          .where("resourceId", "=", resourceId)
          .orderBy("timestamp", "desc")
          .selectAll()
          .execute();
      },
    }),
  });
`;
}

function createGenericPluginTemplate(name: string): string {
  return `import { createPlugin } from "@donkeylabs/server";

export const ${name}Plugin = createPlugin.define({
  name: "${name}",
  service: async (ctx) => ({
    // Add your service methods here
    async doSomething() {
      return { success: true };
    },
  }),
});
`;
}

// ... continue with other functions

function createRoutes(projectDir: string, options: InitOptions) {
  const hasUsers = options.plugins.includes("users");

  let routesContent = `import { createRouter, defineRoute } from "@donkeylabs/server";
import { z } from "zod";

export const apiRouter = createRouter("api", {
  // Plugins are available via ctx.plugins
});

// Health check - GET /api.health (raw handler to accept GET requests)
apiRouter.route("health").raw(async (req, ctx) => {
  return Response.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});
`;

  // Add users routes if plugin is included
  if (hasUsers) {
    routesContent += `
// Users routes - requires users plugin
apiRouter.route("users.list").typed(defineRoute({
  output: z.array(z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
  })),
  handle: async (_, ctx) => {
    return ctx.plugins.users.list();
  },
}));
`;
  }

  const content = routesContent;

  writeFileSync(join(projectDir, "src", "server", "routes", "api.ts"), content);
}

// Continue with other helper functions...
async function createSvelteKitFrontend(projectDir: string, options: InitOptions) {
  // Create SvelteKit app structure
  const content = {
    "src/app.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="%sveltekit.assets%/favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`,
    "src/routes/+layout.svelte": `<script>
  import '../app.css';
  let { children } = $props();
</script>

{@render children()}
`,
    "src/routes/+page.svelte": `<script lang="ts">
  import { onMount } from 'svelte';

  let health = $state<{ status: string; timestamp?: string; uptime?: number } | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      const res = await fetch('/api.health');
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      health = await res.json();
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  });
</script>

<svelte:head>
  <title>${options.projectName}</title>
</svelte:head>

<div class="min-h-screen bg-gray-50">
  <div class="container mx-auto max-w-4xl py-16 px-4">
    <div class="text-center mb-12">
      <h1 class="text-4xl font-bold tracking-tight text-gray-900">${options.projectName}</h1>
      <p class="text-gray-600 mt-2 text-lg">Built with DonkeyLabs</p>
    </div>

    <div class="bg-white rounded-xl shadow-sm border p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Server Status</h2>
      {#if loading}
        <div class="text-gray-500">Checking server...</div>
      {:else if error}
        <div class="flex items-center gap-2 text-red-600">
          <span class="w-3 h-3 bg-red-500 rounded-full"></span>
          Error: {error}
        </div>
      {:else if health}
        <div class="flex items-center gap-2 text-green-600">
          <span class="w-3 h-3 bg-green-500 rounded-full"></span>
          {health.status}
        </div>
        {#if health.timestamp}
          <p class="text-gray-500 text-sm mt-2">Last checked: {new Date(health.timestamp).toLocaleString()}</p>
        {/if}
        {#if health.uptime}
          <p class="text-gray-500 text-sm">Uptime: {Math.floor(health.uptime)}s</p>
        {/if}
      {/if}
    </div>

    <div class="bg-white rounded-xl shadow-sm border p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Getting Started</h2>
      <ol class="list-decimal list-inside space-y-2 text-gray-700">
        <li>Edit <code class="bg-gray-100 px-2 py-0.5 rounded text-sm">src/server/routes/api.ts</code> to add API routes</li>
        <li>Edit <code class="bg-gray-100 px-2 py-0.5 rounded text-sm">src/routes/+page.svelte</code> to customize this page</li>
        <li>Run <code class="bg-gray-100 px-2 py-0.5 rounded text-sm">bun run gen:types</code> to generate typed API client</li>
      </ol>
    </div>

    <div class="bg-white rounded-xl shadow-sm border p-6">
      <h2 class="text-xl font-semibold mb-4">Project Info</h2>
      <ul class="space-y-2 text-gray-700">
        <li><strong>Database:</strong> ${options.database}</li>
        <li><strong>Plugins:</strong> ${options.plugins.join(", ") || "None"}</li>
        <li><strong>Deployment:</strong> ${options.deployment}</li>
      </ul>
    </div>
  </div>
</div>
`,
    "src/app.css": `@import "tailwindcss";

/* Your global styles here */
`,
    "vite.config.ts": `import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { donkeylabsDev } from '@donkeylabs/adapter-sveltekit/vite';

export default defineConfig({
  plugins: [donkeylabsDev(), tailwindcss(), sveltekit()],
  ssr: {
    // Bundle @donkeylabs packages in SSR so TypeScript files get transpiled
    noExternal: ['@donkeylabs/adapter-sveltekit', '@donkeylabs/server'],
  },
});
`,
    "svelte.config.ts": `import adapter from '@donkeylabs/adapter-sveltekit';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

import type { Config } from '@sveltejs/kit';

const config: Config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),
    alias: {
      $server: '.@donkeylabs/server',
    }
  }
};

export default config;
`,
    "src/hooks.server.ts": `import { createHandle } from "@donkeylabs/adapter-sveltekit/hooks";

export const handle = createHandle();
`,
  };
  
  for (const [filePath, content_str] of Object.entries(content)) {
    const fullPath = join(projectDir, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content_str);
  }
}

function createDemoContent(projectDir: string, options: InitOptions) {
  const isSvelteKit = options.frontend === "sveltekit";

  // For SvelteKit, the base +page.svelte already includes demo content with Tailwind
  // This function can be used to add additional demo files if needed
  if (isSvelteKit) {
    // Add a +page.server.ts for SSR demo
    const pageServer = `import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  return {
    isSSR: true,
    loadedAt: new Date().toISOString(),
  };
};
`;
    writeFileSync(join(projectDir, "src/routes/+page.server.ts"), pageServer);
    return;
  }

  // For API-only projects, no demo content needed
}

function createDeploymentFiles(projectDir: string, options: InitOptions) {
  if (options.deployment === "docker") {
    createDockerFiles(projectDir, options);
  } else if (options.deployment === "pm2") {
    createPM2Files(projectDir, options);
  } else if (options.deployment === "vercel") {
    createVercelFiles(projectDir, options);
  } else if (options.deployment === "cloudflare") {
    createCloudflareFiles(projectDir, options);
  } else if (options.deployment === "aws") {
    createAWSFiles(projectDir, options);
  }
  
  // Create MCP configuration for all deployment types
  createMCPConfig(projectDir, options);
}

function createDockerFiles(projectDir: string, options: InitOptions) {
  const isSvelteKit = options.frontend === "sveltekit";
  
  // Dockerfile
  const dockerfile = `# Build stage
FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Production stage
FROM oven/bun:1-alpine
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S bunuser -u 1001

${options.database === "sqlite" ? `# Create data directory for SQLite
RUN mkdir -p /data && chown bunuser:nodejs /data
` : ""}

# Copy built app
COPY --from=builder --chown=bunuser:nodejs /app/dist ./dist
COPY --from=builder --chown=bunuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=bunuser:nodejs /app/package.json ./package.json

# Switch to non-root user
USER bunuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
${options.database === "sqlite" ? "ENV DATABASE_URL=/data/app.db" : ""}

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD curl -f http://localhost:3000/api.health || exit 1

CMD ["bun", "run", "start"]
`;

  writeFileSync(join(projectDir, "Dockerfile"), dockerfile);
  
  // docker-compose.yml
  const compose = `services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
${options.database === "sqlite" ? `    volumes:
      - sqlite_data:/data
` : options.database === "postgres" ? `      - DATABASE_URL=postgresql://postgres:postgres@db:5432/app
    depends_on:
      - db

  db:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=app
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d app"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped
` : ""}
    restart: unless-stopped
${options.enableBackup ? `
  # Litestream for SQLite backups (installed in app container)
  # Backup is handled by the backup plugin inside the app container
  # See: https://litestream.io/install/debian/
` : ""}

volumes:
${options.database === "sqlite" ? "  sqlite_data:" : options.database === "postgres" ? "  postgres_data:" : ""}
`;

  writeFileSync(join(projectDir, "docker-compose.yml"), compose);
  
  // .dockerignore
  writeFileSync(join(projectDir, ".dockerignore"), `node_modules
.git
.env
*.md
dist
.DS_Store
`);
}

function createPM2Files(projectDir: string, options: InitOptions) {
  const pm2Config = `module.exports = {
  apps: [{
    name: '${options.projectName}',
    script: './dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    time: true,
  }],
};
`;

  writeFileSync(join(projectDir, "ecosystem.config.js"), pm2Config);
  mkdirSync(join(projectDir, "logs"), { recursive: true });
}

function createMCPConfig(projectDir: string, options: InitOptions) {
  const mcpConfig = {
    mcpServers: {
      donkeylabs: {
        command: "bunx",
        args: ["-y", "@donkeylabs/mcp"],
        env: {
          DONKEYLABS_MCP: "true"
        }
      }
    }
  };

  writeFileSync(
    join(projectDir, ".mcp.json"),
    JSON.stringify(mcpConfig, null, 2)
  );
}

function createVercelFiles(projectDir: string, options: InitOptions) {
  // vercel.json
  const vercelConfig = {
    version: 2,
    builds: [
      {
        src: "api/index.ts",
        use: "@vercel/node"
      }
    ],
    routes: [
      {
        src: "/(.*)",
        dest: "api/index.ts"
      }
    ]
  };

  writeFileSync(
    join(projectDir, "vercel.json"),
    JSON.stringify(vercelConfig, null, 2)
  );

  // api/index.ts
  const apiIndex = `import { AppServer } from "@donkeylabs/server";
import { db } from "../src/server/db";

const server = new AppServer({
  port: parseInt(process.env.PORT || "3000"),
  db,
  logger: {
    level: "info",
    format: "json",
  },
});

export default async function handler(req: Request) {
  return server.handle(req);
}
`;

  mkdirSync(join(projectDir, "api"), { recursive: true });
  writeFileSync(join(projectDir, "api", "index.ts"), apiIndex);

  // .vercelignore
  writeFileSync(
    join(projectDir, ".vercelignore"),
    `node_modules
.git
.env
*.md
.DS_Store
`
  );
}

function createCloudflareFiles(projectDir: string, options: InitOptions) {
  // wrangler.toml
  const wranglerConfig = `name = "${options.projectName}"
main = "src/index.ts"
compatibility_date = "2024-01-01"

# D1 Database (if using SQLite on Cloudflare)
[[d1_databases]]
binding = "DB"
database_name = "${options.projectName}-db"
database_id = "your-database-id-here"

# Environment variables
[vars]
NODE_ENV = "production"
`;

  writeFileSync(join(projectDir, "wrangler.toml"), wranglerConfig);

  // src/index.ts for Cloudflare Workers
  const workerIndex = `import { AppServer } from "@donkeylabs/server";

export interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const server = new AppServer({
      port: 3000,
      db: env.DB as any, // D1 binding
      logger: {
        level: "info",
        format: "json",
      },
    });

    return server.handle(request);
  },
};
`;

  writeFileSync(join(projectDir, "src", "index.ts"), workerIndex);

  // .dev.vars.example
  writeFileSync(
    join(projectDir, ".dev.vars.example"),
    `NODE_ENV=development
# Add your local development variables here
`
  );
}

function createAWSFiles(projectDir: string, options: InitOptions) {
  // template.yaml for SAM
  const templateYaml = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: ${options.projectName} - DonkeyLabs Serverless Application

Globals:
  Function:
    Timeout: 30
    Runtime: nodejs20.x
    MemorySize: 512

Resources:
  ApiGatewayApi:
    Type: AWS::Serverless::Api
    Properties:
      StageName: prod
      Cors:
        AllowMethods: "'GET,POST,PUT,DELETE,OPTIONS'"
        AllowHeaders: "'Content-Type,Authorization'"
        AllowOrigin: "'*'"

  LambdaFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: ${options.projectName}
      Handler: index.handler
      CodeUri: ./dist
      Events:
        ApiEvent:
          Type: Api
          Properties:
            Path: /{proxy+}
            Method: ANY
            RestApiId: !Ref ApiGatewayApi
      Environment:
        Variables:
          NODE_ENV: production
          DATABASE_URL: !Ref DatabaseUrl

Parameters:
  DatabaseUrl:
    Type: String
    Description: PostgreSQL connection string

Outputs:
  ApiUrl:
    Description: API Gateway endpoint URL
    Value: !Sub "https://\${ApiGatewayApi}.execute-api.\${AWS::Region}.amazonaws.com/prod/"
`;

  writeFileSync(join(projectDir, "template.yaml"), templateYaml);

  // samconfig.toml
  const samConfig = `version = 0.1
[default]
[default.global.parameters]
stack_name = "${options.projectName}"

[default.build.parameters]
cached = true
parallel = true

[default.validate.parameters]
lint = true

[default.deploy.parameters]
capabilities = "CAPABILITY_IAM"
confirm_changeset = true
resolve_s3 = true
region = "us-east-1"

[default.sync.parameters]
watch = true

[default.local_start_api.parameters]
warm_containers = EAGER

[default.local_start_lambda.parameters]
warm_containers = EAGER
`;

  writeFileSync(join(projectDir, "samconfig.toml"), samConfig);

  // Lambda handler
  const lambdaHandler = `import { AppServer } from "@donkeylabs/server";
import { db } from "./server/db";

const server = new AppServer({
  port: 3000,
  db,
  logger: {
    level: "info",
    format: "json",
  },
});

export const handler = async (event: any, context: any) => {
  // Convert Lambda event to Request
  const url = \`http://\${event.headers.Host || 'localhost'}\${event.path}\`;
  const request = new Request(url, {
    method: event.httpMethod,
    headers: event.headers,
    body: event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : undefined,
  });

  const response = await server.handle(request);
  
  // Convert Response to Lambda response format
  const body = await response.text();
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: body,
  };
};
`;

  writeFileSync(join(projectDir, "src", "lambda.ts"), lambdaHandler);
}

function createEnvFiles(projectDir: string, options: InitOptions) {
  // .env.example
  let envExample = `# Environment Configuration
NODE_ENV=development
PORT=3000

# Database
`;

  if (options.database === "sqlite") {
    envExample += `DATABASE_URL=./data/app.db
`;
  } else if (options.database === "postgres") {
    envExample += `DATABASE_URL=postgresql://user:password@localhost:5432/app
`;
  } else if (options.database === "mysql") {
    envExample += `DATABASE_URL=mysql://user:password@localhost:3306/app
`;
  }

  if (options.plugins.includes("auth")) {
    envExample += `
# Authentication
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
`;
  }

  if (options.plugins.includes("backup")) {
    envExample += `
# Backup (Litestream)
BACKUP_S3_URL=s3://my-backup-bucket/db
BACKUP_ACCESS_KEY=your-access-key
BACKUP_SECRET_KEY=your-secret-key
BACKUP_REGION=us-east-1
`;
  }

  if (options.plugins.includes("storage")) {
    envExample += `
# File Storage
STORAGE_ADAPTER=local
UPLOAD_DIR=./uploads

# Or for S3:
# STORAGE_ADAPTER=s3
# S3_BUCKET=my-bucket
# S3_REGION=us-east-1
# S3_ACCESS_KEY=your-key
# S3_SECRET_KEY=your-secret
`;
  }

  if (options.plugins.includes("email")) {
    envExample += `
# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM=noreply@yourdomain.com
`;
  }

  writeFileSync(join(projectDir, ".env.example"), envExample);
  writeFileSync(join(projectDir, ".env"), envExample.replace(/your-.*?(\n|$)/g, "your-value-here$1"));
}

function createReadme(projectDir: string, options: InitOptions) {
  const isSvelteKit = options.frontend === "sveltekit";
  
  const readme = `# ${options.projectName}

Built with DonkeyLabs framework

## Features

- **Database**: ${options.database}
- **Frontend**: ${isSvelteKit ? "SvelteKit" : "None (API only)"}
- **Plugins**: ${options.plugins.join(", ")}
- **Deployment**: ${options.deployment}

## Getting Started

\`\`\`bash
# Install dependencies
bun install

# Set up environment
cp .env.example .env
# Edit .env with your values

${options.database === "sqlite" ? "# Create data directory\nmkdir -p data" : ""}

# Run migrations
bun scripts/migrate.ts

# Start development
${isSvelteKit ? "bun run dev" : "bun --watch run src/server/index.ts"}
\`\`\`

## Project Structure

\`\`\`
src/
├── server/
│   ├── plugins/          # Business logic plugins
│   ├── routes/           # API routes
│   ├── index.ts          # Server entry
│   └── db.ts             # Database configuration
${isSvelteKit ? `├── routes/             # SvelteKit pages
├── app.html
└── app.css` : ""}
\`\`\`

## Available Plugins

${options.plugins.map(p => `- **${p}**: ${getPluginDescription(p)}`).join("\n")}

## Deployment

${options.deployment === "docker" ? `### Docker (recommended)

\`\`\`bash
docker-compose up -d
\`\`\`` : options.deployment === "pm2" ? `### PM2

\`\`\`bash
# Build first
bun run build

# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 config
pm2 save
\`\`\`` : `### Binary

\`\`\`bash
# Build
bun run build

# Run
bun run dist/index.js
\`\`\``}

## Documentation

- [DonkeyLabs Docs](https://donkeylabs.io/docs)
- [API Reference](https://donkeylabs.io/docs/api)

## License

MIT
`;

  writeFileSync(join(projectDir, "README.md"), readme);
}

function getPluginDescription(name: string): string {
  const descriptions: Record<string, string> = {
    users: "User management",
    auth: "JWT authentication",
    email: "Email sending",
    storage: "File uploads",
    backup: "Database backups with Litestream",
    cron: "Scheduled jobs",
    audit: "Audit logging",
  };
  return descriptions[name] || name;
}

function createGitignore(projectDir: string, options: InitOptions) {
  const content = `# Dependencies
node_modules/

# Environment
.env
.env.local

# Build output
dist/
build/

# Database
*.db
*.db-journal
data/

# Logs
logs/
*.log

# Uploads
uploads/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# DonkeyLabs
.@donkeylabs/
`;

  writeFileSync(join(projectDir, ".gitignore"), content);
}

function createDonkeylabsConfig(projectDir: string, options: InitOptions) {
  const config = `import { defineConfig } from "@donkeylabs/server";

export default defineConfig({
  plugins: ["./src/server/plugins/*/index.ts"],
  routes: "./src/server/routes/**/*.ts",
  outDir: ".@donkeylabs",
  ${options.frontend === "sveltekit" ? `adapter: "@donkeylabs/adapter-sveltekit",
  client: {
    output: "./src/lib/api.ts",
  },` : ""}
});
`;

  writeFileSync(join(projectDir, "donkeylabs.config.ts"), config);
}

function createTsconfig(projectDir: string, options: InitOptions) {
  const isSvelteKit = options.frontend === "sveltekit";

  if (isSvelteKit) {
    // SvelteKit projects should extend the generated tsconfig
    const tsconfig = {
      extends: "./.svelte-kit/tsconfig.json",
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        esModuleInterop: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        sourceMap: true,
        strict: true,
        moduleResolution: "bundler",
      },
      include: [
        ".@donkeylabs/server/**/*.ts",
        ".@donkeylabs/server/**/*.d.ts",
        "src/**/*.ts",
        "src/**/*.svelte",
      ],
    };
    writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  } else {
    // API-only projects use standalone tsconfig
    const tsconfig = {
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        lib: ["ES2020"],
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        noEmit: true,
        resolveJsonModule: true,
        verbatimModuleSyntax: true,
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        baseUrl: ".",
        paths: {
          "$server/*": ["src/server/*"],
        },
        types: ["bun"],
      },
      include: ["src/**/*", "tests/**/*"],
      exclude: ["node_modules"],
    };
    writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  }
}

async function initGit(projectDir: string) {
  const { exec } = await import("child_process");
  return new Promise((resolve, reject) => {
    exec("git init && git add . && git commit -m 'Initial commit'", {
      cwd: projectDir,
    }, (error: any) => {
      if (error) reject(error);
      else resolve(undefined);
    });
  });
}
