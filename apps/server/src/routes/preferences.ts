import { applicationPrimary } from "@/server/http/procedures";
import { expectedOutcome } from "@/server/http/orpc";
import { updateAccountPreferences } from "@/server/auth/preferences";
export const preferencesProcedures = {
  preferences: applicationPrimary.preferences.handler(
    async ({ context, input }) =>
      expectedOutcome(
        await updateAccountPreferences(
          context.principal,
          input.body.language,
          context.directorySession,
        ),
        "preferences_updated",
      ),
  ),
};
