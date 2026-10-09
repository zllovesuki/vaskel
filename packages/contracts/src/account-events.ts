import { z } from "zod";
import { MessagingFailureSchema, OwnerScopeSchema } from "./messaging";

export const ACCOUNT_EVENTS_LEASE_MS = 15 * 60_000;
export const ACCOUNT_EVENTS_TICKET_MS = 15_000;
export const ACCOUNT_EVENTS_SOCKET_LIMIT = 8;
export const ACCOUNT_EVENTS_PING = '{"type":"ping"}';
export const ACCOUNT_EVENTS_PONG = '{"type":"pong"}';
const identifier = z.string().min(1).max(128);
const position = z.number().int().nonnegative();
const channelReference = {
  owner: OwnerScopeSchema,
  channelId: identifier,
  generation: z.uuid(),
  sequence: position,
};
/** Hints only. Counts and access remain authoritative at the owning HTTP endpoint. */
export const AccountEventHintSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("activity"),
    ...channelReference,
    sequence: position.min(1),
    /** The message addressed this recipient: a DM, a mention or a quote of their message. */
    direct: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("mutation"),
    ...channelReference,
    sequence: position.min(1),
  }),
  z.strictObject({ type: z.literal("read"), ...channelReference }),
  z.strictObject({ type: z.literal("directory"), owner: OwnerScopeSchema }),
  z.strictObject({
    type: z.literal("presence"),
    owner: OwnerScopeSchema,
    userId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal("occupancy"),
    owner: OwnerScopeSchema,
    channelId: identifier,
  }),
  z.strictObject({
    type: z.literal("call"),
    owner: OwnerScopeSchema,
    channelId: identifier,
  }),
  z.strictObject({ type: z.literal("dm_policy"), owner: OwnerScopeSchema }),
  /** The account's notification settings changed; clients re-read them. */
  z.strictObject({ type: z.literal("notification_settings") }),
]);
export type AccountEventHint = z.infer<typeof AccountEventHintSchema>;
export const AccountEventFrameSchema = z.discriminatedUnion("type", [
  ...AccountEventHintSchema.options,
  z.strictObject({
    type: z.literal("ready"),
    leaseExpiresAt: position,
    resync: z.literal(true),
  }),
  z.strictObject({ type: z.literal("pong") }),
  z.strictObject({ type: z.literal("revoked") }),
  z.strictObject({ type: z.literal("lease_expired") }),
]);
export type AccountEventFrame = z.infer<typeof AccountEventFrameSchema>;
export const AccountEventOutcomeSchema = z.union([
  MessagingFailureSchema,
  z.strictObject({
    kind: z.literal("event_ticket"),
    ticket: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: position,
    leaseExpiresAt: position,
  }),
]);
export type AccountEventOutcome = z.infer<typeof AccountEventOutcomeSchema>;
