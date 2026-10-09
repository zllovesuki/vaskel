import { z } from "zod";
import { MessagingFailureSchema, OwnerScopeSchema } from "./messaging";

export const PRESENCE_OWNER_PAGE_SIZE = 16;
export const PRESENCE_MEMBER_PAGE_SIZE = 64;
export const PRESENCE_REPAIR_MS = 60_000;
export const PRESENCE_SAMPLE_MAX_AGE_MS = 90_000;

export const PresenceSelectionSchema = z.union([
  z.strictObject({ after: z.uuid().optional() }),
  z.strictObject({
    userIds: z.array(z.uuid()).min(1).max(PRESENCE_MEMBER_PAGE_SIZE),
  }),
]);
export type PresenceSelection = z.infer<typeof PresenceSelectionSchema>;
export const PresenceScopeRequestSchema = z.union([
  PresenceSelectionSchema.options[0].extend({ owner: OwnerScopeSchema }),
  PresenceSelectionSchema.options[1].extend({ owner: OwnerScopeSchema }),
]);
export type PresenceScopeRequest = z.infer<typeof PresenceScopeRequestSchema>;
/** Owners authorize the audience; callers cannot look up arbitrary accounts. */
export const PresenceRequestSchema = z.strictObject({
  scopes: z
    .array(PresenceScopeRequestSchema)
    .min(1)
    .max(PRESENCE_OWNER_PAGE_SIZE),
});
export type PresenceRequest = z.infer<typeof PresenceRequestSchema>;

export const PresenceSampleSchema = z.discriminatedUnion("state", [
  z.strictObject({
    userId: z.uuid(),
    state: z.enum(["online", "offline"]),
    sampledAt: z.number().int().nonnegative(),
  }),
  z.strictObject({ userId: z.uuid(), state: z.literal("unknown") }),
]);
export type PresenceSample = z.infer<typeof PresenceSampleSchema>;

export const PresenceScopeResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("sampled"),
    owner: OwnerScopeSchema,
    samples: z.array(PresenceSampleSchema).max(PRESENCE_MEMBER_PAGE_SIZE),
    nextCursor: z.uuid().nullable(),
  }),
  z.strictObject({ kind: z.literal("denied"), owner: OwnerScopeSchema }),
  z.strictObject({ kind: z.literal("unavailable"), owner: OwnerScopeSchema }),
]);
export type PresenceScopeResult = z.infer<typeof PresenceScopeResultSchema>;
export const PresenceOutcomeSchema = z.union([
  MessagingFailureSchema,
  z.strictObject({
    kind: z.literal("presence"),
    scopes: z.array(PresenceScopeResultSchema).max(PRESENCE_OWNER_PAGE_SIZE),
  }),
]);
export type PresenceOutcome = z.infer<typeof PresenceOutcomeSchema>;

/** Internal owner response; candidate selection shares its authorization transaction. */
export const PresenceCandidatesOutcomeSchema = z.union([
  MessagingFailureSchema,
  z.strictObject({
    kind: z.literal("presence_candidates"),
    userIds: z.array(z.uuid()).max(PRESENCE_MEMBER_PAGE_SIZE),
    nextCursor: z.uuid().nullable(),
  }),
]);
export type PresenceCandidatesOutcome = z.infer<
  typeof PresenceCandidatesOutcomeSchema
>;
