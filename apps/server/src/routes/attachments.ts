import { zValidator } from "@hono/zod-validator";
import { fileGrantPath, rawRoutes } from "@vaskel/contracts/api";
import { type AttachmentOutcome } from "@vaskel/contracts/attachments";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getPrincipal } from "@/server/auth/principal";
import { actorPrincipal } from "@/server/directory/owners";
import { mintAttachmentGrant } from "@/server/files/grant";
import { uploadAttachment } from "@/server/files/upload";
import type { ApplicationEnvironment } from "@/server/http/context";
import { expectedOutcome, failOutcome } from "@/server/http/orpc";
import {
  applicationRead,
  applicationPrimary,
  resolveOwner,
  freshPrincipal,
  operator,
} from "@/server/http/procedures";

type ApplicationContext = Context<ApplicationEnvironment>;
function respond(context: ApplicationContext, outcome: AttachmentOutcome) {
  const parsed = expectedOutcome(outcome, "attachment_ready");
  context.header("Cache-Control", "private, no-store");
  return context.json(parsed);
}
function refresher(context: ApplicationContext) {
  const original = context.get("principal");
  return async () => {
    const fresh = await getPrincipal(context.req.raw, context.env);
    return fresh &&
      fresh.userId === original.userId &&
      fresh.sessionId === original.sessionId
      ? actorPrincipal(fresh)
      : null;
  };
}
/** The application router resolved the owner; every route here addresses its stub. */
export function createAttachmentRouter() {
  const app = new Hono<ApplicationEnvironment>();
  const contentPath = rawRoutes.fileUpload.path
    .slice(4)
    .replace(/\{(\w+)\}/g, ":$1");
  const file = zValidator("param", z.object({ fileId: z.uuid() }), (result) => {
    if (!result.success) failOutcome({ kind: "not_found" });
  });
  app.put(contentPath, file, async (context) =>
    respond(
      context,
      await uploadAttachment(
        context.req.raw,
        context.env.ATTACHMENTS,
        context.get("owner").stub,
        actorPrincipal(context.get("principal")),
        context.req.valid("param").fileId,
        refresher(context),
        (work) => context.executionCtx.waitUntil(work),
      ),
    ),
  );
  return app;
}

export const attachmentProcedures = {
  capacity: applicationRead.capacity
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context }) => {
      const principal = await freshPrincipal(context);
      return expectedOutcome(
        await context.owner.stub.capacity({
          ...actorPrincipal(principal),
          ...(principal.isOperator ? { isOperator: true as const } : {}),
        }),
        "owner_capacity",
      );
    }),
  reserveFile: applicationPrimary.reserveFile
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.reserveAttachment(
          actorPrincipal(context.principal),
          input.body,
        ),
        "attachment_reserved",
      ),
    ),
  fileStatus: applicationRead.fileStatus
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.attachmentStatus(
          actorPrincipal(context.principal),
          input.params.fileId,
        ),
        "attachment_status",
      ),
    ),
  cancelFile: applicationPrimary.cancelFile
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.cancelAttachment(
          actorPrincipal(context.principal),
          input.params.fileId,
        ),
        "attachment_canceled",
      ),
    ),
  /** The owner's download admission runs once here; the granted URL then serves without it. */
  fileGrant: applicationRead.fileGrant
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) => {
      const authorized = await context.owner.stub.authorizeAttachmentDownload(
        actorPrincipal(context.principal),
        input.params.fileId,
      );
      if (authorized.kind !== "attachment_download")
        return failOutcome(authorized);
      const grant = await mintAttachmentGrant(context.env, authorized.download);
      return { url: fileGrantPath(grant.token), expiresAt: grant.expiresAt };
    }),
  fileIncident: applicationPrimary.fileIncident
    .use(operator)
    .use(resolveOwner, (input) => input.params)
    .handler(async ({ context, input }) =>
      expectedOutcome(
        await context.owner.stub.setAttachmentIncident(
          { ...actorPrincipal(context.principal), isOperator: true },
          input.params.fileId,
          input.body,
        ),
        "attachment_updated",
      ),
    ),
};
