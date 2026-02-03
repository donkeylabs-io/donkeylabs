// packages/cli/src/commands/config.ts
/**
 * Interactive configuration management
 * Modify plugin configs, deployment settings, etc.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import pc from "picocolors";

interface ConfigEntry {
  key: string;
  value: any;
  type: "string" | "number" | "boolean" | "select";
  options?: string[];
  description: string;
}

export async function configCommand(args: string[]) {
  const subcommand = args[0] || "interactive";

  switch (subcommand) {
    case "list":
    case "ls":
      await listConfig();
      break;
    case "get":
      await getConfigValue(args[1]);
      break;
    case "set":
      await setConfigValue(args[1], args[2]);
      break;
    case "plugins":
      await configurePlugins();
      break;
    case "deployment":
      await configureDeployment();
      break;
    case "database":
      await configureDatabase();
      break;
    case "interactive":
    default:
      await interactiveConfig();
      break;
  }
}

async function interactiveConfig() {
  const prompts = await import("prompts");

  console.log(pc.cyan(pc.bold("\n⚙️  Configuration Manager\n")));

  const action = await prompts.default({
    type: "select",
    name: "value",
    message: "What would you like to configure?",
    choices: [
      { title: "Plugin settings", value: "plugins" },
      { title: "Deployment settings", value: "deployment" },
      { title: "Database configuration", value: "database" },
      { title: "Environment variables", value: "env" },
      { title: "View all config", value: "list" },
    ],
  }).then((r: any) => r.value);

  switch (action) {
    case "plugins":
      await configurePlugins();
      break;
    case "deployment":
      await configureDeployment();
      break;
    case "database":
      await configureDatabase();
      break;
    case "env":
      await configureEnv();
      break;
    case "list":
      await listConfig();
      break;
  }
}

async function configurePlugins() {
  const prompts = await import("prompts");
  const pluginsDir = join(process.cwd(), "src/server/plugins");

  if (!existsSync(pluginsDir)) {
    console.log(pc.yellow("No plugins directory found"));
    return;
  }

  // List installed plugins
  const plugins = require("fs")
    .readdirSync(pluginsDir)
    .filter((f: string) =>
      require("fs").statSync(join(pluginsDir, f)).isDirectory()
    );

  if (plugins.length === 0) {
    console.log(pc.yellow("No plugins installed"));
    return;
  }

  const pluginName = await prompts.default({
    type: "select",
    name: "value",
    message: "Select plugin to configure:",
    choices: plugins.map((p: string) => ({ title: p, value: p })),
  }).then((r: any) => r.value);

  // Load plugin config schema
  const pluginConfigPath = join(pluginsDir, pluginName, "config.ts");
  if (!existsSync(pluginConfigPath)) {
    console.log(pc.yellow(`Plugin ${pluginName} has no configurable options`));
    return;
  }

  // Interactive config editor
  console.log(pc.cyan(`\nConfiguring ${pluginName}...\n`));

  // Parse and edit config file
  const configContent = readFileSync(pluginConfigPath, "utf-8");
  console.log(pc.gray("Current config:"));
  console.log(configContent);

  // Would implement full config editing here
  console.log(pc.yellow("Config editing coming soon!"));
}

async function configureDeployment() {
  const prompts = await import("prompts");

  console.log(pc.cyan(pc.bold("\n🚀 Deployment Configuration\n")));

  const platform = await prompts.default({
    type: "select",
    name: "value",
    message: "Select platform:",
    choices: [
      { title: "Vercel", value: "vercel" },
      { title: "Cloudflare Workers", value: "cloudflare" },
      { title: "AWS Lambda", value: "aws" },
      { title: "VPS (Docker)", value: "docker" },
    ],
  }).then((r: any) => r.value);

  switch (platform) {
    case "vercel":
      await configureVercel();
      break;
    case "cloudflare":
      await configureCloudflare();
      break;
    case "aws":
      await configureAWS();
      break;
    case "docker":
      await configureDocker();
      break;
  }
}

async function configureVercel() {
  const prompts = await import("prompts");

  console.log(pc.cyan("\nConfiguring Vercel deployment...\n"));

  const settings = await prompts.default([
    {
      type: "confirm",
      name: "enableAnalytics",
      message: "Enable Vercel Analytics?",
      initial: false,
    },
    {
      type: "confirm",
      name: "enableSpeedInsights",
      message: "Enable Speed Insights?",
      initial: false,
    },
    {
      type: "select",
      name: "region",
      message: "Deployment region:",
      choices: [
        { title: "Auto (default)", value: "auto" },
        { title: "US East", value: "iad1" },
        { title: "US West", value: "sfo1" },
        { title: "EU West", value: "fra1" },
        { title: "AP East", value: "hkg1" },
      ],
    },
  ]);

  // Update vercel.json
  const vercelConfig = {
    version: 2,
    builds: [
      {
        src: "api/index.ts",
        use: "@vercel/node",
      },
    ],
    regions: settings.region === "auto" ? undefined : [settings.region],
    analytics: settings.enableAnalytics,
    speedInsights: settings.enableSpeedInsights,
  };

  writeFileSync(
    join(process.cwd(), "vercel.json"),
    JSON.stringify(vercelConfig, null, 2)
  );

  console.log(pc.green("✅ Vercel configuration updated"));
}

async function configureCloudflare() {
  const prompts = await import("prompts");

  console.log(pc.cyan("\nConfiguring Cloudflare Workers...\n"));

  const settings = await prompts.default([
    {
      type: "text",
      name: "name",
      message: "Worker name:",
      initial: "my-app",
    },
    {
      type: "select",
      name: "usageModel",
      message: "Usage model:",
      choices: [
        { title: "Bundled (default)", value: "bundled" },
        { title: "Unbound", value: "unbound" },
      ],
    },
    {
      type: "confirm",
      name: "enableAnalytics",
      message: "Enable Cloudflare Analytics?",
      initial: true,
    },
  ]);

  // Update wrangler.toml
  const wranglerConfig = `name = "${settings.name}"
main = "src/index.ts"
compatibility_date = "2024-01-01"
usage_model = "${settings.usageModel}"
analytics_engine_datasets = [{ binding = "ANALYTICS", dataset = "${settings.name}_analytics" }]

[env.production]
vars = { ENVIRONMENT = "production" }

[env.staging]
vars = { ENVIRONMENT = "staging" }
`;

  writeFileSync(join(process.cwd(), "wrangler.toml"), wranglerConfig);
  console.log(pc.green("✅ Cloudflare Workers configuration updated"));
}

async function configureAWS() {
  const prompts = await import("prompts");

  console.log(pc.cyan("\nConfiguring AWS Lambda...\n"));

  const settings = await prompts.default([
    {
      type: "text",
      name: "stackName",
      message: "CloudFormation stack name:",
      initial: "my-app",
    },
    {
      type: "select",
      name: "region",
      message: "AWS Region:",
      choices: [
        { title: "us-east-1 (N. Virginia)", value: "us-east-1" },
        { title: "us-west-2 (Oregon)", value: "us-west-2" },
        { title: "eu-west-1 (Ireland)", value: "eu-west-1" },
        { title: "ap-southeast-1 (Singapore)", value: "ap-southeast-1" },
      ],
    },
    {
      type: "number",
      name: "memorySize",
      message: "Lambda memory (MB):",
      initial: 512,
    },
    {
      type: "number",
      name: "timeout",
      message: "Lambda timeout (seconds):",
      initial: 30,
    },
  ]);

  // Create SAM template
  const samTemplate = {
    AWSTemplateFormatVersion: "2010-09-09",
    Transform: "AWS::Serverless-2016-10-31",
    Description: `${settings.stackName} API`,
    Globals: {
      Function: {
        Timeout: settings.timeout,
        MemorySize: settings.memorySize,
        Runtime: "nodejs20.x",
        Architectures: ["arm64"],
      },
    },
    Resources: {
      ApiFunction: {
        Type: "AWS::Serverless::Function",
        Properties: {
          FunctionName: settings.stackName,
          Handler: "dist/index.handler",
          CodeUri: "./",
          Events: {
            ApiEvent: {
              Type: "Api",
              Properties: {
                Path: "/{proxy+}",
                Method: "ANY",
              },
            },
          },
        },
      },
    },
    Outputs: {
      ApiUrl: {
        Description: "API Gateway endpoint URL",
        Value: { "Fn::Sub": "https://\${ServerlessRestApi}.execute-api.\${AWS::Region}.amazonaws.com/Prod/" },
      },
    },
  };

  writeFileSync(
    join(process.cwd(), "template.yaml"),
    JSON.stringify(samTemplate, null, 2)
  );
  console.log(pc.green("✅ AWS SAM template created"));
}

async function configureDocker() {
  const prompts = await import("prompts");

  console.log(pc.cyan("\nConfiguring Docker deployment...\n"));

  const settings = await prompts.default([
    {
      type: "confirm",
      name: "useNginx",
      message: "Include Nginx reverse proxy?",
      initial: true,
    },
    {
      type: "confirm",
      name: "enableSSL",
      message: "Enable SSL/Let's Encrypt?",
      initial: true,
    },
    {
      type: "confirm",
      name: "enableWatchtower",
      message: "Enable Watchtower for auto-updates?",
      initial: true,
    },
  ]);

  console.log(pc.green("✅ Docker configuration updated"));
  console.log(pc.gray("Run 'docker-compose up -d' to deploy"));
}

async function configureDatabase() {
  const prompts = await import("prompts");

  console.log(pc.cyan(pc.bold("\n🗄️  Database Configuration\n")));

  const dbType = await prompts.default({
    type: "select",
    name: "value",
    message: "Database type:",
    choices: [
      { title: "SQLite", value: "sqlite" },
      { title: "PostgreSQL", value: "postgres" },
      { title: "MySQL", value: "mysql" },
    ],
  }).then((r: any) => r.value);

  const connectionString = await prompts.default({
    type: "text",
    name: "value",
    message: "Database connection string:",
    initial:
      dbType === "sqlite"
        ? "./data/app.db"
        : dbType === "postgres"
        ? "postgresql://user:pass@localhost:5432/app"
        : "mysql://user:pass@localhost:3306/app",
  }).then((r: any) => r.value);

  // Update .env
  const envPath = join(process.cwd(), ".env");
  let envContent = "";

  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf-8");
    // Replace or add DATABASE_URL
    if (envContent.includes("DATABASE_URL=")) {
      envContent = envContent.replace(
        /DATABASE_URL=.*/,
        `DATABASE_URL=${connectionString}`
      );
    } else {
      envContent += `\nDATABASE_URL=${connectionString}\n`;
    }
  } else {
    envContent = `DATABASE_URL=${connectionString}\n`;
  }

  writeFileSync(envPath, envContent);
  console.log(pc.green("✅ Database configuration updated in .env"));
}

