import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import pc from "picocolors";
import { loadConfig, extractRoutesFromServer, type DonkeylabsConfig, type RouteInfo } from "./generate-utils";

export async function generateClientCommand(
  _args: string[],
  options: { output?: string; adapter?: string }
): Promise<void> {
  const config = await loadConfig();

  // Resolve adapter: flag > config > default "typescript"
  const adapter = options.adapter || config.adapter || "typescript";

  // Resolve output: flag > config.client.output > "./client"
  const output = options.output || config.client?.output || "./client";

  // Extract routes from server
  const entryPath = config.entry || "./src/index.ts";
  console.log(pc.dim(`Extracting routes from ${entryPath}...`));
  const routes = await extractRoutesFromServer(entryPath);

  if (routes.length === 0) {
    console.warn(pc.yellow("No routes found - generating empty client"));
  } else {
    console.log(pc.green(`Found ${routes.length} routes`));
  }

  // Dispatch to adapter
  if (adapter === "typescript") {
    await generateTypescriptClient(routes, output);
  } else {
    await generateAdapterClient(adapter, config, routes, output);
  }
}

/**
 * Built-in TypeScript client generation using @donkeylabs/server/generator
 */
async function generateTypescriptClient(routes: RouteInfo[], output: string): Promise<void> {
  try {
    const { generateClientCode } = await import("@donkeylabs/server/generator");

    const code = generateClientCode({ routes });

    // Write single .ts file
    const outputPath = output.endsWith(".ts") ? output : join(output, "index.ts");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, code);

    console.log(pc.green(`Generated TypeScript client:`), pc.dim(outputPath));
  } catch (e: any) {
    if (e.code === "ERR_MODULE_NOT_FOUND" || e.message?.includes("Cannot find")) {
      console.error(pc.red("@donkeylabs/server not found"));
      console.error(pc.dim("Make sure @donkeylabs/server is installed"));
    } else {
      console.error(pc.red("Failed to generate TypeScript client"));
      console.error(pc.dim(e.message));
    }
    process.exit(1);
  }
}

/**
 * Adapter-based client generation (sveltekit, swift, or custom package)
 */
async function generateAdapterClient(
  adapter: string,
  config: DonkeylabsConfig,
  routes: RouteInfo[],
  output: string
): Promise<void> {
  // Resolve adapter to package path
  let adapterPackage: string;
  if (adapter === "sveltekit") {
    adapterPackage = "@donkeylabs/adapter-sveltekit";
  } else if (adapter === "swift") {
    adapterPackage = "@donkeylabs/adapter-swift";
  } else {
    // Treat as full package name (e.g., "@myorg/custom-adapter")
    adapterPackage = adapter;
  }

  const generatorPath = `${adapterPackage}/generator`;

  try {
    const adapterModule = await import(generatorPath);
    if (!adapterModule.generateClient) {
      console.error(pc.red(`Adapter ${adapterPackage} does not export generateClient`));
      process.exit(1);
    }
    await adapterModule.generateClient(config, routes, output);
    console.log(pc.green(`Generated client (${adapter}):`), pc.dim(output));
  } catch (e: any) {
    if (e.code === "ERR_MODULE_NOT_FOUND" || e.message?.includes("Cannot find")) {
      console.error(pc.red(`Adapter not found: ${adapterPackage}`));
      console.error(pc.dim(`Install it with: bun add ${adapterPackage}`));
    } else {
      console.error(pc.red(`Failed to generate client with adapter: ${adapterPackage}`));
      console.error(pc.dim(e.message));
    }
    process.exit(1);
  }
}
