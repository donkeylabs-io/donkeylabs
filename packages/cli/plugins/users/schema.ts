/**
 * Users Table Schema
 *
 * Type definitions for the users table
 */

import type { Generated } from "kysely";

export interface UsersTable {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface DB {
  users: UsersTable;
}
