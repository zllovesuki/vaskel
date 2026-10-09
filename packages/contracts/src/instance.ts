import { z } from "zod";
import { OwnerCapacitySchema } from "./capacity";

export const INSTANCE_ICON_BYTE_LIMIT = 256 * 1024;
export const OPERATOR_PAGE_LIMIT = 20;
export const InvitePolicySchema = z.enum(["members", "owners"]);
export type InvitePolicy = z.infer<typeof InvitePolicySchema>;
export const PublicInstanceSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  hasIcon: z.boolean(),
});
export const UpdateInstanceSchema = z.strictObject({
  name: PublicInstanceSchema.shape.name,
  invitePolicy: InvitePolicySchema,
});
export const OperatorInstanceSchema = PublicInstanceSchema.extend({
  kind: z.literal("instance"),
  invitePolicy: InvitePolicySchema,
  tag: z.string().nullable(),
});
const failure = z.strictObject({
  kind: z.enum(["unauthenticated", "forbidden", "invalid_input", "capacity"]),
});
export const OperatorInstanceOutcomeSchema = z.union([
  OperatorInstanceSchema,
  failure,
]);
export const OwnerUsageSchema = z.strictObject({
  kind: z.literal("owner_usage"),
  sql: OwnerCapacitySchema.shape.sql,
  attachments: z.strictObject({
    chargedBytes: z.number().int().nonnegative(),
    budgetBytes: z.number().int().positive(),
  }),
});
export const OwnerUsageOutcomeSchema = z.union([
  OwnerUsageSchema,
  z.strictObject({
    kind: z.enum(["unauthenticated", "forbidden", "not_found"]),
  }),
]);
export const OperatorUsageOutcomeSchema = z.union([
  z.strictObject({
    kind: z.literal("usage"),
    owners: z
      .array(
        OwnerUsageSchema.omit({ kind: true }).extend({
          owner: z.strictObject({
            kind: z.enum(["server", "conversation"]),
            id: z.uuid(),
          }),
        }),
      )
      .max(OPERATOR_PAGE_LIMIT),
    nextAfter: z.uuid().nullable(),
    partial: z.boolean(),
  }),
  failure,
]);
export const OperatorAccountsOutcomeSchema = z.union([
  z.strictObject({
    kind: z.literal("accounts"),
    accounts: z
      .array(
        z.strictObject({
          id: z.uuid(),
          displayName: z.string(),
          verified: z.boolean(),
          createdAt: z.string(),
        }),
      )
      .max(OPERATOR_PAGE_LIMIT),
    nextAfter: z.uuid().nullable(),
    partial: z.boolean(),
  }),
  failure,
]);

export type OwnerUsageOutcome = z.infer<typeof OwnerUsageOutcomeSchema>;
