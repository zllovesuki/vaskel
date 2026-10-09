import type { Ingress } from "@/server/http/procedures";
import { ORPCError } from "@orpc/server";
import {
  identityProcedures,
  privateProcedures,
  operator,
} from "@/server/http/procedures";
import { expectedIdentity } from "@/server/http/orpc";
import { bootstrapOperator, getBootstrapStatus } from "@/server/auth/accounts";
import { getPrincipal } from "@/server/auth/principal";
import {
  publicProfile,
  signInIdentity,
  signOutIdentity,
} from "@/server/auth/ingress";
import {
  operatorRequestPasswordReset,
  requestIdentityEmail,
  resetIdentityPassword,
  verifyIdentityEmail,
} from "@/server/auth/tokens";
import { retryIdentityMail, type MailDependencies } from "@/server/auth/mail";
import type { SessionCreationHooks } from "@/server/auth/library";
import { logEvent } from "@/server/telemetry";
export interface IdentityDependencies
  extends MailDependencies, SessionCreationHooks {}

async function requestMail(
  context: Ingress,
  email: string,
  purpose: "reset_password" | "verify_email",
) {
  const result = expectedIdentity(
    await requestIdentityEmail(
      email,
      purpose,
      context.env,
      context.identityDependencies,
    ),
    "accepted",
  );
  context.executionCtx.waitUntil(
    retryIdentityMail(
      context.env,
      { limit: 5 },
      context.identityDependencies,
    ).catch((error) =>
      logEvent(
        "warn",
        "identity_mail_retry_failed",
        { requestId: context.requestId },
        error,
      ),
    ),
  );
  return result;
}
export const identityHandlers = {
  me: identityProcedures.me.handler(async ({ context }) => {
    const principal = await getPrincipal(context.request, context.env, {
      identityPrecondition: false,
    });
    if (!principal) throw new ORPCError("UNAUTHENTICATED", { status: 401 });
    return {
      status: "authenticated" as const,
      user: await publicProfile(principal, context.env),
    };
  }),
  bootstrapStatus: identityProcedures.bootstrapStatus.handler(
    async ({ context }) =>
      expectedIdentity(
        await getBootstrapStatus(context.env, context.identityDependencies),
        "available",
        "complete",
        "unavailable",
      ),
  ),
  bootstrap: identityProcedures.bootstrap.handler(async ({ context, input }) =>
    expectedIdentity(
      await bootstrapOperator(
        input.body,
        context.env,
        context.identityDependencies,
      ),
      "registered",
    ),
  ),
  signIn: identityProcedures.signIn.handler(async ({ context, input }) => {
    const exchange = await signInIdentity(
      context.request,
      context.env,
      input.body,
      context.identityDependencies,
    );
    for (const cookie of exchange.cookies)
      context.responseHeaders.append("Set-Cookie", cookie);
    return expectedIdentity(exchange.outcome, "authenticated");
  }),
  signOut: identityProcedures.signOut.handler(async ({ context }) => {
    const exchange = await signOutIdentity(context.request, context.env);
    for (const cookie of exchange.cookies)
      context.responseHeaders.append("Set-Cookie", cookie);
    // Best-effort cleanup of cached private bytes; it cannot recall an issued grant.
    if (exchange.outcome.status === "signed_out")
      context.responseHeaders.set("Clear-Site-Data", '"cache"');
    return expectedIdentity(exchange.outcome, "signed_out");
  }),
  requestPasswordReset: identityProcedures.requestPasswordReset.handler(
    ({ context, input }) =>
      requestMail(context, input.body.email, "reset_password"),
  ),
  resendVerification: identityProcedures.resendVerification.handler(
    ({ context, input }) =>
      requestMail(context, input.body.email, "verify_email"),
  ),
  resetPassword: identityProcedures.resetPassword.handler(
    async ({ context, input }) =>
      expectedIdentity(
        await resetIdentityPassword(
          input.body.token,
          input.body.password,
          context.env,
        ),
        "password_reset",
      ),
  ),
  verifyEmail: identityProcedures.verifyEmail.handler(
    async ({ context, input }) =>
      expectedIdentity(
        await verifyIdentityEmail(input.body.token, context.env),
        "email_verified",
      ),
  ),
  operatorPasswordReset: privateProcedures.operatorPasswordReset
    .use(operator)
    .handler(async ({ context, input }) =>
      expectedIdentity(
        await operatorRequestPasswordReset(
          context.principal,
          input.body,
          context.env,
          context.identityDependencies,
        ),
        "accepted",
      ),
    ),
};
