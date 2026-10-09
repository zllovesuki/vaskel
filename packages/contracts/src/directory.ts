import { z } from "zod";
import { InstanceCapacityFailureSchema } from "./instance-capacity";
import {
  ChannelSchema,
  ParticipantIdsSchema,
  validConversationParticipants,
  MemberRoleSchema,
  validServerInvitePolicy,
} from "./resources";
import { MessagingFailureSchema, OwnerScopeSchema } from "./messaging";
import {
  RegisterAccountRequestSchema,
  RegisterAccountResponseSchema,
} from "./identity";

export const PublicProfileSchema = z.strictObject({
  userId: z.uuid(),
  displayName: z.string(),
});
export const ResourceSummarySchema = z
  .strictObject({
    owner: OwnerScopeSchema,
    name: z.string(),
    version: z.number().int().positive(),
    role: MemberRoleSchema,
    channels: z.array(ChannelSchema).max(100),
    participantIds: ParticipantIdsSchema.optional(),
    membersMayInvite: z.boolean().optional(),
    canCreateInvite: z.boolean().optional(),
  })
  .refine(
    validConversationParticipants,
    "Only conversations must include participantIds.",
  )
  .refine(
    validServerInvitePolicy,
    "Only servers must include membersMayInvite and canCreateInvite.",
  );
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>;
export const ResourceDirectorySchema = z.union([
  MessagingFailureSchema,
  z.strictObject({
    kind: z.literal("directory"),
    resources: z.array(ResourceSummarySchema).max(50),
    canCreateServers: z.boolean(),
    partial: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
]);
export const CreateServerRequestSchema = z.strictObject({
  commandId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  firstChannelName: z.string().trim().min(1).max(100).optional(),
});
export const CreateConversationRequestSchema = z.strictObject({
  userId: z.uuid(),
});
export const ResourceCreatedSchema = z.union([
  MessagingFailureSchema,
  InstanceCapacityFailureSchema,
  z.strictObject({
    kind: z.literal("created"),
    owner: OwnerScopeSchema,
    channelId: z.uuid(),
  }),
]);
export const InviteRegistrationSchema = RegisterAccountRequestSchema.extend({
  token: z.string().min(1).max(200),
  registrationId: z.uuid(),
});
export const InviteRegistrationResponseSchema = z.union([
  RegisterAccountResponseSchema,
  MessagingFailureSchema,
]);
export const PeopleResponseSchema = z.union([
  MessagingFailureSchema,
  z.strictObject({
    kind: z.literal("people"),
    people: z.array(PublicProfileSchema).max(40),
    partial: z.boolean(),
  }),
]);
export const ServerCreationGrantSchema = z.strictObject({
  userId: z.uuid(),
  allowed: z.boolean(),
});
export const GrantResponseSchema = z.union([
  MessagingFailureSchema,
  z.strictObject({ kind: z.literal("granted") }),
]);
