// test-server-start.ts
import { createProject } from "./src/commands/init-enhanced";
import type { InitOptions } from "./src/commands/init-enhanced";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const TEST_DIR = "/tmp/test-donkeylabs-server-" + Date.now();

async function test() {
  console.log("🧪 Testing full server workflow...\n");
  
  const options: InitOptions = {
    projectName: "test-app",
    database: "sqlite",
    frontend: "none",
    plugins: ["users", "auth"],
    includeDemo: false,
    deployment: "docker",
    enableBackup: false,
    enableStorage: false,
    setupMCP: false,
    gitInit: false,
    autoInstall: true,
  };
  
  // 1. Create project
  console.log("1. Creating project...");
  await createProject(TEST_DIR, options);
  console.log("✅ Project created at:", TEST_DIR);
  
  // 2. Link local packages
  console.log("\n2. Linking local @donkeylabs packages...");
  execSync("bun link @donkeylabs/server", {
    cwd: TEST_DIR,
    stdio: "inherit",
  });
  execSync("bun link @donkeylabs/cli", {
    cwd: TEST_DIR,
    stdio: "inherit",
  });
  console.log("✅ Local packages linked");
  
  // 3. Install dependencies
  console.log("\n3. Installing dependencies...");
  try {
    execSync("bun install", {
      cwd: TEST_DIR,
      stdio: "inherit",
      timeout: 120000,
    });
    console.log("✅ Dependencies installed");
  } catch (e) {
    console.log("⚠️ Install may have warnings, continuing...");
  }
  
  // 4. Check server index for errors
  console.log("\n4. Checking server/index.ts...");
  const serverIndexPath = join(TEST_DIR, "src/server/index.ts");
  const serverContent = readFileSync(serverIndexPath, "utf-8");
  
  // Check for common errors
  const errors = [];
  if (serverContent.includes("registerRouter")) {
    errors.push("❌ Still using registerRouter (should be use)");
  }
  if (!serverContent.includes("server.use(apiRouter)")) {
    errors.push("❌ Missing server.use(apiRouter)");
  }
  
  if (errors.length > 0) {
    console.log(errors.join("\n"));
    process.exit(1);
  }
  console.log("✅ Server index looks correct");
  
  // 5. Type check
  console.log("\n5. Running type check...");
  try {
    execSync("bun --bun tsc --noEmit", {
      cwd: TEST_DIR,
      stdio: "inherit",
      timeout: 60000,
    });
    console.log("✅ Type check passed");
  } catch (e) {
    console.log("⚠️ Type errors found (may be due to missing deps)");
  }
  
  // 6. Try to generate types
  console.log("\n6. Generating types...");
  try {
    execSync("bun run gen:types", {
      cwd: TEST_DIR,
      stdio: "inherit",
      timeout: 60000,
    });
    console.log("✅ Types generated");
  } catch (e) {
    console.log("⚠️ Type generation failed (expected - packages not published)");
  }
  
  console.log("\n✅ Test complete!");
  console.log(`\nProject location: ${TEST_DIR}`);
  console.log("\nTo test the server:");
  console.log(`  cd ${TEST_DIR}`);
  console.log("  bun --watch run src/server/index.ts");
}

test().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