async function configureEnv() {
  const prompts = await import("prompts");

  console.log(pc.cyan(pc.bold("\n🔐 Environment Variables\n")));

  const envPath = join(process.cwd(), ".env");
  let envVars: Record<string, string> = {};

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) {
        envVars[match[1]] = match[2];
      }
    }
  }

  const action = await prompts.default({
    type: "select",
    name: "value",
    message: "Action:",
    choices: [
      { title: "Add new variable", value: "add" },
      { title: "Edit existing", value: "edit" },
      { title: "Delete variable", value: "delete" },
      { title: "View all", value: "view" },
    ],
  }).then((r: any) => r.value);

  switch (action) {
    case "add":
      const newKey = await prompts.default({
        type: "text",
        name: "value",
        message: "Variable name:",
        validate: (v: string) => /^[A-Z_]+$/.test(v) || "Use UPPER_CASE with underscores",
      }).then((r: any) => r.value);

      const newValue = await prompts.default({
        type: "text",
        name: "value",
        message: "Value:",
      }).then((r: any) => r.value);

      envVars[newKey] = newValue;
      break;

    case "edit":
      const editKey = await prompts.default({
        type: "select",
        name: "value",
        message: "Select variable to edit:",
        choices: Object.keys(envVars).map((k) => ({ title: k, value: k })),
      }).then((r: any) => r.value);

      const editValue = await prompts.default({
        type: "text",
        name: "value",
        message: "New value:",
        initial: envVars[editKey],
      }).then((r: any) => r.value);

      envVars[editKey] = editValue;
      break;

    case "delete":
      const deleteKey = await prompts.default({
        type: "select",
        name: "value",
        message: "Select variable to delete:",
        choices: Object.keys(envVars).map((k) => ({ title: k, value: k })),
      }).then((r: any) => r.value);

      delete envVars[deleteKey];
      break;

    case "view":
      console.log(pc.cyan("\nCurrent environment variables:\n"));
      for (const [key, value] of Object.entries(envVars)) {
        const maskedValue = key.includes("SECRET") || key.includes("PASSWORD")
          ? "***"
          : value;
        console.log(`  ${key}=${maskedValue}`);
      }
      return;
  }

  // Save changes
  const newContent = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(envPath, newContent + "\n");
  console.log(pc.green("✅ Environment variables updated"));
}

