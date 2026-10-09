import { z } from "zod";

/** Worker liveness only; this is not an authentication or storage readiness check. */
export const HealthResponseSchema = z.strictObject({
  status: z.literal("ok"),
  tag: z.string().nullable(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
