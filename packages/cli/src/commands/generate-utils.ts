import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import pc from "picocolors";

export interface DonkeylabsConfig {
  plugins: string[];
  outDir?: string;
  client?: {
    output: string;
  };
  routes?: string;
  entry?: string;
  adapter?: string;
}

export async function loadConfig(): Promise<DonkeylabsConfig> {
  const configPath = join(process.cwd(), "donkeylabs.config.ts");

  if (!existsSync(configPath)) {
    throw new Error("donkeylabs.config.ts not found. Run 'donkeylabs init' first.");
  }

  const config = await import(configPath);
  return config.default;
}

export interface RouteInfo {
  name: string;
  prefix: string;
  routeName: string;
  handler: "typed" | "raw" | string;
  inputSource?: string;
  outputSource?: string;
  /** SSE event schemas (for sse handler) */
  eventsSource?: Record<string, string>;
}

/**
 * Run the server entry file with DONKEYLABS_GENERATE=1 to get typed route metadata
 */
export async function extractRoutesFromServer(entryPath: string): Promise<RouteInfo[]> {
  const fullPath = join(process.cwd(), entryPath);

  if (!existsSync(fullPath)) {
    console.warn(pc.yellow(`Entry file not found: ${entryPath}`));
    return [];
  }

  const TIMEOUT_MS = 10000; // 10 second timeout

  return new Promise((resolve) => {
    const child = spawn("bun", [fullPath], {
      env: { ...process.env, DONKEYLABS_GENERATE: "1" },
      stdio: ["inherit", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Timeout handler
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      console.warn(pc.yellow(`Route extraction timed out after ${TIMEOUT_MS / 1000}s`));
      console.warn(pc.dim("Make sure routes are registered with server.use() before any blocking operations"));
      resolve([]);
    }, TIMEOUT_MS);

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return; // Already resolved

      if (code !== 0) {
        console.warn(pc.yellow(`Failed to extract routes from server (exit code ${code})`));
        if (stderr) console.warn(pc.dim(stderr));
        resolve([]);
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        // Convert server output to RouteInfo format
        const routes: RouteInfo[] = (result.routes || []).map((r: any) => {
          const parts = r.name.split(".");
          return {
            name: r.name,
            prefix: parts.slice(0, -1).join("."),
            routeName: parts[parts.length - 1] || r.name,
            handler: r.handler || "typed",
            // Server outputs TypeScript strings directly now
            inputSource: r.inputType,
            outputSource: r.outputType,
            // SSE event schemas
            eventsSource: r.eventsType,
          };
        });
        resolve(routes);
      } catch (e) {
        console.warn(pc.yellow("Failed to parse route data from server"));
        resolve([]);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      console.warn(pc.yellow(`Failed to run entry file: ${err.message}`));
      resolve([]);
    });
  });
}
