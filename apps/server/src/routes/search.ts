import { applicationRead, freshPrincipal } from "@/server/http/procedures";
import { expectedOutcome } from "@/server/http/orpc";
import { crossServerSearch } from "@/server/search/coordinator";
export const searchProcedures = {
  search: applicationRead.search.handler(async ({ context, input }) => {
    const result = await crossServerSearch(
      context.env,
      context.principal,
      input.body,
      context.directorySession,
    );
    // Owner assertions authorize reads; primary identity authorizes release.
    await freshPrincipal(context);
    return expectedOutcome(result, "cross_matches");
  }),
};
