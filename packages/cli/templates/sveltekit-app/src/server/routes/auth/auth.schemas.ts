import { z } from "zod";

// =============================================================================
// INPUT SCHEMAS
// =============================================================================

export const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1).optional(),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

// =============================================================================
// OUTPUT SCHEMAS
// =============================================================================

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
});

export const authResponseSchema = z.object({
  user: userSchema,
  sessionId: z.string(),
});

export const meResponseSchema = userSchema.nullable();

export const logoutResponseSchema = z.object({
  success: z.boolean(),
});

// =============================================================================
// DERIVED TYPES
// =============================================================================

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type User = z.infer<typeof userSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
