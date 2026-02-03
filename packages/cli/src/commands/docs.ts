/**
 * Docs Command
 *
 * Syncs documentation from the installed @donkeylabs/server package
 * to the user's project. This ensures users always have access to
 * the latest documentation for their installed version.
 *
 * Usage:
 *   donkeylabs docs           # Sync all docs to ./docs/donkeylabs/
 *   donkeylabs docs --list    # List available docs
 *   donkeylabs docs workflows # Sync specific doc
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join, dirname } from "path";
import pc from "picocolors";

const DEFAULT_DOCS_DIR = "docs/donkeylabs";

interface DocsCommandOptions {
  list?: boolean;
  output?: string;
}

/**
 * Find the docs directory from installed @donkeylabs/server
 */
function findDocsPath(): string | null {
  // Try common locations
  const possiblePaths = [
    // node_modules (standard install)
    join(process.cwd(), "node_modules", "@donkeylabs", "server", "docs"),
    // bun's .bun cache
    join(process.cwd(), "node_modules", ".bun", "@donkeylabs", "server", "docs"),
    // Workspace/monorepo
    join(process.cwd(), "..", "server", "docs"),
    join(process.cwd(), "..", "..", "packages", "server", "docs"),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path) && statSync(path).isDirectory()) {
      return path;
    }
  }

  // Try to resolve from require
  try {
    const serverPkgPath = require.resolve("@donkeylabs/server/package.json", {
      paths: [process.cwd()],
    });
    const serverDir = dirname(serverPkgPath);
    const docsPath = join(serverDir, "docs");
    if (existsSync(docsPath)) {
      return docsPath;
    }
  } catch {
    // Package not found
  }

  return null;
}

/**
 * Get list of available doc files
 */
function getAvailableDocs(docsPath: string): string[] {
  return readdirSync(docsPath)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}

/**
 * Sync a single doc file
 */
function syncDoc(docsPath: string, docName: string, outputDir: string): boolean {
  const sourcePath = join(docsPath, `${docName}.md`);
  if (!existsSync(sourcePath)) {
    return false;
  }

  const content = readFileSync(sourcePath, "utf-8");
  const outputPath = join(outputDir, `${docName}.md`);

  // Create output directory if needed
  mkdirSync(dirname(outputPath), { recursive: true });

  writeFileSync(outputPath, content);
  return true;
}

/**
 * Sync all docs
 */
function syncAllDocs(docsPath: string, outputDir: string): number {
  const docs = getAvailableDocs(docsPath);
  let synced = 0;

  for (const doc of docs) {
    if (syncDoc(docsPath, doc, outputDir)) {
      synced++;
    }
  }

  return synced;
}

/**
 * Get version from installed package
 */
function getInstalledVersion(): string | null {
  try {
    const pkgPath = require.resolve("@donkeylabs/server/package.json", {
      paths: [process.cwd()],
    });
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return null;
  }
}

export async function docsCommand(args: string[], options: DocsCommandOptions = {}): Promise<void> {
  const docsPath = findDocsPath();

  if (!docsPath) {
    console.error(pc.red("Error: Could not find @donkeylabs/server docs."));
    console.log(pc.dim("Make sure @donkeylabs/server is installed in your project."));
    console.log(pc.dim("\nRun: bun add @donkeylabs/server"));
    process.exit(1);
  }

  const version = getInstalledVersion();
  const availableDocs = getAvailableDocs(docsPath);

  // List mode
  if (options.list || args[0] === "--list" || args[0] === "-l") {
    console.log(pc.bold("\nAvailable Documentation"));
    console.log(pc.dim(`Version: ${version || "unknown"}\n`));

    // Group docs by category
    const categories: Record<string, string[]> = {
      "Core Services": ["logger", "cache", "events", "cron", "jobs", "external-jobs", "processes", "workflows", "sse", "rate-limiter", "errors"],
      "API": ["router", "handlers", "middleware"],
      "Server": ["lifecycle-hooks", "services", "core-services"],
      "Infrastructure": ["database", "plugins", "sveltekit-adapter", "api-client"],
      "Testing": ["testing"],
      "Other": [],
    };

    // Categorize docs
    const categorized = new Set<string>();
    for (const [category, docs] of Object.entries(categories)) {
      const matching = availableDocs.filter((d) => docs.includes(d));
      if (matching.length > 0) {
        console.log(pc.cyan(`  ${category}:`));
        for (const doc of matching) {
          console.log(`    ${pc.green("•")} ${doc}`);
          categorized.add(doc);
        }
        console.log();
      }
    }

    // Uncategorized
    const uncategorized = availableDocs.filter((d) => !categorized.has(d));
    if (uncategorized.length > 0) {
      console.log(pc.cyan("  Other:"));
      for (const doc of uncategorized) {
        console.log(`    ${pc.green("•")} ${doc}`);
      }
      console.log();
    }

    console.log(pc.dim(`\nUsage:`));
    console.log(pc.dim(`  donkeylabs docs           # Sync all docs`));
    console.log(pc.dim(`  donkeylabs docs workflows # Sync specific doc`));
    return;
  }

  const outputDir = options.output || DEFAULT_DOCS_DIR;
  const specificDoc = args[0];

  // Sync specific doc
  if (specificDoc && specificDoc !== "--list" && specificDoc !== "-l") {
    if (!availableDocs.includes(specificDoc)) {
      console.error(pc.red(`Error: Doc "${specificDoc}" not found.`));
      console.log(pc.dim(`\nAvailable docs: ${availableDocs.join(", ")}`));
      console.log(pc.dim(`\nRun: donkeylabs docs --list`));
      process.exit(1);
    }

    syncDoc(docsPath, specificDoc, outputDir);
    console.log(pc.green(`✓ Synced ${specificDoc}.md to ${outputDir}/`));
    return;
  }

  // Sync all docs
  console.log(pc.bold("\nSyncing Documentation"));
  console.log(pc.dim(`Version: ${version || "unknown"}`));
  console.log(pc.dim(`Source: ${docsPath}`));
  console.log(pc.dim(`Target: ${outputDir}/\n`));

  const synced = syncAllDocs(docsPath, outputDir);

  console.log(pc.green(`\n✓ Synced ${synced} documentation files to ${outputDir}/`));
  console.log(pc.dim(`\nTip: Add ${outputDir}/ to your .gitignore if you don't want to commit docs.`));
}
