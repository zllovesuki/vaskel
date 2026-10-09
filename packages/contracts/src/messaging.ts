import { z } from "zod";
import { OwnerScopeSchema } from "./owner-scope";
export { OwnerScopeSchema } from "./owner-scope";
import { StorageCapacityFailureSchema } from "./capacity";
import {
  AttachmentDescriptorSchema,
  AttachmentIdsSchema,
  AttachmentStateFailureSchema,
} from "./attachments";

export const MESSAGE_GRAPHEME_LIMIT = 4_000;
export const MESSAGE_BYTE_LIMIT = 32 * 1_024;
export const COMMAND_RETRY_MS = 24 * 60 * 60 * 1_000;
export const DELETED_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const SOCKET_LEASE_MS = 30_000;
export const SOCKET_TICKET_MS = 15_000;

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative();
const position = z.number().int().nonnegative();
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
export const MessageBodySchema = z
  .string()
  .min(1)
  .refine(
    (body) =>
      body.trim().length > 0 &&
      new TextEncoder().encode(body).byteLength <= MESSAGE_BYTE_LIMIT &&
      Array.from(graphemes.segment(body)).length <= MESSAGE_GRAPHEME_LIMIT,
    "Message exceeds its grapheme or UTF-8 byte limit, or is blank.",
  );
export type OwnerScope = z.infer<typeof OwnerScopeSchema>;
export const QuoteReferenceSchema = z.strictObject({
  owner: OwnerScopeSchema,
  channelId: identifier,
  messageId: identifier,
});
export type QuoteReference = z.infer<typeof QuoteReferenceSchema>;
export const StreamScopeSchema = z.strictObject({ channelId: identifier });
const commandFields = {
  commandId: identifier,
  issuedAt: timestamp,
  channelId: identifier,
};
export const MessageCaptionSchema = z.union([z.literal(""), MessageBodySchema]);
export const QuoteSnapshotSchema = z.strictObject({
  source: QuoteReferenceSchema,
  authorId: identifier,
  body: MessageCaptionSchema,
  createdAt: timestamp,
  version: position.min(1),
  attachmentCount: z.number().int().min(0).max(4),
});
export type QuoteSnapshot = z.infer<typeof QuoteSnapshotSchema>;
export const SendMessageSchema = z
  .strictObject({
    ...commandFields,
    body: MessageCaptionSchema,
    attachmentIds: AttachmentIdsSchema.default([]),
    quote: QuoteReferenceSchema.optional(),
  })
  .refine(
    (command) =>
      command.body.length > 0 ||
      command.attachmentIds.length > 0 ||
      command.quote !== undefined,
    "A message needs text, a file or a quote.",
  );
export const EditMessageSchema = z.strictObject({
  ...commandFields,
  messageId: identifier,
  expectedVersion: position.min(1),
  body: MessageCaptionSchema,
});
export const DeleteMessageSchema = z.strictObject({
  ...commandFields,
  messageId: identifier,
  expectedVersion: position.min(1),
});
// Intentional, single-grapheme emoji palette; no arbitrary text reactions.
export const REACTION_EMOJIS = [
  "👍",
  "👎",
  "❤️",
  "😂",
  "🎉",
  "😮",
  "😢",
  "🔥",
  "👀",
  "✅",
  "🙏",
  "💯",
  "🚀",
  "🤔",
  "👏",
  "💪",
  "😊",
  "😎",
  "🥳",
  "💔",
  "⭐",
  "🌈",
  "☕",
  "🍕",
] as const;
export const ReactionEmojiSchema = z.enum(REACTION_EMOJIS);
export const ReactMessageSchema = z.strictObject({
  ...commandFields,
  messageId: identifier,
  emoji: ReactionEmojiSchema,
  on: z.boolean(),
});
export type ReactMessage = z.infer<typeof ReactMessageSchema>;
export const RemoveMessageAttachmentSchema = DeleteMessageSchema.extend({
  fileId: z.uuid(),
});
export type RemoveMessageAttachment = z.infer<
  typeof RemoveMessageAttachmentSchema
