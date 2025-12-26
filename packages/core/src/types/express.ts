import { z } from "zod";

// User Agent Info schema
export const UserAgentInfoSchema = z.object({
  browser: z.string(),
  os: z.string(),
  device: z.string(),
  isBot: z.boolean(),
  formatted: z.string(),
});

// Security Metadata schema
export const SecurityMetadataSchema = z.object({
  clientIP: z.string(),
  userAgent: z.string(),
  requestSource: z.string(),
  userAgentInfo: UserAgentInfoSchema,
  username: z.string().optional(),
});

// Infer types from schemas
export type UserAgentInfo = z.infer<typeof UserAgentInfoSchema>;
export type SecurityMetadata = z.infer<typeof SecurityMetadataSchema>;

// Extend Express Request interface
declare global {
  namespace Express {
    interface Request {
      securityMetadata: SecurityMetadata;
      rawBody?: Buffer;
    }
  }
}

// This ensures the file is treated as a module
export {};
