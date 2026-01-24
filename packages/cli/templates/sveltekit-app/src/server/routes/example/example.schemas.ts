import { z } from "zod";

// =============================================================================
// GREETING SCHEMAS
// =============================================================================

export const greetInputSchema = z.object({
  name: z.string().min(1, "Name is required"),
  formal: z.boolean().optional().default(false),
});

export const greetOutputSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
});

// =============================================================================
// DERIVED TYPES
// =============================================================================

export type GreetInput = z.infer<typeof greetInputSchema>;
export type GreetOutput = z.infer<typeof greetOutputSchema>;
