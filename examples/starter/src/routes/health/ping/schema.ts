import { z } from "zod";

export const Input = z.object({
  echo: z.string().optional(),
});

export const Output = z.object({
  status: z.literal("ok"),
  timestamp: z.string(),
  echo: z.string().optional(),
});

export type Input = z.infer<typeof Input>;
export type Output = z.infer<typeof Output>;
