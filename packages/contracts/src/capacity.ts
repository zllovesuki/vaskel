import { z } from "zod";

export const OWNER_SQL_DEFAULT_BUDGET_BYTES = 512 * 1_024 ** 2;
export const OWNER_SQL_MIN_BUDGET_BYTES = 8 * 1_024 ** 2;
export const OWNER_SQL_MAX_BUDGET_BYTES = 8 * 1_024 ** 3;

/** Definite refusal of new growth; no receipt was created for the command. */
export const StorageCapacityFailureSchema = z.strictObject({
  kind: z.literal("storage_capacity"),
});
export type StorageCapacityFailure = z.infer<
  typeof StorageCapacityFailureSchema
>;

const count = z.number().int().nonnegative();
const timestamp = count.nullable();
export const OwnerCapacitySchema = z.strictObject({
  kind: z.literal("owner_capacity"),
  sql: z.strictObject({
    // Used SQLite pages, including indexes/FTS. Excludes free pages, WAL and backups.
    usedBytes: count,
    budgetBytes: count,
    warningBytes: count,
    pauseBytes: count,
    status: z.enum(["normal", "warning", "paused"]),
  }),
  attachments: z.strictObject({
    // Admission charges can include reservations with no R2 object yet. These
    // are owner allocations, not a physical bucket-size or billing observation.
    chargedBytes: count,
    // Charged non-retired allocations, including pending/ready uploads.
    liveBytes: count,
    retiredBytes: count,
    // Held/outstanding are overlapping subsets of charged bytes, not extra bytes.
    heldBytes: count,
    outstandingBytes: count,
  }),
  sockets: z.strictObject({ tickets: count, active: count }),
  cleanup: z.strictObject({
    deletedPayloads: z.strictObject({ count, oldestEligibleAt: timestamp }),
    uploads: z.strictObject({ count, oldestCreatedAt: timestamp }),
    // Due times are the current retry schedule, not an original creation age.
    attachments: z.strictObject({ count, oldestDueAt: timestamp }),
    mediaInvalidations: z.strictObject({ count, oldestDueAt: timestamp }),
  }),
});
export type OwnerCapacity = z.infer<typeof OwnerCapacitySchema>;
export const OwnerCapacityOutcomeSchema = z.union([
  OwnerCapacitySchema,
  z.strictObject({
    kind: z.enum(["unauthenticated", "forbidden", "not_found"]),
  }),
]);
export type OwnerCapacityOutcome = z.infer<typeof OwnerCapacityOutcomeSchema>;
