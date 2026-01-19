// Watch server files and regenerate types on changes
import { watch } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execAsync = promisify(exec);

const serverDir = join(import.meta.dir, "..", "src", "server");
let isGenerating = false;
let lastGenerationTime = 0;

// Files/patterns we generate - ignore changes to these
const IGNORED_PATTERNS = [
  /schema\.ts$/,           // Generated schema files
  /\.d\.ts$/,              // Type declaration files
];

// Cooldown period after generation (ms)
const COOLDOWN_MS = 2000;
const DEBOUNCE_MS = 500;

// Handle signals for clean shutdown (from parent dev.ts)
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

function shouldIgnoreFile(filename: string): boolean {
  return IGNORED_PATTERNS.some(pattern => pattern.test(filename));
}

async function regenerate() {
  // Check cooldown
  const now = Date.now();
  if (now - lastGenerationTime < COOLDOWN_MS) {
    return;
  }

  if (isGenerating) {
    return;
  }

  isGenerating = true;
  lastGenerationTime = now;
  console.log("\x1b[36m[watch]\x1b[0m Server files changed, regenerating types...");

  try {
    await execAsync("bun run gen:types");
    console.log("\x1b[32m[watch]\x1b[0m Types regenerated successfully");
  } catch (e: any) {
    console.error("\x1b[31m[watch]\x1b[0m Error regenerating types:", e.message);
  } finally {
    isGenerating = false;
    lastGenerationTime = Date.now(); // Update after generation completes
  }
}

// Debounce to avoid multiple rapid regenerations
let debounceTimer: Timer | null = null;

function debouncedRegenerate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(regenerate, DEBOUNCE_MS);
}

// Watch server directory recursively
watch(serverDir, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  if (!filename.endsWith(".ts")) return;

  // Ignore generated files
  if (shouldIgnoreFile(filename)) return;

  debouncedRegenerate();
});

console.log("\x1b[36m[watch]\x1b[0m Watching src/server/ for changes...");

// Keep process alive
await new Promise(() => {});
