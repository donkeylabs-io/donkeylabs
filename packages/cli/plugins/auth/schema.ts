/**
 * Auth Plugin Schema
 *
 * Type definitions for auth-related tables
 */

import type { Generated } from "kysely";

export interface RefreshTokensTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: Generated<string>;
  revoked: Generated<number>; // 0 = false, 1 = true
}

export interface DB {
  refresh_tokens: RefreshTokensTable;
}