>;
export type SendMessage = z.input<typeof SendMessageSchema>;
export type EditMessage = z.infer<typeof EditMessageSchema>;
export type DeleteMessage = z.infer<typeof DeleteMessageSchema>;
export const ReplayCursorSchema = z.strictObject({
  owner: OwnerScopeSchema,
  channelId: identifier,
  generation: z.uuid(),
  sequence: position,
});
export type ReplayCursor = z.infer<typeof ReplayCursorSchema>;
export const SnapshotRequestSchema = z.strictObject({
  channelId: identifier,
  before: position.optional(),
  limit: z.number().int().min(1).max(40).default(40),
});
export const AroundRequestSchema = z.strictObject({
  channelId: identifier,
  sequence: position.min(1),
  limit: z.number().int().min(1).max(40).default(40),
});
export type AroundRequest = z.input<typeof AroundRequestSchema>;
export const ReplayRequestSchema = z.strictObject({
  channelId: identifier,
  cursor: ReplayCursorSchema,
  limit: z.number().int().min(1).max(100).default(100),
});
export const SearchRequestSchema = z.strictObject({
  channelId: identifier,
  query: z.string().refine((value) => Array.from(value.trim()).length <= 256),
  limit: z.number().int().min(1).max(40).default(40),
});
export const ReadRequestSchema = z.strictObject({
  channelId: identifier,
  sequence: position,
});
export const PrepareSocketSchema = z.strictObject({ channelId: identifier });
export const RenewSocketSchema = z.strictObject({
  channelId: identifier,
  connectionId: z.uuid(),
});
export type SnapshotRequest = z.input<typeof SnapshotRequestSchema>;
export type ReplayRequest = z.input<typeof ReplayRequestSchema>;
export type SearchRequest = z.input<typeof SearchRequestSchema>;
export type ReadRequest = z.infer<typeof ReadRequestSchema>;
export type PrepareSocket = z.infer<typeof PrepareSocketSchema>;
export type RenewSocket = z.infer<typeof RenewSocketSchema>;

export const MessageSchema = z
  .strictObject({
    id: identifier,
    channelId: identifier,
    authorId: identifier,
    body: z.string().nullable(),
    attachments: z.array(AttachmentDescriptorSchema).max(4),
    reactions: z
      .array(
        z.strictObject({
          emoji: ReactionEmojiSchema,
          count: position.min(1),
          mine: z.boolean(),
        }),
      )
      .max(20),
    mentions: z.array(identifier).max(20),
    quote: QuoteSnapshotSchema.optional(),
    version: position.min(1),
    createdSequence: position.min(1),
    updatedSequence: position.min(1),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: timestamp.nullable(),
  })
  .refine(
    (message) =>
      message.deletedAt === null ||
      (message.body === null &&
        message.attachments.length === 0 &&
        message.reactions.length === 0 &&
        message.mentions.length === 0 &&
        message.quote === undefined),
    "Deleted messages cannot carry a public body.",
  );
export type Message = z.infer<typeof MessageSchema>;
export const OriginalMessageRequestSchema = z.strictObject({
  channelId: identifier,
  messageId: identifier,
});
export type OriginalMessageRequest = z.infer<
  typeof OriginalMessageRequestSchema
>;
export const OriginalMessageOutcomeSchema = z.union([
  z.strictObject({
    kind: z.literal("original_message"),
    message: MessageSchema,
  }),
  z.strictObject({
    kind: z.enum([
      "source_unavailable",
      "invalid_input",
      "unauthenticated",
      "capacity",
    ]),
  }),
]);
export type OriginalMessageOutcome = z.infer<
  typeof OriginalMessageOutcomeSchema
