// Testing utilities - separate subpath export to avoid loading Playwright at runtime
// Usage: import { createE2EFixtures } from "@donkeylabs/server/testing";

// E2E Testing - requires @playwright/test as peer dependency
export {
  createE2EFixtures,
  defineE2EConfig,
  type E2EFixtures,
  type E2EConfig,
} from "./e2e";

// Database Testing Utilities
export {
  createTestDatabase,
  resetTestDatabase,
  seedTestData,
  type TestDatabaseOptions,
} from "./database";
