import type { RequestIdVariables } from "hono/request-id";
import type { IdentityPrincipal } from "@/server/auth/principal";
import type { KnownOwner } from "@/server/directory/owners";

export type ApplicationEnvironment = {
  Bindings: Env;
  Variables: RequestIdVariables & {
    principal: IdentityPrincipal;
    directorySession: D1DatabaseSession;
    /** Set by `requireKnownOwner` on the owner path set. */
    owner: KnownOwner;
  };
};
