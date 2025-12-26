/**
 * API Documentation Generator Script - EXAMPLE
 *
 * This is a template script. Copy this to your project and customize:
 *
 * 1. Import your API definition:
 *    import { API } from "./your-core-package";
 *
 * 2. Set your output directory:
 *    const OUTPUT_DIR = "./static";
 *
 * 3. Run with: bun run scripts/generate.ts
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { generateApiDocs, getRouteSummary } from "../src/route-generator";

// ============================================
// CUSTOMIZE THESE FOR YOUR PROJECT
// ============================================

// Import your API definition here:
// import { API } from "your-project/core";

// For demonstration, we create a minimal example:
const API = {} as any; // Replace with your actual API import

const OUTPUT_DIR = "./docs";
const OUTPUT_FILE = join(OUTPUT_DIR, "api-docs.json");

// ============================================
// GENERATION LOGIC (no changes needed below)
// ============================================

console.log("Generating API documentation...\n");

// Generate documentation
const docs = generateApiDocs(API);
const summary = getRouteSummary(docs);

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true });

// Write to file
writeFileSync(OUTPUT_FILE, JSON.stringify(docs, null, 2));

console.log("API Documentation Generated");
console.log("============================");
console.log(`Total Routers: ${summary.totalRouters}`);
console.log(`Total Routes: ${summary.totalRoutes}`);
console.log("\nRoutes by Method:");
for (const [method, count] of Object.entries(summary.routesByMethod)) {
  console.log(`  ${method.toUpperCase()}: ${count}`);
}
console.log(`\nOutput: ${OUTPUT_FILE}`);
console.log(`Generated at: ${docs.generatedAt}`);
