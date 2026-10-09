import { applicationRead } from "@/server/http/procedures";
import { expectedOutcome } from "@/server/http/orpc";
import { sampleOwnerPresence } from "@/server/presence/compose";
export const presenceProcedures = {
  presence: applicationRead.presence.handler(async ({ context, input }) =>
    expectedOutcome(
      await sampleOwnerPresence(
        context.env,
        context.principal,
        input.body,
        context.directorySession,
      ),
      "presence",
    ),
  ),
};
