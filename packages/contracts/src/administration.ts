import { z } from "zod";
import {
  MessagingFailureSchema,
  OwnerScopeSchema,
  type MessagingFailure,
} from "./messaging";
import { ChannelSchema } from "./resources";

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative();
const position = z.number().int().nonnegative();

export const InitializeServerSchema = z.strictObject({
  serverId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  ownerId: identifier,
  firstChannelName: z.string().trim().min(1).max(100).optional(),
});
export const InitializeConversationSchema = z.strictObject({
  conversationId: z.uuid(),
  participantIds: z
    .array(identifier)
    .min(2)
    .max(8)
    .refine((ids) => new Set(ids).size === ids.length),
});
export type InitializeServer = z.infer<typeof InitializeServerSchema>;
export type InitializeConversation = z.infer<
  typeof InitializeConversationSchema
>;
export const CreateChannelSchema = z.strictObject({
  channelId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  private: z.boolean(),
  kind: z.enum(["text", "media"]).default("text"),
  expectedVersion: position.min(1),
});
export const ChangeChannelMemberSchema = z.strictObject({
  channelId: identifier,
  userId: identifier,
  allowed: z.boolean(),
  expectedVersion: position.min(1),
});
export const UpdateChannelSchema = z
  .strictObject({
    channelId: identifier,
    name: z.string().trim().min(1).max(100).optional(),
    topic: z.string().trim().max(200).nullable().optional(),
    position: z.number().int().min(0).max(1000).optional(),
    expectedVersion: position.min(1),
  })
  .refine(
    (command) =>
      command.name !== undefined ||
      command.topic !== undefined ||
      command.position !== undefined,
    "A channel update must change at least one field.",
  );
export const RenameServerSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  expectedVersion: position.min(1),
});
export const ReorderChannelsSchema = z.strictObject({
  channelIds: z
    .array(identifier)
    .min(1)
    .max(100)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Each channel must appear once.",
    ),
  expectedVersion: position.min(1),
});
export const RemoveMemberSchema = z.strictObject({
  userId: identifier,
  expectedVersion: position.min(1),
});
export const ServerSettingsSchema = z.strictObject({
  membersMayInvite: z.boolean(),
  expectedVersion: position.min(1),
});
export const SetRoleSchema = z.strictObject({
  userId: identifier,
  role: z.enum(["member", "moderator"]),
  expectedVersion: position.min(1),
});
export const TransferOwnershipSchema = z.strictObject({
  userId: identifier,
  expectedVersion: position.min(1),
});
export const CreateInviteSchema = z.strictObject({
  expiresAt: timestamp,
  maxUses: z.number().int().min(1).max(100).default(1),
});
export const InviteTokenSchema = z.strictObject({
  token: z
    .string()
    .max(200)
    .regex(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/),
});
export const InviteHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const RevokeInviteSchema = z.union([
  InviteTokenSchema,
  z.strictObject({ tokenHash: InviteHashSchema }),
]);
export const InvitesOutcomeSchema = z.union([
  MessagingFailureSchema,
  z.strictObject({
    kind: z.literal("invites"),
    invites: z
      .array(
        z.strictObject({
          tokenHash: InviteHashSchema,
          creatorId: identifier,
          createdAt: timestamp,
          expiresAt: timestamp,
          maxUses: position.min(1),
          uses: position,
          revoked: z.boolean(),
        }),
      )
      .max(100),
    nextCursor: InviteHashSchema.nullable(),
  }),
]);
export const AuthorizeRegistrationSchema = z.strictObject({
  token: InviteTokenSchema.shape.token,
  registrationId: z.uuid(),
  userId: identifier,
});

/** Owner administration exposes metadata, never private channel contents or occupancy. */
export const ServerAdministrationSchema = z.strictObject({
  kind: z.literal("administration"),
  owner: z.strictObject({ kind: z.literal("server"), id: identifier }),
  name: z.string(),
  version: position.min(1),
  membersMayInvite: z.boolean(),
  channels: z.array(ChannelSchema.omit({ occupancy: true })).max(100),
});
export const ServerAdministrationOutcomeSchema = z.union([
  MessagingFailureSchema,
  ServerAdministrationSchema,
]);
export type ServerAdministrationOutcome = z.infer<
  typeof ServerAdministrationOutcomeSchema
>;

export const AdministrationOutcomeSchema = z.union([
  MessagingFailureSchema,
  z.strictObject({
    kind: z.literal("initialized"),
    owner: OwnerScopeSchema,
    version: position.min(1),
    channelId: identifier,
  }),
  z.strictObject({
    kind: z.literal("changed"),
    version: position.min(1),
    mediaCleanup: z.enum(["pending", "complete"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("invite_created"),
    token: z.string(),
    expiresAt: timestamp,
    maxUses: position.min(1),
  }),
  z.strictObject({
    kind: z.literal("invite_valid"),
    serverId: identifier,
    name: z.string(),
    expiresAt: timestamp,
  }),
  z.strictObject({
    kind: z.literal("joined"),
    serverId: identifier,
    version: position.min(1),
  }),
  z.strictObject({
    kind: z.literal("registration_authorized"),
    authorizationId: z.uuid(),
    expiresAt: timestamp,
  }),
]);
export type AdministrationOutcome = z.infer<typeof AdministrationOutcomeSchema>;

export type InitializeOutcome =
  MessagingFailure | Extract<AdministrationOutcome, { kind: "initialized" }>;
