// quick-test.ts
import { createProject } from "./src/commands/init-enhanced";
import { existsSync } from "fs";
import { join } from "path";

async function test() {
  const testDir = "/tmp/test-donkeylabs-" + Date.now();
  
  console.log("Testing plugin creation...");
  
  await createProject(testDir, {
    projectName: "test-app",
    database: "sqlite",
    frontend: "none",
    plugins: ["users", "auth", "backup"],
    includeDemo: false,
    deployment: "docker",
    enableBackup: true,
    enableStorage: false,
    setupMCP: false,
    gitInit: false,
    autoInstall: false,
  });
  
  // Check if plugins were created
  const pluginsDir = join(testDir, "src/server/plugins");
  
  console.log("\nChecking plugins:");
  console.log("- users exists:", existsSync(join(pluginsDir, "users", "index.ts")));
  console.log("- auth exists:", existsSync(join(pluginsDir, "auth", "index.ts")));
  console.log("- backup exists:", existsSync(join(pluginsDir, "backup", "index.ts")));
  
  // List all files in plugins dir
  console.log("\nPlugins directory contents:");
  if (existsSync(pluginsDir)) {
    const { readdirSync } = await import("fs");
    console.log(readdirSync(pluginsDir));
  } else {
    console.log("Plugins directory doesn't exist!");
  }
}

test().catch(console.error);
