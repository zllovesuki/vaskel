import { z } from "zod";

/** Account IDs, never endpoint/participant IDs or provider session identifiers. */
export const OccupancySchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  participantIds: z.array(z.string().min(1).max(128)).max(16),
  startedAt: z.number().int().nonnegative().nullable(),
  sharingUserIds: z.array(z.string().min(1).max(128)).max(16),
});
export type Occupancy = z.infer<typeof OccupancySchema>;
