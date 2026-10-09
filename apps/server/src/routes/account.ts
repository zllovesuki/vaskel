import type { IdentityPrincipal } from "@/server/auth/principal";
import { ORPCError, os } from "@orpc/server";
import { privateProcedures, type Ingress } from "@/server/http/procedures";
import { expectedIdentity } from "@/server/http/orpc";

import { accountThrottle } from "@/server/auth/ingress";
import {
  changeIdentityPassword,
  listIdentitySessions,
  revokeIdentitySession,
  updateIdentityProfile,
} from "@/server/auth/account";
const budget = os
  .$context<Ingress & { principal: IdentityPrincipal }>()
  .middleware(
    async ({ context, next }, action: "read" | "manage" | "password") => {
      if (
        !(await accountThrottle(context.env, context.principal.userId, action))
      )
        throw new ORPCError("RATE_LIMITED", { status: 429 });
      return next();
    },
  );
export const accountHandlers = {
  profile: privateProcedures.profile
    .use(budget, () => "manage" as const)
    .handler(async ({ context, input }) =>
      expectedIdentity(
        await updateIdentityProfile(
          context.principal,
          input.body.name,
          context.env,
        ),
        "profile_updated",
      ),
    ),
  changePassword: privateProcedures.changePassword
    .use(budget, () => "password" as const)
    .handler(async ({ context, input }) =>
      expectedIdentity(
        await changeIdentityPassword(
          context.principal,
          input.body,
          context.env,
        ),
        "password_changed",
      ),
    ),
  sessions: privateProcedures.sessions
    .use(budget, () => "read" as const)
    .handler(async ({ context }) =>
      expectedIdentity(
        await listIdentitySessions(context.principal, context.env),
        "sessions",
      ),
    ),
  revokeSession: privateProcedures.revokeSession
    .use(budget, () => "manage" as const)
    .handler(async ({ context, input }) =>
      expectedIdentity(
        await revokeIdentitySession(
          context.principal,
          input.body.sessionId,
          context.env,
        ),
        "session_revoked",
      ),
    ),
};
