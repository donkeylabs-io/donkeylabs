import { z } from "zod";

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
  employeeId: z.number(),
  employeeName: z.string(),
  username: z.string(),
  permissions: z.array(z.string()),
  // JWT standard claims (added automatically by jwt.sign)
  iat: z.number().optional(), // Issued at (Unix timestamp)
  exp: z.number().optional(), // Expiration (Unix timestamp)
});

export type TokenPayload = z.infer<typeof TokenPayloadSchema>;
