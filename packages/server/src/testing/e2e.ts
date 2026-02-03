// packages/server/src/testing/e2e.ts
/**
 * E2E Testing Utilities for DonkeyLabs Applications
 * 
 * Simplifies Playwright integration for testing your DonkeyLabs app.
 * 
 * @example
 * ```typescript
 * // playwright.config.ts
 * import { defineE2EConfig } from "@donkeylabs/server";
 * 
 * export default defineE2EConfig({
 *   baseURL: "http://localhost:3000",
 *   serverEntry: "./src/server/index.ts",
 * });
 * ```
 * 
 * @example
 * ```typescript
 * // tests/auth.spec.ts
 * import { test, expect } from "@donkeylabs/server";
 * 
 * test("user can sign up", async ({ page, api }) => {
 *   await page.goto("/signup");
 *   await page.fill('[name="email"]', "test@example.com");
 *   await page.fill('[name="password"]', "password123");
 *   await page.click('button[type="submit"]');
 *   
 *   await expect(page).toHaveURL("/dashboard");
 * });
 * ```
 */

// Only import types - actual @playwright/test is a peer dependency
// Users should import { test, expect } from "@playwright/test" directly
type PlaywrightTestConfig = {
  testDir?: string;
  timeout?: number;
  expect?: { timeout?: number };
  fullyParallel?: boolean;
  forbidOnly?: boolean;
  retries?: number;
  workers?: number | undefined;
  reporter?: any[];
  use?: Record<string, any>;
  projects?: any[];
  webServer?: {
    command: string;
    url: string;
    reuseExistingServer?: boolean;
    timeout?: number;
  };
};

export interface E2EConfig {
  /** Base URL of your application */
  baseURL: string;
  
  /** Server entry point file */
  serverEntry?: string;
  
  /** Port for test server */
  port?: number;
  
  /** Database to use for testing (isolated per test) */
  database?: "sqlite" | "postgres" | "mysql";
  
  /** Auto-start dev server */
  autoStart?: boolean;
  
  /** Test timeout in milliseconds */
  timeout?: number;
  
  /** Browsers to test */
  browsers?: ("chromium" | "firefox" | "webkit")[];
  
  /** Mobile viewport testing */
  testMobile?: boolean;
}

export interface E2EFixtures {
  /** API client for making HTTP requests */
  api: {
    get: (route: string) => Promise<any>;
    post: (route: string, data: any) => Promise<any>;
    put: (route: string, data: any) => Promise<any>;
    delete: (route: string) => Promise<any>;
  };
  
  /** Database instance for direct queries */
  db: any;
  
  /** Helper to seed test data */
  seed: (data: { users?: any[]; [key: string]: any[] }) => Promise<void>;
  
  /** Helper to cleanup test data */
  cleanup: () => Promise<void>;
}

/**
 * Define E2E test configuration for Playwright
 */
export function defineE2EConfig(config: E2EConfig): PlaywrightTestConfig {
  const port = config.port || 3333;
  const baseURL = config.baseURL || `http://localhost:${port}`;
  
  return {
    testDir: "./e2e",
    timeout: config.timeout || 30000,
    expect: {
      timeout: 5000,
    },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [
      ["html"],
      ["list"],
    ],
    use: {
      baseURL,
      trace: "on-first-retry",
      screenshot: "only-on-failure",
      video: "on-first-retry",
    },
    projects: [
      {
        name: "chromium",
        use: { 
          browserName: "chromium",
          viewport: { width: 1280, height: 720 },
        },
      },
      ...(config.browsers?.includes("firefox") ? [{
        name: "firefox",
        use: { browserName: "firefox" as const },
      }] : []),
      ...(config.browsers?.includes("webkit") ? [{
        name: "webkit",
        use: { browserName: "webkit" as const },
      }] : []),
      ...(config.testMobile ? [
        {
          name: "Mobile Chrome",
          use: { 
            browserName: "chromium" as const,
            ...devices["Pixel 5"],
          },
        },
        {
          name: "Mobile Safari",
          use: { 
            browserName: "webkit" as const,
            ...devices["iPhone 12"],
          },
        },
      ] : []),
    ],
    webServer: config.autoStart !== false ? {
      command: config.serverEntry 
        ? `bun ${config.serverEntry}`
        : "bun run dev",
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
    } : undefined,
  };
}

// Import devices from playwright
const devices = {
  "Pixel 5": {
    userAgent: "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36",
    viewport: { width: 393, height: 727 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
  },
  "iPhone 12": {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15",
    viewport: { width: 390, height: 664 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};

/**
 * Create E2E fixtures for Playwright tests
 * Use this in your playwright.config.ts fixtures
 */
export function createE2EFixtures(baseURL: string) {
  return {
    api: async ({}, use: (api: E2EFixtures["api"]) => Promise<void>) => {
      const api: E2EFixtures["api"] = {
        async get(route: string) {
          const response = await fetch(`${baseURL}/${route}`);
          if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
          }
          return response.json();
        },
        
        async post(route: string, data: any) {
          const response = await fetch(`${baseURL}/${route}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          if (!response.ok) {
            const error = await response.text();
            throw new Error(`API Error: ${response.status} - ${error}`);
          }
          return response.json();
        },
        
        async put(route: string, data: any) {
          const response = await fetch(`${baseURL}/${route}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
          }
          return response.json();
        },
        
        async delete(route: string) {
          const response = await fetch(`${baseURL}/${route}`, {
            method: "DELETE",
          });
          if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
          }
          return response.json();
        },
      };
      
      await use(api);
    },
    
    seed: async ({}, use: (fn: E2EFixtures["seed"]) => Promise<void>) => {
      await use(async (data) => {
        // Seed data via API
        for (const [table, items] of Object.entries(data)) {
          for (const item of items) {
            await fetch(`${baseURL}/${table}.create`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(item),
            });
          }
        }
      });
    },
    
    cleanup: async ({}, use: (fn: E2EFixtures["cleanup"]) => Promise<void>) => {
      await use(async () => {
        // Cleanup test data
        await fetch(`${baseURL}/test.cleanup`, {
          method: "POST",
        });
      });
    },
  };
}

// Note: Import test and expect directly from @playwright/test in your test files:
// import { test, expect } from "@playwright/test";
