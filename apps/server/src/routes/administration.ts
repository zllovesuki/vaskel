import {
  applicationRead,
  applicationPrimary,
  resolveOwner,
} from "@/server/http/procedures";
import { expectedOutcome } from "@/server/http/orpc";
import { actorPrincipal } from "@/server/directory/owners";
import { instanceInvitePolicy } from "@/server/instance/settings";

const serverScope = (input: { params: { id: string } }) => ({
  kind: "server" as const,
  id: input.params.id,
});
export const administrationProcedures = {
  administration: applicationRead.administration
    .use(resolveOwner, serverScope)
    .handler(async ({ context }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).administration(actorPrincipal(context.principal)),
        "administration",
      ),
    ),
  invites: applicationRead.invites
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).listInvites(actorPrincipal(context.principal), input.query.after),
        "invites",
      ),
    ),
  createInvite: applicationPrimary.createInvite
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).createInvite(
          {
            ...actorPrincipal(context.principal),
            invitePolicy: await instanceInvitePolicy(context.env),
          },
          input.body,
        ),
        "invite_created",
      ),
    ),
  reorderChannels: applicationPrimary.reorderChannels
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).reorderChannels(actorPrincipal(context.principal), input.body),
        "changed",
      ),
    ),
  serverSettings: applicationPrimary.serverSettings
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).updateSettings(actorPrincipal(context.principal), input.body),
        "changed",
      ),
    ),
  setRole: applicationPrimary.setRole
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(context.owner.owner.id).setRole(
          actorPrincipal(context.principal),
          input.body,
        ),
        "changed",
      ),
    ),
  transferOwnership: applicationPrimary.transferOwnership
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).transferOwnership(actorPrincipal(context.principal), input.body),
        "changed",
      ),
    ),
  createChannel: applicationPrimary.createChannel
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).createChannel(actorPrincipal(context.principal), input.body),
        "changed",
      ),
    ),
  updateChannel: applicationPrimary.updateChannel
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).updateChannel(actorPrincipal(context.principal), input.body),
        "changed",
      ),
    ),
  renameServer: applicationPrimary.renameServer
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(context.owner.owner.id).rename(
          actorPrincipal(context.principal),
          input.body,
        ),
        "changed",
      ),
    ),
  channelMember: applicationPrimary.channelMember
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).setChannelMember(actorPrincipal(context.principal), input.body),
        "changed",
      ),
    ),
  removeMember: applicationPrimary.removeMember
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).removeMember(actorPrincipal(context.principal), input.body),
        "changed",
      ),
    ),
  revokeInvite: applicationPrimary.revokeInvite
    .use(resolveOwner, serverScope)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.env.SERVER_DO.getByName(
          context.owner.owner.id,
        ).revokeInvite(actorPrincipal(context.principal), input.body),
        "changed",
      ),
    ),
};
