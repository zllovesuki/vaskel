import {
  applicationRead,
  applicationPrimary,
  resolveOwner,
} from "@/server/http/procedures";
import { expectedOutcome, failOutcome } from "@/server/http/orpc";
import { getPrincipal } from "@/server/auth/principal";
import { actorPrincipal, knownOwner } from "@/server/directory/owners";
import { instanceInvitePolicy } from "@/server/instance/settings";
import { sendMessage } from "./message-send";
export const messageProcedures = {
  resource: applicationRead.resource
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context }) =>
      expectedOutcome(
        await context.owner.stub.directory(
          actorPrincipal(context.principal),
          await instanceInvitePolicy(context.env),
        ),
        "directory",
      ),
    ),
  send: applicationPrimary.send
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) => {
      const original = context.principal;
      return expectedOutcome(
        await sendMessage({
          env: context.env,
          waitUntil: (work) => context.executionCtx.waitUntil(work),
          target: context.owner,
          source: async (reference) =>
            (
              await knownOwner(
                context.env,
                reference.owner.kind,
                reference.owner.id,
                context.directorySession,
              )
            )?.stub ?? null,
          principal: actorPrincipal(original),
          senderLabel: original.displayName,
          command: input.body,
          refreshPrincipal: async () => {
            const fresh = await getPrincipal(context.request, context.env);
            return fresh &&
              fresh.userId === original.userId &&
              fresh.sessionId === original.sessionId
              ? actorPrincipal(fresh)
              : null;
          },
        }),
        "accepted",
      );
    }),
  socketTicket: applicationPrimary.socketTicket
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.prepareSocket(
          actorPrincipal(context.principal),
          input.body,
        ),
        "socket_ticket",
      ),
    ),
  socketRenew: applicationPrimary.socketRenew
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.renewSocket(
          actorPrincipal(context.principal),
          input.body,
        ),
        "socket_renewed",
      ),
    ),

  members: applicationRead.members
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context }) =>
      expectedOutcome(
        await context.owner.stub.members(actorPrincipal(context.principal)),
        "members",
      ),
    ),
  snapshot: applicationPrimary.snapshot
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.snapshot(
          actorPrincipal(context.principal),
          input.body,
        ),
        "snapshot",
      ),
    ),
  react: applicationPrimary.react
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.react(
          actorPrincipal(context.principal),
          input.body,
        ),
        "accepted",
      ),
    ),
  around: applicationPrimary.around
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.around(
          actorPrincipal(context.principal),
          input.body,
        ),
        "around",
      ),
    ),
  edit: applicationPrimary.edit
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.edit(
          actorPrincipal(context.principal),
          input.body,
        ),
        "accepted",
      ),
    ),
  deleteMessage: applicationPrimary.deleteMessage
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.deleteMessage(
          actorPrincipal(context.principal),
          input.body,
        ),
        "accepted",
      ),
    ),
  removeAttachment: applicationPrimary.removeAttachment
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.removeMessageAttachment(
          actorPrincipal(context.principal),
          input.body,
        ),
        "accepted",
      ),
    ),
  replay: applicationPrimary.replay
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.replay(
          actorPrincipal(context.principal),
          input.body,
        ),
        "replay",
      ),
    ),
  searchMessages: applicationPrimary.searchMessages
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.search(
          actorPrincipal(context.principal),
          input.body,
        ),
        "matches",
      ),
    ),
  updateRead: applicationPrimary.updateRead
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.updateRead(
          actorPrincipal(context.principal),
          input.body,
        ),
        "read_updated",
      ),
    ),
  originalMessage: applicationPrimary.originalMessage.handler(
    async ({ context, input }) => {
      const owner = await knownOwner(
        context.env,
        input.params.kind,
        input.params.id,
        context.directorySession,
      );
      if (!owner) return failOutcome({ kind: "source_unavailable" });
      return expectedOutcome(
        await owner.stub.originalMessage(
          actorPrincipal(context.principal),
          input.body,
        ),
        "original_message",
      );
    },
  ),
};
