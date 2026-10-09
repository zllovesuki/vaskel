import { z } from "zod";
import { MessagingFailureSchema, OwnerScopeSchema } from "./messaging";

export const ACTIVITY_OWNER_PAGE_SIZE = 16;
export const ACTIVITY_CHANNEL_PAGE_SIZE = 32;
export const ActivityRequestSchema = z.strictObject({
  after: z.string().min(1).max(128).optional(),
});
export type ActivityRequest = z.infer<typeof ActivityRequestSchema>;
const position = z.number().int().nonnegative();
export const ChannelActivitySchema = z.strictObject({
  channelId: z.string().min(1).max(128),
  lastCreatedSequence: position,
  readSequence: position,
  // 100 represents 99+ unread messages from other authors, excluding tombstones.
  unreadCount: z.number().int().min(0).max(100),
  mentionCount: z.number().int().min(0).max(100),
  hasUnread: z.boolean(),
});
export const OwnerActivitySchema = z.strictObject({
  owner: OwnerScopeSchema,
  generation: z.uuid(),
  channels: z.array(ChannelActivitySchema).max(ACTIVITY_CHANNEL_PAGE_SIZE),
  nextCursor: z.string().min(1).max(128).nullable(),
});
export type OwnerActivity = z.infer<typeof OwnerActivitySchema>;
export const OwnerActivityOutcomeSchema = z.union([
  MessagingFailureSchema,
  OwnerActivitySchema.extend({ kind: z.literal("owner_activity") }),
]);
export type OwnerActivityOutcome = z.infer<typeof OwnerActivityOutcomeSchema>;
export const ActivityPageSchema = z.union([
  MessagingFailureSchema,
  z.strictObject({
    kind: z.literal("activity"),
    owners: z.array(OwnerActivitySchema).max(ACTIVITY_OWNER_PAGE_SIZE),
    unavailableOwners: z.array(OwnerScopeSchema).max(ACTIVITY_OWNER_PAGE_SIZE),
    // Coverage is incomplete when an owner failed or either page has more results.
    partial: z.boolean(),
    nextCursor: z.string().min(1).max(128).nullable(),
  }),
]);
export type ActivityPage = z.infer<typeof ActivityPageSchema>;