>;
export const ReceiptSchema = z.strictObject({
  messageId: identifier,
  sequence: position.min(1),
  version: position.min(1),
});
export type Receipt = z.infer<typeof ReceiptSchema>;
export const MessageEventSchema = z.strictObject({
  sequence: position.min(1),
  operation: z.enum(["send", "edit", "delete"]),
  message: MessageSchema,
});
export type MessageEvent = z.infer<typeof MessageEventSchema>;
export const MessagingFailureSchema = z.union([
  StorageCapacityFailureSchema,
  AttachmentStateFailureSchema,
  z.strictObject({ kind: z.literal("invalid_input") }),
  z.strictObject({ kind: z.literal("unauthenticated") }),
  z.strictObject({ kind: z.literal("forbidden") }),
  z.strictObject({ kind: z.literal("dm_blocked") }),
  z.strictObject({ kind: z.literal("not_found") }),
  z.strictObject({ kind: z.literal("source_unavailable") }),
  z.strictObject({ kind: z.literal("message_unavailable") }),
  z.strictObject({ kind: z.literal("command_conflict") }),
  z.strictObject({ kind: z.literal("command_expired") }),
  z.strictObject({
    kind: z.literal("stale_version"),
    currentVersion: position.min(1),
  }),
  z.strictObject({ kind: z.literal("query_too_short"), minimum: z.literal(3) }),
  z.strictObject({
    kind: z.literal("reset_required"),
    reason: z.enum(["scope", "generation", "floor", "ahead"]),
  }),
  z.strictObject({ kind: z.literal("capacity") }),
]);
export type MessagingFailure = z.infer<typeof MessagingFailureSchema>;
export const AcceptedMessageSchema = z.strictObject({
  kind: z.literal("accepted"),
  receipt: ReceiptSchema,
});
export const SocketTicketSchema = z.strictObject({
  kind: z.literal("socket_ticket"),
  ticket: z.string(),
  expiresAt: timestamp,
  leaseExpiresAt: timestamp,
});
export const SocketRenewedSchema = z.strictObject({
  kind: z.literal("socket_renewed"),
  connectionId: z.uuid(),
  leaseExpiresAt: timestamp,
});
export const MessagingOutcomeSchema = z.union([
  MessagingFailureSchema,
  AcceptedMessageSchema,
  z.strictObject({
    kind: z.literal("snapshot"),
    messages: z.array(MessageSchema).max(40),
    cursor: ReplayCursorSchema,
    nextBefore: position.nullable(),
    readSequence: position,
  }),
  z.strictObject({
    kind: z.literal("around"),
    messages: z.array(MessageSchema).max(40),
    cursor: ReplayCursorSchema,
    nextBefore: position.nullable(),
    nextAfter: position.nullable(),
    readSequence: position,
  }),
  z.strictObject({
    kind: z.literal("replay"),
    events: z.array(MessageEventSchema).max(100),
    cursor: ReplayCursorSchema,
    highWater: position,
    hasMore: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("matches"),
    messages: z.array(MessageSchema).max(40),
  }),
  z.strictObject({ kind: z.literal("read_updated"), sequence: position }),
  SocketTicketSchema,
  SocketRenewedSchema,
  z.strictObject({ kind: z.literal("socket_unavailable") }),
]);
export type MessagingOutcome = z.infer<typeof MessagingOutcomeSchema>;
export const ServerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    connectionId: z.uuid(),
    cursor: ReplayCursorSchema,
    leaseExpiresAt: timestamp,
  }),
  z.strictObject({
    type: z.literal("committed"),
    event: MessageEventSchema,
    cursor: ReplayCursorSchema,
    // Direct advancement also requires matching scope/generation and a local
    // cursor at or above replayFloor, with previous <= local < event.sequence.
    previous: position,
    replayFloor: position,
  }),
  z.strictObject({ type: z.literal("pong") }),
  z.strictObject({
    type: z.literal("typing"),
    channelId: identifier,
    userId: identifier,
    expiresAt: timestamp,
  }),
  z.strictObject({ type: z.literal("reconcile"), cursor: ReplayCursorSchema }),
  z.strictObject({ type: z.literal("access_changed") }),
  z.strictObject({ type: z.literal("dm_policy_changed") }),
  z.strictObject({ type: z.literal("lease_expired") }),
  z.strictObject({
    type: z.literal("read_updated"),
    channelId: identifier,
    sequence: position,
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
