/**
 * @donkeylabs/adapter-swift
 *
 * Swift adapter that generates a typed Swift Package (SPM) from @donkeylabs/server routes.
 * - Generates Codable structs/enums from Zod schemas
 * - Creates async/await networking via URLSession
 * - Supports typed, raw, stream, SSE, formData, and html handlers
 */

export { generateClient } from "./generator/index.js";
