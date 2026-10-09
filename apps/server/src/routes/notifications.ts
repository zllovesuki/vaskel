import { applicationRead } from "@/server/http/procedures";
import { expectedOutcome } from "@/server/http/orpc";
import { actorPrincipal } from "@/server/directory/owners";
export const notificationProcedures = {
  notifications: applicationRead.notifications.handler(async ({ context }) =>
    expectedOutcome(
      await context.env.NOTIFICATION_DO.getByName(
        context.principal.userId,
      ).status(actorPrincipal(context.principal)),
      "notification_state",
    ),
  ),
  notificationCommand: applicationRead.notificationCommand.handler(
    async ({ context, input }) =>
      expectedOutcome(
        await context.env.NOTIFICATION_DO.getByName(
          context.principal.userId,
        ).command(actorPrincipal(context.principal), input.body),
        "notification_updated",
      ),
  ),
};
