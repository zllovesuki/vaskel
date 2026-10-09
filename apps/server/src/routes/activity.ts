import { applicationRead, resolveOwner } from "@/server/http/procedures";
import { expectedOutcome } from "@/server/http/orpc";
import { actorPrincipal } from "@/server/directory/owners";
import { listActivity } from "@/server/directory/activity";
export const activityProcedures = {
  activity: applicationRead.activity.handler(async ({ context, input }) =>
    expectedOutcome(
      await listActivity(
        context.env,
        context.principal,
        input.query.after,
        context.directorySession,
      ),
      "activity",
    ),
  ),
  ownerActivity: applicationRead.ownerActivity
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.activity(
          actorPrincipal(context.principal),
          input.query,
        ),
        "owner_activity",
      ),
    ),
};
