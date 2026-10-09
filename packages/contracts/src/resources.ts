import { z } from "zod";
import { OccupancySchema } from "./occupancy";
import {
  MessagingFailureSchema,
  OwnerScopeSchema,
  type OwnerScope,
} from "./messaging";

export const OWNER_MEMBER_LIMIT = 500;
const identifier = z.string().min(1).max(128);
const position = z.number().int().nonnegative();

export const ChannelSchema = z.strictObject({
  occupancy: OccupancySchema.nullable(),
  id: identifier,
  name: z.string(),
  private: z.boolean(),
  kind: z.enum(["text", "media"]),
  version: position.min(1),
  topic: z.string().nullable(),
  position,
});

export const ParticipantIdsSchema = z.array(identifier).min(2).max(8);
export const MemberRoleSchema = z.enum(["owner", "moderator", "member"]);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
export const MemberSchema = z.strictObject({
  userId: identifier,
  role: MemberRoleSchema,
});
export const MembersOutcomeSchema = z.union([
  MessagingFailureSchema,
  z.strictObject({
    kind: z.literal("members"),
    owner: OwnerScopeSchema,
    version: position.min(1),
    members: z.array(MemberSchema).max(OWNER_MEMBER_LIMIT),
    channelMembers: z
      .array(
        z.strictObject({
          channelId: identifier,
          userIds: z.array(identifier).max(OWNER_MEMBER_LIMIT),
        }),
      )
      .max(100),
  }),
]);
export type MembersOutcome = z.infer<typeof MembersOutcomeSchema>;
export function validConversationParticipants(value: {
  owner: OwnerScope;
  participantIds?: string[] | undefined;
}): boolean {
  return value.owner.kind === "conversation"
    ? value.participantIds !== undefined
    : value.participantIds === undefined;
}
export function validServerInvitePolicy(value: {
  owner: OwnerScope;
  membersMayInvite?: boolean | undefined;
  canCreateInvite?: boolean | undefined;
}): boolean {
  return value.owner.kind === "server"
    ? value.membersMayInvite !== undefined &&
        value.canCreateInvite !== undefined
    : value.membersMayInvite === undefined &&
        value.canCreateInvite === undefined;
}
export const AuthorizedResourceSchema = z
  .strictObject({
    kind: z.literal("directory"),
    owner: OwnerScopeSchema,
    name: z.string(),
    version: position.min(1),
    role: MemberRoleSchema,
    canSend: z.boolean().optional(),
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
export const DirectoryOutcomeSchema = z.union([
  MessagingFailureSchema,
  AuthorizedResourceSchema,
]);
export type DirectoryOutcome = z.infer<typeof DirectoryOutcomeSchema>;
