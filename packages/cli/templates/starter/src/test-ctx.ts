/// <reference path="../.@donkeylabs/server/registry.d.ts" />
// Test that ctx.plugins.stats is typed correctly
import type { ServerContext, InferService } from "@donkeylabs/server";
import { statsPlugin } from "./plugins/stats";
import type { StatsService } from "./plugins/stats";

// Verify InferService works correctly
type InferredService = InferService<typeof statsPlugin>;

// This type assertion verifies that InferredService equals StatsService
const _typeCheck: InferredService extends StatsService
  ? StatsService extends InferredService
    ? true
    : false
  : false = true;

// Verify ctx.plugins.stats is typed as StatsService
declare const ctx: ServerContext;
const stats: StatsService = ctx.plugins.stats;  // Should compile without error

// These methods should all work
stats.recordRequest("test", 100);
stats.getStats();
stats.reset();
