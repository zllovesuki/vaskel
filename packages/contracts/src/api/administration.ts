import { z } from "zod";
import { capability, serverParams } from "./base";
import { outcome } from "./outcome";
import {
  AdministrationOutcomeSchema,
  ChangeChannelMemberSchema,
  CreateChannelSchema,
  CreateInviteSchema,
  InviteHashSchema,
  InvitesOutcomeSchema,
  RemoveMemberSchema,
  RenameServerSchema,
  ReorderChannelsSchema,
  RevokeInviteSchema,
  ServerAdministrationSchema,
  ServerSettingsSchema,
  SetRoleSchema,
  TransferOwnershipSchema,
  UpdateChannelSchema,
} from "../administration";
export const administrationApiContract = {
  administration: capability
    .route({
      method: "GET",
      path: "/servers/{id}/administration",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams }))
    .output(ServerAdministrationSchema),
  invites: capability
    .route({
      method: "GET",
      path: "/servers/{id}/invites",
      inputStructure: "detailed",
    })
    .input(
      z.object({
        params: serverParams,
        query: z.object({ after: InviteHashSchema.optional() }),
      }),
    )
    .output(outcome(InvitesOutcomeSchema, "invites")),
  reorderChannels: capability
    .route({
      method: "POST",
      path: "/servers/{id}/reorder-channels",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: ReorderChannelsSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
  serverSettings: capability
    .route({
      method: "POST",
      path: "/servers/{id}/settings",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: ServerSettingsSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
  setRole: capability
    .route({
      method: "POST",
      path: "/servers/{id}/set-role",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: SetRoleSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
  transferOwnership: capability
    .route({
      method: "POST",
      path: "/servers/{id}/transfer",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: TransferOwnershipSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
  createChannel: capability
    .route({
      method: "POST",
      path: "/servers/{id}/channels",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: CreateChannelSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
  updateChannel: capability
    .route({
      method: "POST",
      path: "/servers/{id}/update-channel",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: UpdateChannelSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
  renameServer: capability
    .route({
      method: "POST",
      path: "/servers/{id}/rename",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: RenameServerSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
  channelMember: capability
    .route({
      method: "POST",
      path: "/servers/{id}/channel-member",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: ChangeChannelMemberSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
  removeMember: capability
    .route({
      method: "POST",
      path: "/servers/{id}/remove-member",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: RemoveMemberSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
  createInvite: capability
    .route({
      method: "POST",
      path: "/servers/{id}/invites",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: CreateInviteSchema }))
    .output(outcome(AdministrationOutcomeSchema, "invite_created")),
  revokeInvite: capability
    .route({
      method: "POST",
      path: "/servers/{id}/revoke-invite",
      inputStructure: "detailed",
    })
    .input(z.object({ params: serverParams, body: RevokeInviteSchema }))
    .output(outcome(AdministrationOutcomeSchema, "changed")),
};