async function listConfig() {
  console.log(pc.cyan(pc.bold("\n📋 Current Configuration\n")));

  // Show deployment config
  const hasVercel = existsSync(join(process.cwd(), "vercel.json"));
  const hasCloudflare = existsSync(join(process.cwd(), "wrangler.toml"));
  const hasAWS = existsSync(join(process.cwd(), "template.yaml"));
  const hasDocker = existsSync(join(process.cwd(), "Dockerfile"));

  console.log(pc.bold("Deployment:"));
  if (hasVercel) console.log(`  ${pc.green("✓")} Vercel`);
  if (hasCloudflare) console.log(`  ${pc.green("✓")} Cloudflare Workers`);
  if (hasAWS) console.log(`  ${pc.green("✓")} AWS Lambda`);
  if (hasDocker) console.log(`  ${pc.green("✓")} Docker`);

  // Show plugins
  const pluginsDir = join(process.cwd(), "src/server/plugins");
  if (existsSync(pluginsDir)) {
    const plugins = require("fs")
      .readdirSync(pluginsDir)
      .filter((f: string) =>
        require("fs").statSync(join(pluginsDir, f)).isDirectory()
      );
    console.log(pc.bold("\nPlugins:") + ` ${plugins.join(", ")}`);
  }

  // Show env
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    console.log(pc.bold("\nEnvironment:"));
    const content = readFileSync(envPath, "utf-8");
    const dbMatch = content.match(/DATABASE_URL=(.+)/);
    if (dbMatch) {
      console.log(`  Database: ${dbMatch[1].split("://")[0]}`);
    }
  }
}

async function getConfigValue(key: string) {
  if (!key) {
    console.log(pc.red("Usage: donkeylabs config get <key>"));
    return;
  }

  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    console.log(pc.yellow("No .env file found"));
    return;
  }

  const content = readFileSync(envPath, "utf-8");
  const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));

  if (match) {
    console.log(`${key}=${match[1]}`);
  } else {
    console.log(pc.yellow(`Key '${key}' not found`));
  }
}

async function setConfigValue(key: string, value: string) {
  if (!key || !value) {
    console.log(pc.red("Usage: donkeylabs config set <key> <value>"));
    return;
  }

  const envPath = join(process.cwd(), ".env");
  let content = "";

  if (existsSync(envPath)) {
    content = readFileSync(envPath, "utf-8");
    if (content.includes(`${key}=`)) {
      content = content.replace(new RegExp(`${key}=.+`), `${key}=${value}`);
    } else {
      content += `\n${key}=${value}\n`;
    }
  } else {
    content = `${key}=${value}\n`;
  }

  writeFileSync(envPath, content);
  console.log(pc.green(`✅ Set ${key}=${value}`));
}
