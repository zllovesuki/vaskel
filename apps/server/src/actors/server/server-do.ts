import type { z } from "zod";
import type {
  AuthorizeRegistrationSchema,
  ChangeChannelMemberSchema,
  CreateChannelSchema,
  CreateInviteSchema,
  InitializeServer,
  InviteTokenSchema,
  RemoveMemberSchema,
  RenameServerSchema,
  UpdateChannelSchema,
  ReorderChannelsSchema,
  RevokeInviteSchema,
  ServerSettingsSchema,
  SetRoleSchema,
  TransferOwnershipSchema,
} from "@vaskel/contracts/administration";
import type { InvitePrincipal, Principal } from "@/server/domain/principal";
import type {
  MaterializeSearchRequest,
  SearchCandidatesRequest,
} from "@vaskel/contracts/search";
import { MessageDO } from "@/server/actors/shared/message-do";
import { reevaluateSockets } from "@/server/actors/shared/sockets";
import {
  changeChannelMember,
  createChannel,
  initializeServer,
  removeMember,
} from "./administration";
import {
  authorizeRegistration,
  createInvite,
  inspectInvite,
  redeemInvite,
  revokeInvite,
  listInvites,
} from "./invitations";
import { materializeSearch, searchCandidates } from "./search";
import {
  administration,
  renameServer,
  reorderChannels,
  updateChannel,
} from "./metadata";
import {
  updateSettings,
  setRole,
  transferOwnership,
} from "./circle-administration";

export class ServerDO extends MessageDO {
  administration(principal: Principal) {
    return administration(this.ctx.storage, this.database, principal);
  }
  async reorderChannels(
    principal: Principal,
    command: z.infer<typeof ReorderChannelsSchema>,
  ) {
    const result = await reorderChannels(
      this.ctx.storage,
      this.database,
      principal,
      command,
    );
    if (result.kind === "changed") await this.notifyDirectory();
    return result;
  }
  async updateSettings(
    principal: Principal,
    command: z.infer<typeof ServerSettingsSchema>,
  ) {
    const result = await updateSettings(
      this.ctx.storage,
      this.database,
      principal,
      command,
    );
    if (result.kind === "changed") await this.notifyDirectory();
    return result;
  }
  async setRole(principal: Principal, command: z.infer<typeof SetRoleSchema>) {
    const result = await setRole(
      this.ctx.storage,
      this.database,
      principal,
      command,
    );
    if (result.kind === "changed") await this.notifyDirectory();
    return result;
  }
  async transferOwnership(
    principal: Principal,
    command: z.infer<typeof TransferOwnershipSchema>,
  ) {
    const result = await transferOwnership(
      this.ctx.storage,
      this.database,
      principal,
      command,
    );
    if (result.kind === "changed") await this.notifyDirectory();
    return result;
  }
  listInvites(principal: Principal, after?: string) {
    return listInvites(this.ctx.storage, this.database, principal, after);
  }
  async updateChannel(
    principal: Principal,
    command: z.infer<typeof UpdateChannelSchema>,
  ) {
    const result = await updateChannel(
      this.ctx.storage,
      this.database,
      principal,
      command,
    );
    if (result.kind === "changed") await this.notifyDirectory();
    return result;
  }
  async rename(
    principal: Principal,
    command: z.infer<typeof RenameServerSchema>,
  ) {
    const result = await renameServer(
      this.ctx.storage,
      this.database,
      principal,
      command,
    );
    if (result.kind === "changed") await this.notifyDirectory();
    return result;
  }
  searchCandidates(principal: Principal, request: SearchCandidatesRequest) {
    return searchCandidates(
      this.ctx.storage,
      this.database,
      principal,
      request,
    );
  }
  materializeSearch(principal: Principal, request: MaterializeSearchRequest) {
    return materializeSearch(
      this.ctx.storage,
      this.database,
      principal,
      request,
    );
  }
  /** Factory RPC is reachable only through the trusted Worker resource lifecycle. */
  initialize(command: InitializeServer) {
    return initializeServer(this.ctx.storage, this.database, command);
  }
  async createChannel(
    principal: Principal,
    command: z.input<typeof CreateChannelSchema>,
  ) {
    const result = await createChannel(
      this.ctx.storage,
      this.database,
      principal,
      command,
      this.sqlBudgetBytes,
    );
    if (result.kind === "changed") await this.notifyDirectory();
    return result;
  }
  async setChannelMember(
    principal: Principal,
    command: z.infer<typeof ChangeChannelMemberSchema>,
  ) {
    const result = await changeChannelMember(
      this.ctx.storage,
      this.database,
      principal,
      command,
    );
    if (result.kind === "changed") {
      await Promise.all([
        reevaluateSockets(this.ctx, this.database),
        this.notifyDirectory(command.userId),
      ]);
    }
    return result;
  }
  async removeMember(
    principal: Principal,
    command: z.infer<typeof RemoveMemberSchema>,
  ) {
    const result = await removeMember(
      this.ctx.storage,
      this.database,
      principal,
      command,
    );
    if (result.kind === "changed") {
      await Promise.all([
        reevaluateSockets(this.ctx, this.database),
        this.notifyDirectory(command.userId),
      ]);
    }
    return result;
  }
  createInvite(
    principal: InvitePrincipal,
    command: z.input<typeof CreateInviteSchema>,
  ) {
    return createInvite(
      this.ctx.storage,
      this.database,
      principal,
      command,
      this.sqlBudgetBytes,
    );
  }
  inspectInvite(
    command: z.infer<typeof InviteTokenSchema>,
    principal?: Principal,
  ) {
    return inspectInvite(this.ctx.storage, this.database, command, principal);
  }
  /** Capacity reservation admits account creation, never server content. */
  authorizeRegistration(command: z.infer<typeof AuthorizeRegistrationSchema>) {
    return authorizeRegistration(
      this.ctx.storage,
      this.database,
      command,
      this.sqlBudgetBytes,
    );
  }
  async redeemInvite(
    principal: Principal,
    command: z.infer<typeof InviteTokenSchema>,
  ) {
    const result = await redeemInvite(
      this.ctx.storage,
      this.database,
      principal,
      command,
      this.sqlBudgetBytes,
    );
    return result;
  }
  revokeInvite(
    principal: Principal,
    command: z.infer<typeof RevokeInviteSchema>,
  ) {
    return revokeInvite(this.ctx.storage, this.database, principal, command);
  }
}
