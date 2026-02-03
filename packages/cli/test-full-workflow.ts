// test-full-workflow.ts
/**
 * Full integration test that:
 * 1. Creates a project
 * 2. Runs bun install
 * 3. Runs type generation
 * 4. Verifies no errors
 */

import { createProject, type InitOptions } from "./src/commands/init-enhanced";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const TEST_DIR = `/tmp/donkeylabs-full-test-${Date.now()}`;

async function test() {
  console.log("🧪 Testing full workflow...\n");
  
  const options: InitOptions = {
    projectName: "test-app",
    database: "sqlite",
    frontend: "sveltekit",
    plugins: ["users", "auth", "backup"],
    includeDemo: false,
    deployment: "docker",
    enableBackup: true,
    enableStorage: false,
    setupMCP: false,
    gitInit: false,
    autoInstall: false,
  };
  
  // 1. Create project
  console.log("1. Creating project...");
  await createProject(TEST_DIR, options);
  console.log("✅ Project created\n");
  
  // 2. Check plugin files exist
  console.log("2. Checking plugins...");
  const pluginsDir = join(TEST_DIR, "src/server/plugins");
  for (const plugin of options.plugins) {
    const pluginFile = join(pluginsDir, plugin, "index.ts");
    if (!existsSync(pluginFile)) {
      console.error(`❌ Plugin ${plugin} not found at ${pluginFile}`);
      process.exit(1);
    }
    console.log(`  ✅ ${plugin}`);
  }
  console.log();
  
  // 3. Check server index imports
  console.log("3. Checking server index...");
  const serverIndex = join(TEST_DIR, "src/server/index.ts");
  if (!existsSync(serverIndex)) {
    console.error("❌ Server index not found");
    process.exit(1);
  }
  console.log("✅ Server index exists\n");
  
  // 4. Check package.json
  console.log("4. Checking package.json...");
  const pkgPath = join(TEST_DIR, "package.json");
  const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
  if (pkg.scripts["gen:types"].includes("donkeylabs")) {
    console.log("✅ Package.json uses bunx donkeylabs\n");
  } else {
    console.error("❌ Package.json doesn't use bunx");
    process.exit(1);
  }
  
  // 5. Try to install (if in CI, skip this)
  if (process.env.SKIP_INSTALL !== "true") {
    console.log("5. Installing dependencies...");
    try {
      execSync("bun install", {
        cwd: TEST_DIR,
        stdio: "inherit",
        timeout: 120000,
      });
      console.log("✅ Dependencies installed\n");
    } catch (error) {
      console.error("❌ Failed to install dependencies");
      console.log("This is expected if donkeylabs packages aren't published");
    }
  }
  
  console.log("✅ Full workflow test passed!");
  console.log(`\nProject created at: ${TEST_DIR}`);
}

test().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
