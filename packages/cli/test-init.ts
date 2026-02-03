#!/usr/bin/env bun
/**
 * Quick CLI test script
 * Run this to verify the CLI generates valid projects
 */

import { mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createProject, type InitOptions } from "./src/commands/init-enhanced";
import pc from "picocolors";

const TEST_DIR = join(tmpdir(), "donkeylabs-cli-quick-test-" + Date.now());

const testConfigs: Array<{ name: string; config: InitOptions }> = [
  {
    name: "sqlite-api",
    config: {
      projectName: "sqlite-api",
      database: "sqlite",
      frontend: "none",
      plugins: ["users", "auth"],
      includeDemo: false,
      deployment: "docker",
      enableBackup: false,
      enableStorage: false,
      gitInit: false,
    },
  },
  {
    name: "sveltekit-full",
    config: {
      projectName: "sveltekit-full",
      database: "sqlite",
      frontend: "sveltekit",
      plugins: ["users", "auth", "backup", "storage"],
      includeDemo: false,
      deployment: "docker",
      enableBackup: true,
      enableStorage: true,
      gitInit: false,
    },
  },
];

console.log(pc.cyan(pc.bold("\n🧪 DonkeyLabs CLI Quick Test\n")));
console.log(`Test directory: ${TEST_DIR}\n`);

await mkdir(TEST_DIR, { recursive: true });

let passed = 0;
let failed = 0;

for (const { name, config } of testConfigs) {
  process.stdout.write(`Testing ${pc.cyan(name)}... `);
  
  try {
    const projectPath = join(TEST_DIR, name);
    
    // Generate project
    await createProject(projectPath, config);
    
    // Basic validation
    const checks = [
      { path: join(projectPath, "package.json"), name: "package.json" },
      { path: join(projectPath, "src/server/index.ts"), name: "server entry" },
      { path: join(projectPath, "src/server/db.ts"), name: "db config" },
    ];
    
    if (config.frontend === "sveltekit") {
      checks.push({ path: join(projectPath, "vite.config.ts"), name: "vite config" });
    }
    
    if (config.deployment === "docker") {
      checks.push({ path: join(projectPath, "Dockerfile"), name: "Dockerfile" });
      checks.push({ path: join(projectPath, "docker-compose.yml"), name: "docker-compose" });
    }
    
    for (const check of checks) {
      if (!existsSync(check.path)) {
        throw new Error(`Missing ${check.name}`);
      }
    }
    
    console.log(pc.green("✅ PASS"));
    passed++;
  } catch (error) {
    console.log(pc.red(`❌ FAIL: ${error.message}`));
    failed++;
  }
}

// Cleanup
await rm(TEST_DIR, { recursive: true, force: true });

console.log(pc.cyan(`\n${"=".repeat(40)}`));
console.log(pc.green(`${passed} passed`));
if (failed > 0) {
  console.log(pc.red(`${failed} failed`));
}
console.log(pc.cyan("=".repeat(40) + "\n"));

process.exit(failed > 0 ? 1 : 0);
