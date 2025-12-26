import { z } from "zod";

// Re-export session types from core
export { type UserSession, type RawSession } from "@donkeylabs/core";

export const UserDataSchema = z.object({
  name: z.string(),
  refreshTokenId: z.string().optional(),
  token: z.string(),
  tokenExpiration: z.date(),
  username: z.string(),
  id: z.number(),
  permissions: z.array(z.string()),
});

export type UserData = z.infer<typeof UserDataSchema>;

export const TokenPayloadSchema = z.object({
  userId: z.number(),
  username: z.string(),
  permissions: z.array(z.string()),
});

export type TokenPayload = z.infer<typeof TokenPayloadSchema>;
