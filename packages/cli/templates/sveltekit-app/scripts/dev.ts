#!/usr/bin/env bun
// Dev script that runs vite and watcher together, ensuring cleanup on exit

import { spawn, type Subprocess } from "bun";

const children: Subprocess[] = [];

function cleanup() {
  for (const child of children) {
    try {
      child.kill();
    } catch {}
  }
  process.exit(0);
}

// Handle all exit signals
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.on("exit", cleanup);

// Generate types first
console.log("\x1b[36m[dev]\x1b[0m Generating types...");
const genResult = Bun.spawnSync(["bun", "run", "gen:types"], {
  stdout: "inherit",
  stderr: "inherit",
});

if (genResult.exitCode !== 0) {
  console.error("\x1b[31m[dev]\x1b[0m Failed to generate types");
  process.exit(1);
}

// Start watcher
console.log("\x1b[36m[dev]\x1b[0m Starting file watcher...");
const watcher = spawn(["bun", "--watch", "--no-clear-screen", "scripts/watch-server.ts"], {
  stdout: "inherit",
  stderr: "inherit",
});
children.push(watcher);

// Start vite
console.log("\x1b[36m[dev]\x1b[0m Starting Vite dev server...");
const vite = spawn(["bun", "--bun", "vite", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});
children.push(vite);

// When vite exits, cleanup everything
await vite.exited;
cleanup();
