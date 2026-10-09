import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import {
  identityProcedures,
  authenticated,
  directorySession,
  type Ingress,
} from "@/server/http/procedures";
import { expectedOutcome, expectedIdentity } from "@/server/http/orpc";
import {
  recoverRegisteredAccount,
  registerAuthorizedAccount,
} from "@/server/auth/accounts";
import { getPrincipal } from "@/server/auth/principal";
import { directoryDatabase } from "@/server/directory/database";
import { stableId } from "@/server/directory/identifiers";
import { actorPrincipal } from "@/server/directory/owners";
import { allowApplicationRequest } from "@/server/http/access";
async function invitedServer(
  env: Env,
  token: string,
  session?: D1DatabaseSession,
) {
  const id = z.uuid().safeParse(token.split(".")[0]);
  if (!id.success) return null;
  const directory = await directoryDatabase(env, session)
    .selectFrom("resource_directory")
    .select("id")
    .where("id", "=", id.data)
    .where("kind", "=", "server")
    .where("lifecycle", "=", "ready")
    .executeTakeFirst();
  return directory
    ? { id: id.data, stub: env.SERVER_DO.getByName(id.data) }
    : null;
}

const budget = os.$context<Ingress>().middleware(async ({ context, next }) => {
  if (
    !(await allowApplicationRequest(
      context.env,
      `invite:${context.request.headers.get("CF-Connecting-IP") ?? "local"}`,
      "invite",
    ))
  )
    throw new ORPCError("CAPACITY", {
      status: 429,
      data: { kind: "capacity" },
    });
  return next();
});
const invitations = identityProcedures.use(budget).use(directorySession(true));
export const invitationProcedures = {
  inspectInvite: invitations.inspectInvite.handler(
    async ({ context, input }) => {
      const server = await invitedServer(
        context.env,
        input.body.token,
        context.directorySession,
      );
      if (!server) throw new ORPCError("NOT_FOUND", { status: 404 });
      return expectedOutcome(
        await server.stub.inspectInvite(
          input.body,
          (await getPrincipal(context.request, context.env)) ?? undefined,
        ),
        "invite_valid",
      );
    },
  ),
  registerInvite: invitations.registerInvite.handler(
    async ({
      context,
      input: {
        body: { token, registrationId, email, password, displayName },
      },
    }) => {
      const userId = await stableId(
        "invite-registration",
        token,
        registrationId,
      );
      const input = { email, password, displayName };
      const authorization = { authorizationId: registrationId, userId };
      // Receipt recovery precedes invite validity so accepted registrations survive expiry.
      let result = await recoverRegisteredAccount(
        input,
        authorization,
        context.env,
        context.identityDependencies,
      );
      if (!result) {
        const server = await invitedServer(
          context.env,
          token,
          context.directorySession,
        );
        if (!server) throw new ORPCError("NOT_FOUND", { status: 404 });
        expectedOutcome(
          await server.stub.authorizeRegistration({
            token,
            registrationId,
            userId,
          }),
          "registration_authorized",
        );
        result = await registerAuthorizedAccount(
          input,
          authorization,
          context.env,
          context.identityDependencies,
        );
      }
      return expectedIdentity(result, "registered");
    },
  ),
  joinInvite: invitations.joinInvite
    .use(authenticated)
    .handler(async ({ context, input }) => {
      const server = await invitedServer(
        context.env,
        input.body.token,
        context.directorySession,
      );
      if (!server) throw new ORPCError("NOT_FOUND", { status: 404 });
      return expectedOutcome(
        await server.stub.redeemInvite(
          actorPrincipal(context.principal),
          input.body,
        ),
        "joined",
      );
    }),
};
