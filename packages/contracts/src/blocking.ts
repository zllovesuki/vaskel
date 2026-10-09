import { z } from "zod";

export const BLOCK_PAGE_SIZE = 32;
export const BLOCK_RESOLVE_LIMIT = 16;

export const SetBlockSchema = z.strictObject({
  commandId: z.uuid(),
  issuedAt: z.number().int().nonnegative(),
  blocked: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
});
export type SetBlock = z.infer<typeof SetBlockSchema>;

/** The directed rule belongs to the caller; the reverse rule is never returned. */
export const BlockRuleSchema = z.strictObject({
  targetId: z.uuid(),
  conversationId: z.uuid(),
  blocked: z.boolean(),
  revision: z.number().int().nonnegative(),
});
export const BlockStatusSchema = BlockRuleSchema.extend({
  canSend: z.boolean(),
});
export type BlockStatus = z.infer<typeof BlockStatusSchema>;

export const BlockFailureSchema = z.union([
  z.strictObject({
    kind: z.enum([
      "invalid_input",
      "unauthenticated",
      "forbidden",
      "not_found",
      "command_conflict",
      "command_expired",
      "capacity",
    ]),
  }),
  z.strictObject({
    kind: z.literal("stale_revision"),
    currentRevision: z.number().int().nonnegative(),
  }),
]);
export type BlockFailure = z.infer<typeof BlockFailureSchema>;
export const BlockOutcomeSchema = z.union([
  BlockFailureSchema,
  z.strictObject({
    kind: z.literal("block_status"),
    status: BlockStatusSchema,
  }),
  z.strictObject({
    kind: z.literal("block_updated"),
    receipt: BlockRuleSchema,
    status: BlockStatusSchema,
  }),
]);
export type BlockOutcome = z.infer<typeof BlockOutcomeSchema>;
export const BlockListSchema = z.union([
  BlockFailureSchema,
  z.strictObject({
    kind: z.literal("blocks"),
    blocks: z.array(BlockStatusSchema).max(BLOCK_PAGE_SIZE),
    partial: z.boolean(),
    unavailableTargetIds: z.array(z.uuid()).max(BLOCK_PAGE_SIZE),
    nextCursor: z.uuid().nullable(),
  }),
]);
export const ResolveBlocksSchema = z.strictObject({
  targetIds: z
    .array(z.uuid())
    .min(1)
    .max(BLOCK_RESOLVE_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const BlockStatusesSchema = z.union([
  BlockFailureSchema,
  z.strictObject({
    kind: z.literal("block_statuses"),
    statuses: z.array(BlockStatusSchema).max(BLOCK_RESOLVE_LIMIT),
    partial: z.boolean(),
    unavailableTargetIds: z.array(z.uuid()).max(BLOCK_RESOLVE_LIMIT),
  }),
]);
