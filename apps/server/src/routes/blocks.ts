import { applicationPrimary, resolveOwner } from "@/server/http/procedures";
import { expectedOutcome, failOutcome } from "@/server/http/orpc";
import {
  changeBlock,
  getBlock,
  listBlocks,
  resolveBlocks,
  validBlockTargets,
} from "@/server/directory/blocks";
import { actorPrincipal } from "@/server/directory/owners";
export const blockProcedures = {
  blocks: applicationPrimary.blocks.handler(async ({ context, input }) =>
    expectedOutcome(
      await listBlocks(
        context.env,
        context.principal,
        input.query.after,
        context.directorySession,
      ),
      "blocks",
    ),
  ),
  resolveBlocks: applicationPrimary.resolveBlocks.handler(
    async ({ context, input }) =>
      expectedOutcome(
        await resolveBlocks(
          context.env,
          context.principal,
          input.body.targetIds,
          context.directorySession,
        ),
        "block_statuses",
      ),
  ),
  blockStatus: applicationPrimary.blockStatus.handler(
    async ({ context, input }) =>
      expectedOutcome(
        await getBlock(context.env, context.principal, input.params.targetId),
        "block_status",
      ),
  ),
  updateBlock: applicationPrimary.updateBlock.handler(
    async ({ context, input }) =>
      expectedOutcome(
        await changeBlock(
          context.env,
          context.principal,
          input.params.targetId,
          input.body,
          context.directorySession,
        ),
        "block_updated",
      ),
  ),
  directStatus: applicationPrimary.directStatus
    .use(resolveOwner, (input) => ({
      kind: "conversation" as const,
      id: input.params.id,
    }))
    .handler(async ({ context }) => {
      const result = expectedOutcome(
        await context.env.CONVERSATION_DO.getByName(
          context.owner.owner.id,
        ).directStatus(actorPrincipal(context.principal)),
        "block_status",
      );
      const { status } = result;
      const valid = await validBlockTargets(context.env, context.principal, [
        status.targetId,
      ]);
      if (!valid) failOutcome({ kind: "unauthenticated" });
      return result;
    }),
};
