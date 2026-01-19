/**
 * E2E Test Helpers
 * Common utilities for end-to-end testing
 */

import { join, resolve } from "path";
import { mkdir, writeFile, rm, readFile, cp } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { spawn, type Subprocess } from "bun";

const E2E_ROOT = resolve(import.meta.dir, "..");
const PACKAGES_ROOT = resolve(E2E_ROOT, "..");

/**
 * Create a temporary test project directory
 */
export async function createTestProject(name: string): Promise<string> {
  const projectDir = join(E2E_ROOT, ".test-projects", name);
  
  if (existsSync(projectDir)) {
    await rm(projectDir, { recursive: true, force: true });
  }
  
  await mkdir(projectDir, { recursive: true });
  return projectDir;
}

/**
 * Clean up test project
 */
export async function cleanupTestProject(projectDir: string): Promise<void> {
  if (existsSync(projectDir)) {
    await rm(projectDir, { recursive: true, force: true });
  }
}

/**
 * Run a CLI command in a directory
 */
export async function runCli(
  args: string[],
  cwd: string,
  options: { timeout?: number; env?: Record<string, string> } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(PACKAGES_ROOT, "cli/scripts/cli.ts");
  
  const proc = spawn({
    cmd: ["bun", "run", cliPath, ...args],
    cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Start a server and return process handle
 */
export async function startServer(
  projectDir: string,
  entryPoint: string = "src/index.ts"
): Promise<{ proc: Subprocess; port: number; stop: () => void }> {
  const port = 3000 + Math.floor(Math.random() * 1000);
  
  const proc = spawn({
    cmd: ["bun", "run", entryPoint],
    cwd: projectDir,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  return {
    proc,
    port,
    stop: () => proc.kill(),
  };
}

/**
 * Make an API request to a running server
 */
export async function apiRequest(
  port: number,
  path: string,
  options: RequestInit = {}
): Promise<{ status: number; data: any }> {
  const url = `http://localhost:${port}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options.headers as any },
    ...options,
  });
  
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

/**
 * Copy template to test project
 */
export async function copyTemplate(
  template: "starter" | "sveltekit-app",
  projectDir: string
): Promise<void> {
  const templateDir = join(PACKAGES_ROOT, "cli/templates", template);
  await cp(templateDir, projectDir, { recursive: true });
}

/**
 * Read file from test project
 */
export async function readProjectFile(projectDir: string, path: string): Promise<string> {
  return readFile(join(projectDir, path), "utf-8");
}

/**
 * Write file to test project
 */
export async function writeProjectFile(
  projectDir: string,
  path: string,
  content: string
): Promise<void> {
  const fullPath = join(projectDir, path);
  const dir = fullPath.replace(/\/[^/]+$/, "");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  await writeFile(fullPath, content);
}

/**
 * Check if file exists in test project
 */
export function projectFileExists(projectDir: string, path: string): boolean {
  return existsSync(join(projectDir, path));
}
