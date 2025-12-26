import { z } from "zod";
import type { RouteRequest } from "./APIClient";
import type { ApiErrorResponse } from "../errors";

// ============================================================================
// Batch Result Types
// ============================================================================

/**
 * Result wrapper for batch() calls - each request returns success or error
 */
export type BatchResult<T> =
  | { ok: true; data: T; cached: boolean; ms: number }
  | { ok: false; error: ApiErrorResponse; ms: number };

/**
 * Type utility to extract response type from a RouteRequest
 */
export type ExtractRouteResponse<T> = T extends RouteRequest<any, infer R> ? R : never;

/**
 * Maps a tuple of RouteRequests to a tuple of BatchResults
 */
export type BatchResults<T extends readonly RouteRequest<any, any>[]> = {
  [K in keyof T]: BatchResult<ExtractRouteResponse<T[K]>>;
};

/**
 * Maps a tuple of RouteRequests to a tuple of unwrapped responses (for parallel())
 */
export type ParallelResults<T extends readonly RouteRequest<any, any>[]> = {
  [K in keyof T]: ExtractRouteResponse<T[K]>;
};

// ============================================================================
// Wire Protocol Types
// ============================================================================

/**
 * Individual request in a batch
 */
export const batchRequestItemSchema = z.object({
  id: z.string(),
  router: z.string(),
  route: z.string(),
  params: z.unknown(),
  version: z.string().optional(),
});

export type BatchRequestItem = z.infer<typeof batchRequestItemSchema>;

/**
 * Batch request payload sent to server
 */
export const batchRequestSchema = z.object({
  traceId: z.string(),
  failFast: z.boolean().default(false),
  requests: z.array(batchRequestItemSchema).max(10),
});

export type BatchRequestPayload = z.infer<typeof batchRequestSchema>;

/**
 * Individual result in a batch response
 */
export const batchResultItemSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string(),
    ok: z.literal(true),
    data: z.unknown(),
    cached: z.boolean(),
    ms: z.number(),
  }),
  z.object({
    id: z.string(),
    ok: z.literal(false),
    error: z.object({
      type: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
    ms: z.number(),
  }),
]);

export type BatchResultItem = z.infer<typeof batchResultItemSchema>;

/**
 * Batch response payload from server
 */
export const batchResponseSchema = z.object({
  traceId: z.string(),
  totalMs: z.number(),
  results: z.array(batchResultItemSchema),
});

export type BatchResponsePayload = z.infer<typeof batchResponseSchema>;

// ============================================================================
// Batch Options
// ============================================================================

export type BatchOptions = {
  /**
   * If true, abort all pending requests on first failure
   * @default false
   */
  failFast?: boolean;
};

// ============================================================================
// Constants
// ============================================================================

export const BATCH_MAX_SIZE = 10;
export const BATCH_ENDPOINT = "/api/batch";
